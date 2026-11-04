/** Root-context ownership of Windows sandbox Job identities across provider reloads. */
import { Context, Service } from '@panedesk/cordis'
import { createProductJob, loadTcpOwnerBindings, lookupTcpOwner, PRODUCT_JOB_ENV } from '@panedesk/dsh-win32-process'
import type { ConnectionSource, ConnectionSourceSocket } from '@panedesk/dsh-client-connection'

declare module '@panedesk/cordis' {
  interface Context {
    /** Host-lifetime Windows Job identities, independent of connection reloads. */
    windowsProductJobs: WindowsProductJobs
  }
}

/** Each launch has a separate parent Job so unrelated existing Job chains never merge. */
export class WindowsProductJobs extends Service {
  private readonly jobs: Array<ReturnType<typeof createProductJob>> = []
  private api: ReturnType<typeof loadTcpOwnerBindings> | undefined
  private closed = false

  constructor(ctx: Context) {
    super(ctx, 'windowsProductJobs')
    ctx.effect(() => {
      const close = (): void => {
        this.closed = true
        const failures: unknown[] = []
        for (const job of this.jobs) {
          try { job.close() } catch (error) { failures.push(error) }
        }
        if (failures.length > 0) this.ctx.logger.error(new AggregateError(failures, 'Windows product Job cleanup failed'))
      }
      process.once('exit', close)
      return () => { process.off('exit', close); close() }
    }, 'Windows product Job ownership')
  }

  /**
   * Reuse the root owner without closing identity handles on provider reload.
   * @param ctx - Subprocess provider context.
   * @returns The host's Windows identity owner.
   */
  static forHost(ctx: Context): WindowsProductJobs {
    return ctx.root.get('windowsProductJobs') ?? new WindowsProductJobs(ctx.root)
  }

  /**
   * Supply a fresh Job locator only to an explicitly confined command.
   * @param env - Complete validated target environment.
   * @returns A copied environment with the trusted runner's Job locator.
   */
  prepare(env: Record<string, string>): Record<string, string> {
    if (this.closed || this.jobs.length >= 4096) throw new Error('Windows product Job identity capacity exhausted; restart the host')
    const job = createProductJob()
    this.jobs.push(job)
    return { ...env, [PRODUCT_JOB_ENV]: job.name }
  }

  /**
   * Identify a client against every retained product Job.
   * @param socket - Physical server socket facts.
   * @returns Product membership, explicit nonmembership, or unknown.
   */
  classify(socket: ConnectionSourceSocket | undefined): ConnectionSource {
    if (this.closed) return 'unknown'
    try {
      this.api ??= loadTcpOwnerBindings()
      return lookupTcpOwner(this.api, this.jobs.map(job => job.handle), socket)
    } catch (_bindingsUnavailable) {
      return 'unknown'
    }
  }
}
