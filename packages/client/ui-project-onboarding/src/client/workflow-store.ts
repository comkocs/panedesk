/** Session-scoped workflow selection shared by the hero and composer reset. */
import { defineStore } from '@panedesk/dsh-client-store'

/** Declare transient workflow selection without changing the persisted composer draft.
 * @returns A store handle shared by the workflow entry registrations.
 */
export function createWorkflowStore() {
  return defineStore({
    init: (): { starterRevision: number | null } => ({ starterRevision: 0 }),
    actions: {
      setStarterRevision: (draft, revision: number | null) => { draft.starterRevision = revision },
    },
  })
}
