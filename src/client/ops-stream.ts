/**
 * The session's live FILE-OPERATION stream — the signal the editor's
 * auto-refresh rides (#855).
 *
 * The model's file tools leave their calls in the session event log — as a
 * plain `tool/call` + `tool/result` pair, or as a PTC pair
 * (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) when the call ran inside
 * `<code>` — and the plugin's own `changes.ops` route ships those rows as a
 * `seq > afterSeq` delta (see `src/index.ts`). This module folds those deltas
 * into "which file did the model just write or edit", which is the whole
 * question an open preview has to answer.
 *
 * Design constraints it exists to honour:
 *
 * - **One Remote invalidation subscription per session, not one per tab.**
 *   Visible editors share a reference-counted record. The host sends only
 *   `ready` / coalesced dirty bits; `changes.ops` remains the bounded data
 *   channel, with one in-flight HTTP catch-up and one trailing dirty run.
 * - **No timer on the healthy path.** A terminal Remote failure re-enables the
 *   old 2.5s self-scheduling cadence in the session record, not in the hooks.
 *   A primed degraded pull may still use the host's short wait form. The
 *   plugin's OWN saves leave no session event, so reloads never self-trigger.
 * - **Settled successes only.** A `write`/`edit` call fires once its result
 *   landed without an error, so a half-written file never reaches a preview
 *   and a failed call never triggers a pointless reload.
 * - **Nothing historical fires.** The first pull of a fresh stream is the
 *   BASELINE: every op the session already settled is recorded as seen and
 *   published to nobody. Only an op that settles while someone is watching
 *   can refresh anything.
 * - **Session-scoped.** Streams are keyed by session id; a touch published
 *   for one session is invisible to every other session's editors.
 *
 * The stream record outlives its visible consumers (only the subscription and
 * any degraded cadence stop): re-showing a tab resumes from the persisted `seq`
 * cursor and folds the missed delta. What it does NOT do is
 * live for the page: the record map is bounded and least-recently-joined
 * first (see {@link STREAM_CAP}). A session evicted after that many newer ones
 * re-joins as a FRESH stream, which re-baselines exactly like a page reload
 * (see {@link pullStream}) — the only state a returner can lose, and only
 * after the bound was actually reached.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { SidebarSessionEvent } from '../context-types.ts'
import { api, type SessionScope } from './api.ts'
import { extractFileOps, type FileOp } from './changes/ops.ts'
import { resolveSidebarPath } from './paths.ts'
import { retainSessionEvents, usePageVisible } from './session-events.ts'

/** Degraded-only cadence: healthy Remote invalidations have no timer. */
export const FILE_OPS_INTERVAL_MS = 2_500
/** Host page size; a full primed page requires one immediate follow-up read. */
const EVENTS_PAGE_CAP = 200

/**
 * Events kept for cross-tick `tool/call` → `tool/result` pairing: a call may
 * be delivered in one delta and settle in the next. Only the tail matters
 * (a call that old has long since settled), and the bound is what keeps a
 * long session's fold cheap.
 */
const EVENT_WINDOW = 400

/**
 * Events kept once the last member goes away. The cursor, the baseline and
 * the published touches all survive, so a returning tab resumes the delta it
 * missed — but a session's tool traffic (write payloads, read results) must
 * not be pinned for the page's lifetime just because a tab was visited.
 */
const IDLE_EVENT_WINDOW = 32

/** Touched paths remembered per session (oldest insertion evicted past this). */
const TOUCH_WINDOW = 256

/**
 * How many session records the store holds. The record already shrinks to what
 * a re-join needs once its last member goes ({@link IDLE_EVENT_WINDOW} events
 * plus the published touches), but the MAP itself was "alive for the page":
 * every session an editor tab had ever watched kept its cursor, baseline and
 * touch table forever. A session still inside this window resumes from its
 * cursor and folds the delta it missed; the oldest record that nobody is
 * watching is what a new mint evicts.
 */
const STREAM_CAP = 32

/** The op kinds that changed a file's bytes. */
export type FileOpTouchKind = 'write' | 'edit'

