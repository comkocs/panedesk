// @vitest-environment jsdom
/** The sidebar uses the shared conversation factory and keeps its occurrence on Chat. */
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { conversationSnapshot, sessionSnapshot } from '@panedesk/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import type { SessionId } from '@panedesk/dsh-session/types'
import { SessionConversation, type SessionConversationProps } from '../src/client/conversation.tsx'

afterEach(cleanup)

it.each([
  ['active', false, 'open', false, false],
  ['hero', true, 'open', false, false],
  ['settling', true, 'loading', false, false],
  ['hero', false, 'open', true, false],
  ['active', true, 'open', false, true],
  ['active', true, 'open', true, true],
] as const)('renders the %s embedded phase (blank=%s, open=%s, awaiting=%s, attempted=%s)', (phase, blank, openState, awaitingFirstTurn, promptAttempted) => {
  const sessionId = 'sidebar' as SessionId
  const session = { ...sessionSnapshot(sessionId), blank, openState, awaitingFirstTurn, promptAttempted }
  const conversation = conversationSnapshot()
  const calls: Parameters<SessionConversationProps['renderFactorySlot']>[] = []
  const renderFactorySlot: SessionConversationProps['renderFactorySlot'] = (key, owner, options) => {
    calls.push([key, owner, options])
    return null
  }
  const props = {
    sessionId,
    useSession: select => select(session),
    useConversation: select => select(conversation),
    useSessions: select => select({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    renderFactorySlot,
  } satisfies Pick<SessionConversationProps, 'sessionId' | 'useSession' | 'useConversation' | 'useSessions' | 'renderFactorySlot'>
  render(<SessionConversation {...props as SessionConversationProps} />)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 2)).toEqual(['conversation.content', {
    variant: 'embedded', phase, hero: phase === 'hero',
  }])
  expect(calls[0]?.[2]).toHaveProperty('slots.views')
})
