/** Ready-gated seat application; all operations use optional injected providers. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-cmdline'
import { executeSeatCommand } from './cli.ts'

/** Explicit application identity. */
export const name = 'seat-app'
/** Only launcher services are mandatory; providers remain optional. */
export const inject = ['cmdlineArgs', 'appReady', 'appExit']

/** Start one command after composition is ready and drain it before disposal.
 * @param ctx - launcher context.
 */
export function apply(ctx: Context): void {
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
          const result = await executeSeatCommand(ctx, args.get())
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
