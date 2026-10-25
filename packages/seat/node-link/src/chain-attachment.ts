/** Optional composition changes drain the previous transport before acquiring its directories again. */
import type { Context, Fiber } from '@panedesk/cordis'
import type { Config } from './index.ts'
import { mountNode } from './runtime.ts'

/** Track late installation, replacement and withdrawal without retaining stale service providers.
 * @param ctx - Owning plugin lifecycle and optional service store.
 * @param config - Explicit transport configuration, or an inert empty configuration.
 * @param awaitStartup - Windows startup waits for initial activation and propagates its failure.
 * @returns Owned disposer, or its startup promise when activation must be observed.
 */
export function mountChangingNode(ctx: Context, config: Config, awaitStartup = false):
  (() => Promise<void>) | Promise<() => Promise<void>> {
  if (config.runtime === undefined) return async () => {}
  let active: Fiber | undefined
  let stopped = false
  let revision = 0
  let services = ctx.get('nodeWorkChain')
  let business = ctx.get('nodeWorkChainBusiness')
  let serial = Promise.resolve()
  const refresh = (): void => {
    const wanted = ++revision
    const closing = active?.dispose()
    active = undefined
    serial = serial.then(async () => {
      await closing
      if (stopped || wanted !== revision) return
      const fiber = ctx.plugin({ name: 'node-link-attachment', apply(owner: Context) {
        const startup = owner.effect(() => mountNode(owner, config, awaitStartup || process.platform === 'win32'))
        if (awaitStartup) return Promise.resolve(startup)
      } })
      active = fiber
      await fiber
    })
    // Fiber activation owns and reports mount failures; keep replacement teardown observable.
    void serial.catch((error: unknown) => { void error })
  }
  const unwatch = ctx.on('internal/service', (name) => {
    if (name !== 'nodeWorkChain' && name !== 'nodeWorkChainBusiness') return
    const nextServices = ctx.get('nodeWorkChain'), nextBusiness = ctx.get('nodeWorkChainBusiness')
    if (services === nextServices && business === nextBusiness) return
    services = nextServices; business = nextBusiness
    refresh()
  })
  refresh()
  const dispose = async () => {
    stopped = true
    unwatch()
    const closing = active?.dispose()
    active = undefined
    await serial
    await closing
  }
  if (!awaitStartup) return dispose
  return serial.then(() => dispose, async (error: unknown) => {
    stopped = true
    unwatch()
    await active?.dispose()
    throw error
  })
}
