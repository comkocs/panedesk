/** The startup review stderr filter keeps its exact line patterns and rejects anything else. */
import { expect, it } from 'vitest'
import { stderrBeyondStartupReview } from './startup-review-stderr.ts'

/** Banner and both progress wordings, copied from the headless launch stderr. */
const ALLOWED = [
  'Panedesk starting; protected input review precedes application startup. / Panedesk 正在启动；应用启动前先复核受保护输入。',
  'Reviewing protected host inputs: 0 checked, 0 remaining. / 正在复核受保护宿主输入：已核 0，还剩 0。',
  'Reviewing protected host inputs: 12 checked, 3 remaining. / 正在复核受保护宿主输入：已核 12，还剩 3。',
  'Reviewing protected host inputs: 0 review steps completed; remaining work is being determined. / 正在复核受保护宿主输入：已完成 0 个复核步骤；剩余工作量正在确定。',
  'Reviewing protected host inputs: 7 review steps completed; remaining work is being determined. / 正在复核受保护宿主输入：已完成 7 个复核步骤；剩余工作量正在确定。',
].join('\n') + '\n'

it('drops only exact startup review banner and progress lines', () => {
  expect(stderrBeyondStartupReview(ALLOWED)).toBe('')
  expect(stderrBeyondStartupReview(`${ALLOWED}panedesk: something else happened\n`)).toBe('panedesk: something else happened')
  const altered = ALLOWED.replace('precedes', 'follows')
  expect(stderrBeyondStartupReview(altered)).not.toBe('')
})
