/** Exact startup-review diagnostics shared by process-output assertions. */

const banner = 'Panedesk starting; protected input review precedes application startup. / Panedesk 正在启动；应用启动前先复核受保护输入。'
const countedProgress = new RegExp(
  String.raw`^Reviewing protected host inputs: (0|[1-9][0-9]*) checked, (0|[1-9][0-9]*) remaining\. \/ `
  + String.raw`正在复核受保护宿主输入：已核 \1，还剩 \2。$`, 'u',
)
const pendingProgress = new RegExp(
  String.raw`^Reviewing protected host inputs: (0|[1-9][0-9]*) review steps completed; remaining work is being determined\. \/ `
  + String.raw`正在复核受保护宿主输入：已完成 \1 个复核步骤；剩余工作量正在确定。$`, 'u',
)

/**
 * Recognize the complete bilingual startup banner without a line terminator.
 * @param line - One diagnostic line.
 * @returns Whether the line is exactly the startup banner.
 */
export function isInputReviewBanner(line: string): boolean {
  return line === banner
}

/**
 * Recognize a complete bilingual progress line with identical numeric values in both languages.
 * @param line - One diagnostic line without a line terminator.
 * @returns Whether the line is one of the two supported progress messages.
 */
export function isInputReviewProgress(line: string): boolean {
  return countedProgress.test(line) || pendingProgress.test(line)
}

/**
 * Remove only complete startup-review lines, preserving every other byte and line terminator.
 * @param stderr - Captured process diagnostics, optionally without the final newline.
 * @returns Diagnostics with only the exact bilingual banner and progress lines removed.
 */
export function stripInputReviewStderr(stderr: string): string {
  return (stderr.match(/[^\n]*\n|[^\n]+$/gu) ?? []).filter((chunk) => {
    const line = chunk.endsWith('\n') ? chunk.replace(/\r?\n$/u, '') : chunk
    return !isInputReviewBanner(line) && !isInputReviewProgress(line)
  }).join('')
}
