/** Freeze wall-clock reads without replacing timer scheduling in this replay process. */
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
    globalThis.Date = SnapshotDate
    return () => { globalThis.Date = OriginalDate }
  })
}
