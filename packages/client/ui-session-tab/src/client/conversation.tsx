/** Session-scoped embedded transcript, using the shared conversation factory without importing another feature's values. */
import { EmbeddedConversation, type ConversationViewsProps } from '@panedesk/dsh-client-ui-conversation/client'
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
export function SessionConversation({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: SessionConversationProps) {
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  return (
    <EmbeddedConversation
      useSession={useSession}
      useConversation={useConversation}
      summaryBlank={summaryBlank}
      renderFactorySlot={renderFactorySlot}
      views={ChatViews}
    />
  )
}
