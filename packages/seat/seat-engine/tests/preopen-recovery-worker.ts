/** 测试子进程在补投追加前或落稳后停于可观测屏障。 */
import type { SeatNodeId } from '@panedesk/dsh-seat'
import { EngineJournal } from '../src/journal.ts'
import { recoverPreopenCallbacks } from '../src/preopen-recovery.ts'

async function main(): Promise<void> {
  const [root, stage] = process.argv.slice(2)
  if (!root || !stage) throw new Error('Missing recovery arguments')
  const journal = new EngineJournal(root, 'node-a' as SeatNodeId, 200000)
  await journal.ready()
  const commit = journal.commit.bind(journal)
  const pause = async () => {
    process.send?.({ stage })
    await new Promise<void>(() => {})
  }
  journal.commit = async (...args) => {
    if (stage === 'before-append') await pause()
    const result = await commit(...args)
    if (stage === 'after-append' && result) await pause()
    return result
  }
  try { await recoverPreopenCallbacks(journal, 'node-a') } finally { await journal.close() }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
