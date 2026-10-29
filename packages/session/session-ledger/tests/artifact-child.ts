/** Source-resolution fixture for independent artifact writers and process restarts. */
import { appendArtifact, ArtifactAppendCache, finishArtifact } from '../src/journal.ts'
import type { LedgerCallId } from '../src/types.ts'

const [root, callId, start, count, close] = process.argv.slice(2)
if (!root || !callId || start === undefined || count === undefined) throw new Error('Missing artifact fixture arguments')
const options = { lockTimeoutMs: 3000, lockRetryMs: 5, maxRecordBytes: 1024 * 1024 }
const cache = new ArtifactAppendCache()
for (let seq = Number(start); seq < Number(start) + Number(count); seq++) {
  const result = await appendArtifact(root, { callId: callId as LedgerCallId, kind: 'partial-response', seq, content: JSON.stringify({ seq }) }, options, cache)
  if (result.kind !== 'appended') throw new Error('Unexpected artifact replay')
  if (close === 'close' && seq === Number(start) + Number(count) - 1) await finishArtifact(root, result.reference, options)
}
process.stdout.write('finished\n')
