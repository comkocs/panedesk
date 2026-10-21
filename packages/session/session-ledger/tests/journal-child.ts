/** OS-only source fixture; no Cordis or workspace source resolver is loaded. */
import { appendUnique } from '../src/journal.ts'
import type { LedgerEvent } from '../src/types.ts'

process.send?.('ready')
process.once('message', () => {
  const event = JSON.parse(process.argv[3]!) as LedgerEvent
  void appendUnique(process.argv[2]!, event, { lockTimeoutMs: 3000, lockRetryMs: 5, maxRecordBytes: 1024 * 1024 })
    .then((result) => { process.stdout.write(result.kind + '\n'); process.disconnect?.() })
    .catch(() => { process.stderr.write('Child journal append failed\n'); process.exitCode = 1; process.disconnect?.() })
})
