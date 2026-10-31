/** Abortable delay shared by resource providers without importing a plugin entrypoint. */

/**
 * Wait until a polling interval elapses or the resource consumer leaves.
 * @param signal - Abort signal owned by the resource occurrence.
 * @param intervalMs - Delay before the next read.
 * @returns Settlement on timeout or abort, whichever occurs first.
 */
export function waitForPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, intervalMs)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
