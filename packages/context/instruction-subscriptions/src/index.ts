/** Inactive plugin scaffold; no listeners, services, or model context are registered. */
import type {} from '@panedesk/dsh-agent-instructions/events'

/** Stable plugin identity. */
export const name = 'instruction-subscriptions'

/** Reserved activation entry; currently performs no work. */
export function apply(): void {}
