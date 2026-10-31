/** Page through an existing retained conversation without changing bookmark storage. */
import type { SessionBinding } from '@panedesk/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@panedesk/dsh-client-ui-chat/client'

/** Load older pages until the bookmarked message is rendered in this occurrence.
 * @param root - owning transcript occurrence.
 * @param messageId - persisted bookmark identity.
 * @param binding - currently retained Session generation.
 * @param readChat - current Chat projection used to detect paging progress.
 * @param signal - cancellation owned by this occurrence's jump.
 * @returns whether the target was found and scrolled into view.
 */
export async function jumpToPin(
  root: HTMLElement, messageId: string, binding: SessionBinding | undefined,
  readChat: () => ChatSnapshot | undefined, signal?: AbortSignal,
): Promise<boolean> {
  const current = (): boolean => root.isConnected && signal?.aborted !== true
  const locate = (): boolean => {
    const target = root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!(target instanceof HTMLElement)) return false
    target.scrollIntoView({ block: 'center' })
    return true
  }
  const head = (): number | undefined => {
    const chat = readChat()
    const key = chat?.order[0]
    return key === undefined ? undefined : chat?.nodes.get(key)?.anchorSeq
  }
  while (current()) {
    if (locate()) return true
    if (binding === undefined) return false
    const state = binding.session.getSnapshot()
    if (state.openState !== 'open' || !state.hasMore || state.loadingOlder) return false
    const before = head()
    await binding.session.loadOlder()
    // Let the committed Chat occurrence paint before looking for its message marker.
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
    if (!current()) return false
    if (locate()) return true
    const after = head()
    if (after === undefined || (before !== undefined && after >= before)) return false
  }
  return false
}
