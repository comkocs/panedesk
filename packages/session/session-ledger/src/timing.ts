/** Interval unions preserve overlapping categories without subtracting them from wall time. */
import type { LedgerInterval } from './types.ts'

/** Per-category durations retain both their union and their uncollapsed observations. */
export interface LedgerTiming {
  categories: Partial<Record<LedgerInterval['kind'], { durationMs: number; rawMs: number; toolCalls: number }>>
  waitMs: number
  rawWaitMs: number
}

function union(intervals: readonly [number, number][]): number {
  let end = -Infinity
  let total = 0
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  return total
}

/** Fold completed observations; a monotonic duration takes precedence over wall-clock subtraction.
 * @param intervals - Runtime observations, including possible duplicate tool calls.
 * @returns Category unions, distinct tool counts, and the union across waiting categories.
 */
export function foldIntervals(intervals: readonly LedgerInterval[]): LedgerTiming {
  const groups = new Map<LedgerInterval['kind'], LedgerInterval[]>()
  for (const interval of intervals) {
    if (interval.endedAt === undefined && interval.durationMs === undefined) continue
    const group = groups.get(interval.kind) ?? []
    if (!interval.toolCallId || !group.some(item => item.toolCallId === interval.toolCallId)) group.push(interval)
    groups.set(interval.kind, group)
  }
  const categories: LedgerTiming['categories'] = {}
  const waits: [number, number][] = []
  let rawWaitMs = 0
  for (const [kind, group] of groups) {
    const ranges: [number, number][] = group.map(item => [item.startedAt,
      item.startedAt + Math.max(0, item.durationMs ?? ((item.endedAt ?? item.startedAt) - item.startedAt))])
    const rawMs = ranges.reduce((sum, [start, end]) => sum + end - start, 0)
    categories[kind] = {
      durationMs: union(ranges), rawMs,
      toolCalls: new Set(group.flatMap(item => item.toolCallId ? [item.toolCallId] : [])).size,
    }
    if (kind !== 'model-in-flight') {
      waits.push(...ranges)
      rawWaitMs += rawMs
    }
  }
  return { categories, waitMs: union(waits), rawWaitMs }
}
