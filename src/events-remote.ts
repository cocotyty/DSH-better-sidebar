/** Private Remote invalidations carried by DSH's existing Remote mux. */
import { Remote, TypertRemoteService, type RemoteMethodOptions } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from './context-types.ts'
import type { SidebarEventsFrame } from './events-remote-info.ts'

/** Fold bursts without queuing their tool payloads. */
const CHANGE_DEBOUNCE_MS = 50

/** One active Client subscription. Only the latest dirty bit survives a burst. */
class ChangesFollower {
  private timer: ReturnType<typeof setTimeout> | undefined
  private frame: Extract<SidebarEventsFrame, { type: 'change' }> | undefined
  private wake: (() => void) | undefined
  private closed = false

  constructor(
    readonly sessionId: string,
    private readonly release: () => void,
  ) {}

  notify(seq: number): void {
    if (this.closed || (this.frame !== undefined && seq <= this.frame.seq)) return
    this.frame = { type: 'change', seq, ops: true }
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.wake?.()
    }, CHANGE_DEBOUNCE_MS)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.frame = undefined
    this.release()
    this.wake?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<SidebarEventsFrame> {
    try {
      yield { type: 'ready' }
      while (!this.closed && !signal.aborted) {
        const frame = this.frame
        if (frame !== undefined && this.timer === undefined) {
          this.frame = undefined
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      this.close()
    }
  }
}

/** Host owner of the `betterSidebarEvents` Remote namespace. */
export class SidebarEventsRemote extends TypertRemoteService {
  static inject = ['typert']

  private readonly followers = new Map<string, Set<ChangesFollower>>()
  private readonly offEvents: () => void

  constructor(ctx: Context) {
    super(ctx, 'betterSidebarEvents')
    initializeChangesRemote?.call(this)
    // Global dispatch includes live background Sessions entered through another scope.
    this.offEvents = ctx.on('session/event', (session, event) => {
      const sessionId = (session as { id?: unknown } | null)?.id
      if (typeof sessionId !== 'string' || !isToolEvent(event)) return
      const followers = this.followers.get(sessionId)
      if (followers === undefined) return
      for (const follower of followers) follower.notify(event.seq)
    }, { global: true })
    ctx.effect(() => () => {
      this.offEvents()
      for (const followers of this.followers.values()) {
        for (const follower of [...followers]) follower.close()
      }
      this.followers.clear()
    }, 'dsh-better-sidebar: Remote session invalidations')
  }

  /** Follow file-operation invalidations without shipping the session event bodies. */
  changes(sessionId: string, signal: AbortSignal): AsyncIterable<SidebarEventsFrame> {
    const followers = this.followers.get(sessionId) ?? new Set<ChangesFollower>()
    this.followers.set(sessionId, followers)
    const follower = new ChangesFollower(sessionId, () => {
      followers.delete(follower)
      if (followers.size === 0 && this.followers.get(sessionId) === followers) this.followers.delete(sessionId)
    })
    followers.add(follower)
    const close = (): void => { follower.close() }
    signal.addEventListener('abort', close, { once: true })
    return (async function* (): AsyncIterable<SidebarEventsFrame> {
      try {
        yield* follower.read(signal)
      } finally {
        signal.removeEventListener('abort', close)
        follower.close()
      }
    })()
  }
}

// Vitest's current Oxc transform cannot parse standard decorator syntax. Apply
// the public decorator explicitly and run its per-instance initializer ourselves.
let initializeChangesRemote: ((this: SidebarEventsRemote) => void) | undefined
const changesRemoteOptions: RemoteMethodOptions<[sessionId: string, signal: AbortSignal]> = {
  mode: 'stream',
  resources: { session: (sessionId: string) => sessionId as SessionId },
}
type ChangesMethod = (sessionId: string, signal: AbortSignal) => AsyncIterable<SidebarEventsFrame>
const decorateChanges = Remote(changesRemoteOptions as unknown as RemoteMethodOptions<unknown[]>) as unknown as (
  method: ChangesMethod,
  context: ClassMethodDecoratorContext<SidebarEventsRemote, ChangesMethod>,
) => void
decorateChanges(
  SidebarEventsRemote.prototype.changes,
  {
    kind: 'method',
    name: 'changes',
    static: false,
    private: false,
    addInitializer(initializer: (this: SidebarEventsRemote) => void) {
      initializeChangesRemote = initializer
    },
  } as unknown as ClassMethodDecoratorContext<SidebarEventsRemote, ChangesMethod>,
)

function isToolEvent(event: { type: string }): boolean {
  return event.type === 'tool/call' || event.type === 'tool/result'
    || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
}
