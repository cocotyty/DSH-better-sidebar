import { Context as CordisContext } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createChangesOpsApi } from '../src/changes-ops.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

describe('changes.ops waiting form', () => {
  it('parks an empty window and answers a real seq-0 event promptly', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    try {
      const baseline = await changesOps({ sessionId: session.id })
      expect(baseline).toEqual({ events: [], lastSeq: -1 })

      let settled = false
      const waiting = changesOps({ sessionId: session.id, afterSeq: -1, wait: true }).then(result => {
        settled = true
        return result
      })
      await new Promise(resolve => setTimeout(resolve, 1_000))
      expect(settled).toBe(false)

      const appendedAt = Date.now()
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: ToolCallId('first-call'),
        name: 'write',
        arguments: JSON.stringify({ file_path: 'hello.txt', content: 'hello' }),
      })
      const answer = await waiting
      expect(Date.now() - appendedAt).toBeLessThan(1_000)
      expect(answer.events.map(event => [event.seq, event.type])).toEqual([[0, 'tool/call']])
      expect(answer.lastSeq).toBe(0)
      expect(await changesOps({ sessionId: session.id, afterSeq: 0 })).toEqual({ events: [], lastSeq: 0 })
    } finally {
      await fiber.dispose()
    }
  })

  // The PTC sub-call pair (`tool/ptc-dispatch-start` + `tool/ptc-dispatch`) can
  // no longer be produced here: DSH 0.2.2 dropped both from the session event
  // TYPE map and from the store's append registry, so `SessionStore.append`
  // rejects them outright. The READER still has to understand them — logs
  // recorded on 0.2.1 keep those events, and `dsh-session`'s known-event-types
  // table still names them — but that contract belongs to the fold, which is
  // fed synthetic events directly in `tests/changes-ops.spec.ts` ("keeps PTC
  // sub-calls ..."). This route-level copy tested the store, not our filter, so
  // it is gone rather than faked.

  it('ends the empty-window wait when the client disconnects', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    const controller = new AbortController()
    try {
      const waiting = changesOps({ sessionId: session.id, afterSeq: -1, wait: true }, controller.signal)
      controller.abort()
      expect(await waiting).toEqual({ events: [], lastSeq: -1 })
    } finally {
      await fiber.dispose()
    }
  })
})

describe('changes.ops file-operation window', () => {
  /** A host context whose session store answers with one fixed synthetic log. */
  function contextWith(events: readonly SidebarSessionEvent[]): Context {
    return {
      sessions: { get: () => ({ snapshotEvents: () => events }) },
      get: () => undefined,
      on: () => () => {},
    } as unknown as Context
  }

  /** One synthetic log row. */
  function row(type: string, seq: number, data: Record<string, unknown>): SidebarSessionEvent {
    return { type, seq, time: seq * 1_000, data }
  }

  it('keeps file-tool rows and drops shell and program traffic', async () => {
    // The shell pair and the `<code>` program body sit in the same log as the
    // file traffic; only the rows the lens can fold may reach the client.
    const log = [
      row('tool/call', 0, { callId: 'shell-1', name: 'bash', arguments: '{"command":"ls"}' }),
      row('tool/result', 1, { message: { toolCallId: 'shell-1' } }),
      row('tool/call', 2, { callId: 'prog-1', name: 'code_run', arguments: '{"code":"..."}' }),
      row('tool/ptc-dispatch', 3, { subCallId: 'prog-1:ptc:1', name: 'glob', arguments: { pattern: '*' } }),
      row('tool/call', 4, { callId: 'read-1', name: 'read', arguments: '{"file_path":"a.txt"}' }),
      row('tool/result', 5, { message: { toolCallId: 'read-1' } }),
      row('tool/ptc-dispatch', 6, { subCallId: 'prog-1:ptc:2', name: 'edit', arguments: { file_path: 'b.txt' } }),
    ]
    const window = await createChangesOpsApi(contextWith(log))({ sessionId: 'session-1' })
    expect(window.events.map(event => event.seq)).toEqual([4, 5, 6])
    expect(window.lastSeq).toBe(6)
  })

  it('caps the window at the recent tail', async () => {
    const log = Array.from({ length: 250 }, (_, index) => row('tool/call', index, {
      callId: `write-${index}`,
      name: 'write',
      arguments: JSON.stringify({ file_path: `f${index}.txt`, content: 'x' }),
    }))
    const window = await createChangesOpsApi(contextWith(log))({ sessionId: 'session-1' })
    expect(window.events).toHaveLength(200)
    expect(window.events[0]?.seq).toBe(50)
    expect(window.lastSeq).toBe(249)
  })

  it('does not wake the wait form for a non-file tool', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const changesOps = createChangesOpsApi(runtime as Context)
    try {
      let settled = false
      const waiting = changesOps({ sessionId: session.id, afterSeq: -1, wait: true }).then(result => {
        settled = true
        return result
      })
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: ToolCallId('shell-1'),
        name: 'bash',
        arguments: JSON.stringify({ command: 'sleep 1' }),
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      session.append('tool/call', {
        turn: 0,
        step: 1,
        callId: ToolCallId('write-1'),
        name: 'write',
        arguments: JSON.stringify({ file_path: 'b.txt', content: 'y' }),
      })
      const answer = await waiting
      expect(answer.events.map(event => (event.data as { name?: unknown }).name)).toEqual(['write'])
    } finally {
      await fiber.dispose()
    }
  })
})