/** The newest settled write/edit of one path. */
export interface FileOpTouch {
  readonly kind: FileOpTouchKind
  /** The published revision this touch belongs to (compare with a baseline). */
  readonly revision: number
  /** The originating tool call's event time (epoch ms). */
  readonly time: number
}

/** What a member reads: the published state of its session's stream. */
export interface FileOpStreamState {
  /** Monotonic per-session counter, bumped once per published delta. */
  readonly revision: number
  /** Comparison key ({@link fileOpKey}) → that path's newest settled touch. */
  readonly touched: ReadonlyMap<string, FileOpTouch>
  /** Remote failed or is unavailable: the old self-scheduling poll is active. */
  readonly degraded: boolean
}

/** The state every session starts from (a stable identity: the store contract). */
const EMPTY_STATE: FileOpStreamState = { revision: 0, touched: new Map(), degraded: false }

/**
 * The comparison key of one path, so a model-spelled path and an editor tab's
 * absolute path meet: relative paths are resolved against the session cwd
 * ({@link resolveSidebarPath}), `.`/`..` segments are folded lexically, both
 * separators unify to '/', and Windows-style paths (drive letters, UNC
 * shares) fold case — the same file may be spelled either way there.
 * @param cwd - the session working directory (undefined = nothing to join onto).
 * @param path - an absolute or session-relative path.
 * @returns the comparison key (never a path to hand back to the host).
 */
export function fileOpKey(cwd: string | undefined, path: string): string {
  const unified = resolveSidebarPath(cwd, path).replace(/\\/g, '/')
  const windows = /^[A-Za-z]:\//.test(unified) || unified.startsWith('//')
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const key = `${unified.startsWith('/') ? '/' : ''}${segments.join('/')}`
  return windows ? key.toLowerCase() : key
}

/** One session's stream: shared cursor, published state and visible consumers. */
interface Stream {
  readonly sessionId: string
  state: FileOpStreamState
  listeners: Set<() => void>
  visible: number
  releaseEvents: (() => void) | undefined
  /** The delivered cursor (`-1` includes an eventual first event at seq 0). */
  seq: number
  /** Whether the baseline pull completed (only then may a delta publish). */
  primed: boolean
  events: SidebarSessionEvent[]
  /** callIds already accounted for: a settle must fire exactly once. */
  published: Set<string>
  /** The current cwd, used to resolve the model's own relative spellings. */
  cwd: string | undefined
  /** Single-flight HTTP catch-up with one trailing dirty run. */
  pullPromise: Promise<void> | undefined
  pullAbort: AbortController | undefined
  dirty: boolean
  /** One self-scheduling degraded loop per session, including its in-flight run. */
  fallbackActive: boolean
  fallbackGeneration: number
  fallbackTimer: number | undefined
}

/** Every session's stream, bounded by {@link STREAM_CAP} (see `streamOf`). */
const streams = new Map<string, Stream>()

/** The stream record of one session, created on first use. */
function streamOf(sessionId: string): Stream {
  const existing = streams.get(sessionId)
  if (existing !== undefined) return existing
  // Bound the store before minting: a session nobody is watching is what goes.
  // A record WITH visible consumers is never evicted — it owns the shared
  // invalidation subscription and the members' published state — so the cap is
  // soft while many sessions are genuinely open.
  if (streams.size >= STREAM_CAP) {
    for (const [key, candidate] of streams) {
      if (candidate.visible > 0) continue
      streams.delete(key)
      if (streams.size < STREAM_CAP) break
    }
  }
  const stream: Stream = {
    sessionId,
    state: EMPTY_STATE,
    listeners: new Set(),
    visible: 0,
    releaseEvents: undefined,
    seq: -1,
    primed: false,
    events: [],
    published: new Set(),
    cwd: undefined,
    pullPromise: undefined,
    pullAbort: undefined,
    dirty: false,
    fallbackActive: false,
    fallbackGeneration: 0,
    fallbackTimer: undefined,
  }
  streams.set(sessionId, stream)
  return stream
}

