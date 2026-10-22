/** Recount retained barrier observations without trusting the test summary. */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const path = process.argv[2]
if (!path) throw new Error('Expected the race JSONL path')
const schema = z.object({
  barrier: z.enum(['before-claim', 'prepare-suspended', 'appended-before-stream', 'stream-entered']),
  iteration: z.number().int().min(0).max(49), successfulWithdrawal: z.boolean(), appended: z.boolean(), dispatched: z.boolean(),
  state: z.string(), phase: z.string(),
})
const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => schema.parse(JSON.parse(line)))
const counts = new Map<string, number>()
const identities = new Set<string>()
for (const row of rows) {
  const key = `${row.barrier}:${row.iteration}`
  if (identities.has(key)) throw new Error('Duplicate barrier observation')
  identities.add(key)
  counts.set(row.barrier, (counts.get(row.barrier) ?? 0) + 1)
}
const withdrawnAndAppended = rows.filter(row => row.successfulWithdrawal && row.appended)
const withdrawnAndDispatched = rows.filter(row => row.successfulWithdrawal && row.dispatched)
const result = { total: rows.length, counts: Object.fromEntries(counts), withdrawnAndAppended, withdrawnAndDispatched }
console.log(JSON.stringify(result, null, 2))
if (rows.length !== 200 || counts.size !== 4 || [...counts.values()].some(count => count !== 50)
  || withdrawnAndAppended.length > 0 || withdrawnAndDispatched.length > 0) process.exitCode = 1
