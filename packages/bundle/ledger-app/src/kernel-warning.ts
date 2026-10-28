/** Human diagnostics stay on stderr so ledger JSON output remains machine-readable. */
import type { Context } from '@panedesk/cordis'
import { readKernelStatus } from '@panedesk/dsh-app-boot'

/** Report the main process's accounting availability without replacing its status file.
 * @param ctx - offline query context with optional profile facts.
 * @returns after writing at most one warning line; non-profile embedders have no main-process home to inspect.
 */
export async function warnKernelStatus(ctx: Context): Promise<void> {
  const home = ctx.get('profileContext')?.home
  if (home === undefined) return
  const result = await readKernelStatus(home)
  if (result.kind === 'unavailable') {
    process.stderr.write(`Session ledger not mounted: ${result.cause}\n`)
    return
  }
  const missing = Object.entries(result.status.services).filter(([, value]) => value.status !== 'mounted')
  if (missing.length === 0) {
    if (result.stale) process.stderr.write('Session ledger status (may be stale): last main process is no longer current\n')
    return
  }
  process.stderr.write(`Session ledger not mounted: ${missing.map(([name, value]) => `${name}=${value.status}(${value.cause})`).join('; ')}${result.stale ? ' (may be stale)' : ''}\n`)
}

/** Describe missing query injection or its Loader failure using safe diagnostic codes.
 * @param ctx - offline query context.
 * @returns a one-line diagnostic preserving known dependency or lifecycle causes without raw exceptions.
 */
export function unavailableQueryCause(ctx: Context): string {
  const entry = [...ctx.get('loader')?.entries() ?? []].find(item => item.options.id === 'ledger-query')
  if (entry === undefined) return 'ledgerQuery=missing(entry-missing)'
  try {
    if (entry.disabled) return 'ledgerQuery=disabled(entry-disabled)'
  } catch (error) {
    void error // Expression text and values may contain credentials.
    return 'ledgerQuery=failed(disabled-expression-failed)'
  }
  const fiber = entry.fiber
  if (!fiber) return 'ledgerQuery=failed(import-failed)'
  const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    .filter(name => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name)).sort()
  return missing.length > 0 ? `ledgerQuery=failed(pending:${missing.join(',')})` : 'ledgerQuery=failed(activation-failed)'
}
