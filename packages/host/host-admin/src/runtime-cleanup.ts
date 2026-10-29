/** Teardown attempts every owned cleanup, including the lock, before reporting failures. */

/** Drain resources in order without allowing an earlier failure to strand later resources.
 * @param steps - Ordered, owned cleanup operations.
 * @returns Completion after all steps; rejects with the collected failures.
 */
export async function drainRuntime(steps: readonly (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try { await step() }
    catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Runtime cleanup failed')
}

/** Route graceful termination through the same idempotent cleanup as normal disposal.
 * @param dispose - Owned runtime teardown, including startup completion.
 * @param failed - Safe diagnostic callback; never receives error contents.
 * @returns Removal of both process listeners, called by normal teardown too.
 */
export function onRuntimeTermination(dispose: () => Promise<void>, failed: () => void): () => void {
  const terminate = (): void => { void dispose().catch(failed) }
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  return () => {
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
  }
}
