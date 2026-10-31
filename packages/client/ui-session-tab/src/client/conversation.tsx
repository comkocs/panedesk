/** Session-scoped embedded transcript, using the shared conversation factory without importing another feature's values. */
import type { ConversationViewsProps } from '@panedesk/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Keep the embedded occurrence on its own Chat view. */
function ChatViews(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Embedded conversation props supplied by the bound Session scope. */
export type SessionConversationProps = PropsRuntime<'sidebar.session.conversation'> & PropsRenderFactories

/** Render the selected session through the existing shared conversation factory.
 * @param props - the retained session's framework seats.
 * @returns one independent conversation occurrence, including its composer.
 */
export function SessionConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }: SessionConversationProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: ChatViews },
  })
}
