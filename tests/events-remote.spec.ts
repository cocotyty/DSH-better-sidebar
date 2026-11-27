import { Context as CordisContext } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { SidebarEventsRemote } from '../src/events-remote.ts'
import { SIDEBAR_EVENTS_REMOTE } from '../src/events-remote-info.ts'
import type { Context } from '../src/context-types.ts'

describe('betterSidebarEvents Remote stream', () => {
  it('declares a strict stream descriptor', () => {
    const descriptor = SIDEBAR_EVENTS_REMOTE.descriptors[0]!
    expect(descriptor.namespace).toBe('betterSidebarEvents')
    expect(descriptor.method).toBe('changes')
    expect(descriptor.mode).toBe('stream')
    if (descriptor.result.mode !== 'strict') throw new Error('strict result codec missing')
    expect(descriptor.result.create().parse({ type: 'change', seq: 3, ops: true })).toEqual({ type: 'change', seq: 3, ops: true })
  })

  it('sends ready and coalesces a tool burst without carrying event bodies', async () => {
    const runtime = new CordisContext()
    const fiber = await runtime.plugin(SessionStore)
    const session = runtime.sessions.create()
    const remote = new SidebarEventsRemote(runtime as Context)
    const marked = remoteMethods(remote)
    expect(marked).toHaveLength(1)
    expect(marked[0]?.mode).toBe('stream')
    expect(marked[0]?.resources).toBeDefined()
    const controller = new AbortController()
    const iterator = remote.changes(session.id, controller.signal)[Symbol.asyncIterator]()
    try {
      expect(await iterator.next()).toEqual({ done: false, value: { type: 'ready' } })
      const pending = iterator.next()
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: ToolCallId('write-1'),
        name: 'write',
        arguments: JSON.stringify({ file_path: 'a.txt', content: 'private payload' }),
      })
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: ToolCallId('write-2'),
        name: 'write',
        arguments: JSON.stringify({ file_path: 'b.txt', content: 'second payload' }),
      })
      const next = await pending
      expect(next).toEqual({ done: false, value: { type: 'change', seq: 1, ops: true } })
      expect(JSON.stringify(next.value)).not.toContain('private payload')
    } finally {
      controller.abort()
      await iterator.return?.()
      await fiber.dispose()
    }
  })
})
