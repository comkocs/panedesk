/** Session-scoped embedded transcript, using the shared conversation factory without importing another feature's values. */
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Embedded conversation props supplied by the bound Session scope. */
export type SessionConversationProps = PropsRuntime<'sidebar.session.conversation'> & PropsRenderFactories

/** Render the selected session through the existing shared conversation factory.
 * @param props - the retained session's framework seats.
 * @returns one independent conversation occurrence, including its composer.
 */
export function SessionConversation({
  renderFactorySlot,
}: SessionConversationProps) {
  return <>{renderFactorySlot('conversation.embedded', {})}</>
}