/** Move one session's record to the back of the eviction order (LRU). */
function touchStream(sessionId: string, stream: Stream): void {
  if (streams.get(sessionId) !== stream) return
  streams.delete(sessionId)
  streams.set(sessionId, stream)
}

function emit(stream: Stream): void {
  for (const listener of stream.listeners) listener()
}

/** Publish one delta's settled write/edit ops to every member of the stream. */
function publish(stream: Stream, ops: readonly FileOp[]): void {
  const revision = stream.state.revision + 1
  const touched = new Map(stream.state.touched)
  // `extractFileOps` orders newest first; walking it backwards leaves the
  // NEWEST op of this delta as the one recorded for a path touched twice.
  for (const op of [...ops].reverse()) {
    stream.published.add(op.callId)
    touched.set(fileOpKey(stream.cwd, op.path), { kind: op.kind as FileOpTouchKind, revision, time: op.time })
  }
  // Bound the memory of a long session. Map iteration is insertion order, and
  // re-touching a path keeps its original slot, so the evicted entry is not
  // strictly the oldest revision — a miss here only costs a stale preview
  // until the next write of that path, never wrong content.
  for (const key of touched.keys()) {
    if (touched.size <= TOUCH_WINDOW) break
    touched.delete(key)
  }
  stream.state = { ...stream.state, revision, touched }
  emit(stream)
}

/**
 * Fold one delta (plus the retained window) into the stream.
 * @param baseline - true for a fresh stream's FIRST fold: everything already
 * settled predates the editors that are joining, so it marks state without
 * publishing anything.
 */
function fold(stream: Stream, events: readonly SidebarSessionEvent[], baseline: boolean): void {
  const merged = [...stream.events, ...events]
  stream.events = merged.length > EVENT_WINDOW ? merged.slice(merged.length - EVENT_WINDOW) : merged
  const ops = extractFileOps(stream.events)
  if (baseline) {
    for (const op of ops) stream.published.add(op.callId)
  } else {
    const settled = ops.filter(op => (op.kind === 'write' || op.kind === 'edit')
      && !op.running && !op.isError && !stream.published.has(op.callId))
    if (settled.length > 0) publish(stream, settled)
  }
  // Ops that scrolled out of the window cannot settle any more: drop their
  // marks so the set can never grow past what the window can hold.
  const present = new Set(ops.map(op => op.callId))
  for (const callId of stream.published) {
    if (!present.has(callId)) stream.published.delete(callId)
  }
}

/** Pull one baseline or every primed page, advancing only after each fold. */
async function pullStream(stream: Stream, scope: SessionScope, signal: AbortSignal, wait: boolean): Promise<void> {
  let waitForEvent = wait
  for (;;) {
    const baseline = !stream.primed
    const previousSeq = stream.seq
    const { events, lastSeq } = await api.changesOps(scope, baseline ? undefined : previousSeq, signal, waitForEvent)
    // A torn-down run's answer must never publish state: the transport may
    // deliver an aborted response anyway.
    if (signal.aborted) return
    if (scope.cwd !== undefined && scope.cwd !== '') stream.cwd = scope.cwd
    stream.primed = true
    if (lastSeq > stream.seq) stream.seq = lastSeq
    if (events.length > 0) fold(stream, events, baseline)
    waitForEvent = false
    // A fresh baseline intentionally selects the recent tail. A primed full
    // page instead means more deltas remain and the next page starts after it.
    if (baseline || events.length < EVENTS_PAGE_CAP || lastSeq <= previousSeq) return
  }
}

function active(stream: Stream): boolean {
  return stream.visible > 0 && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
}

