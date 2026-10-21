import { Context } from '@panedesk/cordis'
import { exitOnStdinEnd, provideCmdline } from '../../../boot/cmdline/src/index.ts'

// Keep a pre-handshake child alive so only the production EOF hook can stop it.
const ctx = new Context()
provideCmdline(ctx, {
  args: [],
  ready: { onReady: (listener) => { listener(); return () => {} } },
  exit: (code) => { void ctx.root.fiber.dispose().then(() => { process.exit(code) }) },
})
exitOnStdinEnd(ctx, 'test.parent-death')
process.stdin.on('data', () => { throw new Error('initialize must remain gated') })
process.stdin.resume()
setInterval(() => {}, 1000)
process.stdout.write(`${process.pid}\n`)
