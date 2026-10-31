/** Shared body of an embedded conversation occurrence. Each host supplies its blank flag and view. */
import type { ReactNode } from 'react'
import type { FactoryLocalComponent, PropsRenderFactories } from '@panedesk/dsh-client-ui-slots'
import { embeddedConversationPhase } from '../contract/snapshot.ts'

type SessionFact = Parameters<typeof embeddedConversationPhase>[0]
type ConversationFact = Parameters<typeof embeddedConversationPhase>[1]

/** Subscribed facts and the view component the host owns. */
interface EmbeddedConversationProps {
  useSession: (select: (value: SessionFact) => SessionFact) => SessionFact
  useConversation: (select: (value: ConversationFact) => ConversationFact) => ConversationFact
  summaryBlank: boolean | undefined
  renderFactorySlot: PropsRenderFactories['renderFactorySlot']
  views: FactoryLocalComponent<'conversation.content', 'views'>
}

/**
 * Render one embedded conversation through the shared factory.
 * @param props - the host's session hooks, blank flag, and view component.
 * @returns the factory occurrence, including its composer.
 */
export function EmbeddedConversation({
  useSession, useConversation, summaryBlank, renderFactorySlot, views,
}: EmbeddedConversationProps): ReactNode {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const phase = embeddedConversationPhase(session, conversation, { summaryBlank })
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase, hero: phase === 'hero' },
    { slots: { views } },
  )
}