/** One HTTP run shared by Remote invalidations and the degraded polling path. */
function requestPull(stream: Stream, sessionId: string): Promise<void> {
  if (!active(stream)) return Promise.resolve()
  stream.dirty = true
  if (stream.pullPromise !== undefined) return stream.pullPromise
  const controller = new AbortController()
  stream.pullAbort = controller
  const running = (async () => {
    try {
      while (stream.dirty && active(stream) && !controller.signal.aborted) {
        stream.dirty = false
        await pullStream(stream, { sessionId, cwd: stream.cwd }, controller.signal, stream.state.degraded && stream.primed)
      }
    } finally {
      if (stream.pullAbort === controller) stream.pullAbort = undefined
      stream.pullPromise = undefined
      // A ready barrier may abort an older degraded wait after marking dirty.
      // Finish that old promise, then run the trailing catch-up on a fresh one.
      if (stream.dirty && active(stream)) {
        queueMicrotask(() => { void requestPull(stream, sessionId).catch(() => {}) })
      }
    }
  })()
  stream.pullPromise = running
  return running
}

function stopFallback(stream: Stream): void {
  stream.fallbackActive = false
  stream.fallbackGeneration += 1
  if (stream.fallbackTimer !== undefined) window.clearTimeout(stream.fallbackTimer)
  stream.fallbackTimer = undefined
}

/** The old cadence, owned by the session record rather than by any editor hook. */
function startFallback(stream: Stream): void {
  if (stream.fallbackActive || !stream.state.degraded || !active(stream)) return
  stream.fallbackActive = true
  const generation = ++stream.fallbackGeneration
  const run = async (): Promise<void> => {
    if (generation !== stream.fallbackGeneration || !stream.state.degraded || !active(stream)) return
    try {
      await requestPull(stream, stream.sessionId)
    } catch {
      // Keep the last view; the next degraded tick retries.
    }
    if (generation !== stream.fallbackGeneration || !stream.state.degraded || !active(stream)) return
    stream.fallbackTimer = window.setTimeout(() => {
      stream.fallbackTimer = undefined
      void run()
    }, FILE_OPS_INTERVAL_MS)
  }
  void run()
}

function setDegraded(stream: Stream, degraded: boolean): void {
  if (stream.state.degraded !== degraded) {
    stream.state = { ...stream.state, degraded }
    emit(stream)
  }
  if (degraded) startFallback(stream)
  else stopFallback(stream)
}

/**
 * Join one session's file-operation stream while `enabled` and the page is visible.
 * Every editor reads the same state; one Remote subscription drives the HTTP catch-up.
 */
export function useFileOpStream(scope: SessionScope, enabled: boolean): FileOpStreamState {
  const { sessionId } = scope
  const cwd = scope.cwd
  const pageVisible = usePageVisible()
  const armed = enabled && pageVisible && sessionId !== ''

  useEffect(() => {
    if (cwd !== undefined && cwd !== '') streamOf(sessionId).cwd = cwd
  }, [sessionId, cwd])

  useEffect(() => {
    if (!armed) return
    const stream = streamOf(sessionId)
    touchStream(sessionId, stream)
    stream.visible += 1
    if (stream.visible === 1) {
      stream.releaseEvents = retainSessionEvents(sessionId, {
        ready: () => {
          setDegraded(stream, false)
          // Cancel a parked long-poll fallback; ready is the catch-up barrier.
          stream.pullAbort?.abort()
          void requestPull(stream, sessionId).catch(() => {})
        },
        change: () => {
          setDegraded(stream, false)
          void requestPull(stream, sessionId).catch(() => {})
        },
        degraded: () => { setDegraded(stream, true) },
      })
      startFallback(stream)
    }
    return () => {
      stream.visible = Math.max(0, stream.visible - 1)
      if (stream.visible > 0) return
      stream.releaseEvents?.()
      stream.releaseEvents = undefined
      stopFallback(stream)
      stream.pullAbort?.abort()
      stream.dirty = false
      if (stream.events.length > IDLE_EVENT_WINDOW) {
        // The cursor and touches survive, so a return still folds missed deltas.
        stream.events = stream.events.slice(stream.events.length - IDLE_EVENT_WINDOW)
      }
    }
  }, [armed, sessionId])

  const state = useSyncExternalStore(
    useCallback((listener: () => void) => {
      const stream = streamOf(sessionId)
      stream.listeners.add(listener)
      return () => { stream.listeners.delete(listener) }
    }, [sessionId]),
    useCallback(() => streams.get(sessionId)?.state ?? EMPTY_STATE, [sessionId]),
  )

  return state
}
