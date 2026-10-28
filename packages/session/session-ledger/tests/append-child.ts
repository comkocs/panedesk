/** Deterministic source-process fixture for lock and interrupted-append acceptance. */
import { appendUnique, type JournalOptions } from '../src/journal.ts'
import type { LedgerEventId } from '../src/types.ts'
import { event, options } from './fixtures.ts'

const [root, mode, writer] = process.argv.slice(2)
if (!root || !mode || !writer) throw new Error('Missing fixture arguments')
const checkpoint: JournalOptions['appendCheckpoint'] = async (phase) => {
  if (phase !== mode) return
  process.send?.({ phase })
  await new Promise<void>(() => { /* The parent owns termination at this checkpoint. */ })
}
process.send?.({ ready: true, pid: process.pid })
process.once('message', () => {
  void (async () => {
    for (let i = 0; i < 12; i++) {
      const fact = { ...event(), eventId: `${writer}:${i}` as LedgerEventId }
      if (fact.kind !== 'call/start') throw new Error('Expected start fixture')
      fact.data = { ...fact.data, callId: `${writer}:${i}` as typeof fact.data.callId }
      fact.callId = fact.data.callId
      const result = await appendUnique(root, fact, { ...options,
        ...(mode === 'concurrent' || i === 0 && mode !== 'before-directory-sync' ? {} : { appendCheckpoint: checkpoint }) })
      process.send?.({ confirmed: fact.eventId, kind: result.kind })
    }
    process.disconnect?.()
  })().catch((error: unknown) => {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
    process.disconnect?.()
  })
})
