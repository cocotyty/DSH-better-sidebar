/** Per-session sharing of the plugin's private Remote invalidation streams. */
import { useSyncExternalStore } from 'react'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SIDEBAR_EVENTS_REMOTE, type SidebarEventsFrame } from '../events-remote-info.ts'

interface SupervisedItem<T> {
  readonly value: T
  accept(): void
}

interface SupervisedStream<T> extends AsyncIterable<SupervisedItem<T>> {
  dispose(): Promise<void>
}

interface RemoteStreamOptions<T> {
  name: string
  open(signal: AbortSignal): AsyncIterable<T>
  ended(accepted: boolean): Error
}

export interface SessionEventsRemote {
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
  $stream<T>(options: RemoteStreamOptions<T>): SupervisedStream<T>
  readonly betterSidebarEvents?: {
    changes(sessionId: string, signal?: AbortSignal): AsyncIterable<SidebarEventsFrame>
  }
}

export interface SessionEventListener {
  ready(): void
  change(seq: number): void
  degraded(): void
}

let remote: SessionEventsRemote | undefined
const activeFeeds = new Set<SessionEventFeed>()

/** Mount once for every consumer; later private domains can extend the same contribution. */
export async function mountSessionEventsRemote(face: SessionEventsRemote): Promise<() => Promise<void>> {
  const dispose = await face.$mount(SIDEBAR_EVENTS_REMOTE)
  remote = face
  for (const feed of activeFeeds) feed.restart()
  return async () => {
    if (remote === face) {
      remote = undefined
      for (const feed of activeFeeds) feed.fail()
    }
    await dispose()
  }
}

class SessionEventFeed {
  private readonly listeners = new Set<SessionEventListener>()
  private stream: SupervisedStream<SidebarEventsFrame> | undefined
  private lastSeq = -1

  constructor(private readonly sessionId: string) {}

  add(listener: SessionEventListener): () => void {
    this.listeners.add(listener)
    activeFeeds.add(this)
    this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        activeFeeds.delete(this)
        this.stop()
      }
    }
  }

  restart(): void {
    this.stop()
    this.start()
  }

  fail(): void {
    this.stop()
    for (const listener of this.listeners) listener.degraded()
  }

  start(): void {
    if (this.stream !== undefined || this.listeners.size === 0 || !pageVisible()) return
    const face = remote
    if (face === undefined) {
      this.fail()
      return
    }
    try {
      const stream = face.$stream<SidebarEventsFrame>({
        name: `better sidebar events of ${this.sessionId}`,
        open: (signal) => {
          const namespace = face.betterSidebarEvents
          if (namespace === undefined) throw new Error('betterSidebarEvents Remote namespace is unavailable')
          return namespace.changes(this.sessionId, signal)
        },
        ended: () => new Error(`better sidebar events of ${this.sessionId} ended`),
      })
      this.stream = stream
      void this.pump(stream)
    } catch {
      this.fail()
    }
  }

  stop(): void {
    const stream = this.stream
    if (stream === undefined) return
    this.stream = undefined
    void stream.dispose()
  }

  private async pump(stream: SupervisedStream<SidebarEventsFrame>): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.stream !== stream) return
        if (item.value.type === 'ready') {
          item.accept()
          for (const listener of this.listeners) listener.ready()
        } else {
          if (item.value.seq <= this.lastSeq) continue
          this.lastSeq = item.value.seq
          for (const listener of this.listeners) listener.change(item.value.seq)
        }
      }
      if (this.stream === stream) this.fail()
    } catch {
      if (this.stream === stream) this.fail()
    }
  }
}

const feeds = new Map<string, SessionEventFeed>()

/** One listener per consumer group; all groups of a session share one Remote stream. */
export function retainSessionEvents(sessionId: string, listener: SessionEventListener): () => void {
  let feed = feeds.get(sessionId)
  if (feed === undefined) {
    feed = new SessionEventFeed(sessionId)
    feeds.set(sessionId, feed)
  }
  const release = feed.add(listener)
  return () => {
    release()
    if (!activeFeeds.has(feed!) && feeds.get(sessionId) === feed) feeds.delete(sessionId)
  }
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

const pageListeners = new Set<() => void>()
let pageListenerAttached = false

function attachPageListener(): void {
  if (pageListenerAttached || typeof document === 'undefined') return
  pageListenerAttached = true
  document.addEventListener('visibilitychange', () => {
    for (const listener of pageListeners) listener()
    if (!pageVisible()) for (const feed of activeFeeds) feed.stop()
    else for (const feed of activeFeeds) feed.start()
  })
}

/** React-visible page state used to gate both Remote and its polling fallback. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      attachPageListener()
      pageListeners.add(listener)
      return () => { pageListeners.delete(listener) }
    },
    pageVisible,
    () => true,
  )
}
