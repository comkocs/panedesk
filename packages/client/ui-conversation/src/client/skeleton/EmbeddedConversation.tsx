/** Shared embedded conversation rendered through its owning plugin's factory. */
import type { ReactNode } from 'react'
import type { FactoryComponentPropsOf } from '@panedesk/dsh-client-ui-slots'
import type { ConversationViewsProps } from '../contract/slots.ts'
import { embeddedConversationPhase } from '../contract/snapshot.ts'

function ChatViews(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/**
 * Render one embedded conversation with framework-bound session facts.
 * @param props - Factory scope and renderer capabilities.
 * @returns The shared content occurrence, including its composer.
 */
export function EmbeddedConversation({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: FactoryComponentPropsOf<'conversation.embedded'>): ReactNode {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const phase = embeddedConversationPhase(session, conversation, { summaryBlank })
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase, hero: phase === 'hero' },
    { slots: { views: ChatViews } },
  )
}
