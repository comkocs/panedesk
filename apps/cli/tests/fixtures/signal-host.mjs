/** Credential-free profile fixture for native debugger-signal acceptance. */
import { url } from 'node:inspector'
import { createInterface } from 'node:readline'

export const name = 'signal-host-fixture'
export const inject = ['appReady']

export function apply(ctx) {
  const input = createInterface({ input: process.stdin })
  input.on('line', () => {
    process.stdout.write(JSON.stringify({ inspector: url() !== undefined }) + '\n')
  })
  ctx.effect(() => () => input.close())
  if (process.send !== undefined) {
    const receive = (message) => {
      process.send({ message, inspector: url() !== undefined, args: process.execArgv })
    }
    process.on('message', receive)
    ctx.effect(() => () => process.off('message', receive))
  }
  ctx.appReady.onReady(() => {
    const ready = { ready: true, pid: process.pid, args: process.execArgv }
    process.stdout.write(JSON.stringify(ready) + '\n')
    process.send?.(ready)
  })
}
