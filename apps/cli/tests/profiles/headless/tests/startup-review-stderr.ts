/**
 * Exact line patterns for the headless startup review banner and progress lines.
 *
 * Wording source (product code, unchanged here):
 * `packages/boot/app-boot/src/input-integrity-locales.ts` `en.starting` / `zh.starting`
 * and `en.reviewProgress` / `zh.reviewProgress`, joined as `${en} / ${zh}` by
 * `packages/boot/app-boot/src/input-integrity.ts` (`openOwnerRecordsAsync` and `verify`).
 * A counted progress line uses a known total; an uncounted line uses a negative total
 * while the remaining work is still being determined. Both are written to stderr.
 */

/** Startup banner printed before the first protected-input review read. */
const STARTUP_REVIEW_BANNER = /^Panedesk starting; protected input review precedes application startup\. \/ Panedesk 正在启动；应用启动前先复核受保护输入。$/u

/** Bilingual progress line once the number of inputs still to review is known. */
const COUNTED_REVIEW_PROGRESS = /^Reviewing protected host inputs: \d+ checked, \d+ remaining\. \/ 正在复核受保护宿主输入：已核 \d+，还剩 \d+。$/u

/** Bilingual progress line printed before the remaining work has been counted. */
const UNCOUNTED_REVIEW_PROGRESS = new RegExp(
  '^Reviewing protected host inputs: \\d+ review steps completed; remaining work is being determined\\. / '
  + '正在复核受保护宿主输入：已完成 \\d+ 个复核步骤；剩余工作量正在确定。$',
  'u',
)

/** Every stderr line a passing headless startup review may print, and nothing else. */
const STARTUP_REVIEW_STDERR_LINES: readonly RegExp[] = [
  STARTUP_REVIEW_BANNER,
  COUNTED_REVIEW_PROGRESS,
  UNCOUNTED_REVIEW_PROGRESS,
]

/**
 * Drop only the startup review banner and progress lines from captured stderr.
 * @param stderr - Raw stderr captured from one headless launch.
 * @returns The stderr lines that are not startup review output, joined by newlines.
 */
export function stderrBeyondStartupReview(stderr: string): string {
  const lines = stderr.split('\n')
  const kept = lines.filter(line => line !== '' && !STARTUP_REVIEW_STDERR_LINES.some(pattern => pattern.test(line)))
  return kept.join('\n')
}
