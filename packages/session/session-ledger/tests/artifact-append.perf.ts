/** Cross-platform diagnostic: three 1,000-fragment streams with unchanged durable writes. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { appendArtifact, ArtifactAppendCache } from '../src/journal.ts'
import type { LedgerCallId } from '../src/types.ts'

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
}
let passed = 0
for (let run = 1; run <= 3; run++) {
  const root = await mkdtemp(join(import.meta.dirname, '.artifact-perf-'))
  const cache = new ArtifactAppendCache()
  const times: number[] = []
  try {
    for (let seq = 0; seq < 1000; seq++) {
      const start = performance.now()
      const result = await appendArtifact(root, { callId: 'stream' as LedgerCallId, kind: 'partial-response', seq, content: JSON.stringify({ seq, text: 'fragment' }) }, { lockTimeoutMs: 3000, lockRetryMs: 5, maxRecordBytes: 1024 * 1024 }, cache)
      times.push(performance.now() - start)
      if (result.kind !== 'appended') throw new Error('Unexpected append outcome')
    }
    const segments = Array.from({ length: 10 }, (_, index) => median(times.slice(index * 100, (index + 1) * 100)))
    const ratio = segments[9]! / segments[0]!
    if (ratio <= 1.15) passed++
    process.stdout.write(JSON.stringify({ platform: process.platform, run, segmentMediansMs: segments, medianMs: median(times), ratio, passed: ratio <= 1.15 }) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}
if (passed < 2) throw new Error('Fewer than two runs met the 1.15 scaling limit')
