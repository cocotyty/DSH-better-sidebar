/** Client-safe wire contract for the plugin's private Remote event namespace. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

/** A subscription is ready, or a coalesced file-operation invalidation arrived. */
export type SidebarEventsFrame =
  | { readonly type: 'ready' }
  | { readonly type: 'change'; readonly seq: number; readonly ops: true }

const sessionIdSchema = (): z.ZodType<string> => z.string()
const frameSchema = (): z.ZodType<SidebarEventsFrame> => z.union([
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('change'), seq: z.number(), ops: z.literal(true) }),
])

/**
 * Strict descriptor shared by Host registration and Client mounting.
 * Other private invalidation domains can join this namespace without another carrier.
 */
export const SIDEBAR_EVENTS_REMOTE = createTypertRemoteInfo({
  package: 'dsh-better-sidebar',
  methods: {
    'betterSidebarEvents/changes': {
      service: 'betterSidebarEvents',
      description: 'Follow coalesced file-operation invalidations for one Session.',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'sessionId',
        description: 'Session whose file-operation log is observed.',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-better-sidebar#SessionId', create: sessionIdSchema },
        strictCodec: { mode: 'strict', typeSymbol: 'dsh-better-sidebar#SessionId', create: sessionIdSchema },
      }],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-better-sidebar#SidebarEventsFrame',
        create: frameSchema,
      },
    },
  },
}, z)
