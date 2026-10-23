/** Freeze wall-clock reads without replacing timer scheduling in this replay process. */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

export const name = 'seat-snapshot-clock'

/** Install the scenario clock for the lifetime of its Loader entry. */
export function apply(ctx) {
  ctx.effect(() => {
    const OriginalDate = globalThis.Date
    const instant = OriginalDate.parse('2026-01-01T00:00:00.000Z')
    class SnapshotDate extends OriginalDate {
      constructor(...args) {
        if (args.length === 0) super(instant)
        else super(...args)
      }
      static now() { return instant }
    }
    const originalUuid = crypto.randomUUID
    let sequence = 0
    crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
    syncBuiltinESMExports()
    globalThis.Date = SnapshotDate
    return () => {
      globalThis.Date = OriginalDate
      crypto.randomUUID = originalUuid
      syncBuiltinESMExports()
    }
  })
}
