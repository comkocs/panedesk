/** Project append-only external dispatch records into leaf nodes without opening their sessions. */
import { z } from 'zod'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SubagentTreeNode } from './types.ts'

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
const usage = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
})
const record = z.object({
  '状态': z.enum(['在途', '结束']).default('结束'),
  '父会话号': z.string().min(1),
  '子会话号': z.string().min(1),
  '类型': z.string(),
  '模型': z.string().optional(),
  '实际模型': z.union([z.string(), z.array(z.string())]).optional(),
  '短题': z.string().optional(),
  '起': timestamp.optional(),
  '止': timestamp.optional(),
  '退出码': z.number().int().optional(),
  '用量': z.record(z.string(), usage).optional(),
})

/**
 * Keep the last valid record per child before selecting this parent's external leaves.
 * @param text - UTF-8 JSONL contents; malformed lines are ignored, including incomplete appends.
 * @param parentSessionId - on-screen Panedesk session owning these dispatches.
 * @param asOf - observation time used for running durations.
 * @returns external leaves in first-observed child order, with the latest reported facts.
 */
export function externalRegistryNodes(text: string, parentSessionId: SessionId, asOf: number): SubagentTreeNode[] {
  const latest = new Map<string, z.infer<typeof record>>()
  for (const line of text.split('\n')) {
    let value: unknown
    try { value = JSON.parse(line) } catch (_invalidLine) { continue }
    const parsed = record.safeParse(value)
    if (parsed.success) latest.set(parsed.data['子会话号'], parsed.data)
  }
  return [...latest.values()].filter(row => row['父会话号'] === parentSessionId).map(row => {
    const usages = row['用量'] === undefined ? [] : Object.values(row['用量'])
    const sum = (key: keyof z.infer<typeof usage>): number | null => usages.length === 0 || usages.some(item => item[key] === undefined)
      ? null : usages.reduce((total, item) => total + (item[key] ?? 0), 0)
    const actual = row['实际模型']
    const model = (Array.isArray(actual) ? actual.join(', ') : actual) || row['模型'] || null
    const startedAt = row['起'] === undefined ? null : Date.parse(row['起'])
    const endedAt = row['止'] === undefined ? null : Date.parse(row['止'])
    const running = row['状态'] === '在途'
    return {
      sessionId: row['子会话号'] as SessionId,
      parentSessionId,
      children: [],
      external: { title: row['短题']?.trim() || row['类型'], type: row['类型'], startedAt, endedAt },
      status: running ? 'running' : 'finished',
      ...(!running ? { endReason: row['退出码'] === 0 ? 'completed' as const : 'error' as const } : {}),
      liveness: 'unknown',
      model,
      modelSource: 'registry',
      tokens: {
        inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadInputTokens'), cacheWriteTokens: sum('cacheCreationInputTokens'),
        cacheWriteShortTokens: null, cacheWriteLongTokens: null,
      },
      usageState: usages.length === 0 ? 'missing' : 'complete',
      cacheHitRate: null,
      elapsedMs: startedAt === null ? null : (endedAt ?? asOf) - startedAt,
      runs: 1, calls: 0, lastToolCall: null, seat: null, taskId: null,
    }
  })
}
