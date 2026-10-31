/** Registration-owned profile selection shared by settings and the seat menu. */
import { defineStore, type StoreHandle } from '@panedesk/dsh-client-store'
import type { SeatName } from '@panedesk/dsh-seat/types'

/** Create the editor navigation state before registering its settings section.
 * @returns A root-scoped store handle without business data.
 */
export function createProfileStore(): StoreHandle<{ seat: SeatName | null }, {
  select: (draft: { seat: SeatName | null }, seat: SeatName | null) => void
}> {
  return defineStore({
    init: () => ({ seat: null as SeatName | null }),
    actions: { select: (draft, seat: SeatName | null) => { draft.seat = seat } },
  })
}
