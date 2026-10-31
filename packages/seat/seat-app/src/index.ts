/** Ready-gated seat application; all operations use optional injected providers. */
import type { Context } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import type { RpcLimits } from '@panedesk/dsh-host-admin'
import type {} from '@panedesk/dsh-cmdline'
import { executeSeatCommand } from './cli.ts'

/** Explicit application identity. */
export const name = 'seat-app'
/** Only launcher services are mandatory; providers remain optional. */
export const inject = ['cmdlineArgs', 'appReady', 'appExit']

/** Explicit limits for optional existing-host administration. */
export interface Config {
  /** Required only when contacting an existing host through its private directory. */
  adminClient?: RpcLimits | undefined
}
/** Existing-host calls require deployment-selected transport limits. */
export const Config: Schema<Config> = Schema.object({ adminClient: Schema.union([Schema.const(undefined), Schema.object({
  maxFrameBytes: Schema.number().min(1).step(1).required(),
  requestTimeoutMs: Schema.number().min(1).max(2147483647).step(1).required(),
  maxPending: Schema.number().min(1).step(1).required(),
})]) })

/** Start one command after composition is ready and drain it before disposal.
 * @param ctx - launcher context.
 * @param config - Explicit optional existing-host client limits.
 */
export function apply(ctx: Context, config: Config): void {
  const args = ctx.get('cmdlineArgs'), ready = ctx.get('appReady'), exit = ctx.get('appExit')
  if (!args || !ready || !exit) throw new Error('Seat app requires launcher services')
  if (args.get().length === 1 && ['--help', '-h'].includes(args.get()[0] ?? '')) {
    ctx.effect(() => ready.onReady(() => {
      process.stdout.write('Usage: seat <command> [--seat <name> | --seats <names>] [--request <json>] [options]\n')
      exit(0)
    }))
    return
  }
  let running = Promise.resolve()
  ctx.effect(() => {
    const remove = ready.onReady(() => {
      running = (async () => {
        try {
          const result = await executeSeatCommand(ctx, args.get(), config.adminClient)
          process.stdout.write(JSON.stringify(result.output) + '\n')
          exit(result.code)
        } catch (error) {
          void error
          console.error('Seat command failed; inspect provider availability and operation status before retrying')
          exit(1)
        }
      })()
    })
    return async () => { remove(); await running }
  })
}
