/** Real terminal-bash lifecycle over a deterministic native terminal handle. */
import { PassThrough } from 'node:stream'
import { BashTerminalBackend, Config } from '../../../packages/terminal/terminal-bash/src/index.ts'
import { resolveConfig } from '../../../packages/terminal/terminal-bash/src/config.ts'

export const name = 'terminal-workspace-snapshot'
export const inject = ['terminals', 'sandboxPolicy', 'sandbox', 'sessionProjections', 'workingDirectory']

export function apply(ctx) {
  const config = resolveConfig(Config({ pollIntervalMs: 10, exactProbeAfterMs: 20,
    idleSilenceMs: 50, handoffGraceMs: 20, timeoutMs: 2000, disposeGraceMs: 100 }))
  const backend = new BashTerminalBackend(ctx, config, () => {
    const output = new PassThrough()
    const finished = Promise.withResolvers()
    output.write('\x1b]133;D;0\x07dsh> ')
    return Promise.resolve({
      pid: 123,
      output,
      done: finished.promise,
      write: () => { throw new Error('Revoked terminal input reached the native writer') },
      resize: () => Promise.resolve(),
      inspectActivity: () => Promise.resolve({ state: 'idle', revision: 0 }),
      inspectForeground: () => Promise.resolve({ processGroupId: 123, inputWaiting: true }),
      signalForeground: () => Promise.resolve(123),
      terminate: () => {
        output.end()
        finished.resolve({ exitCode: 0, signal: null })
        return Promise.resolve()
      },
    })
  })
  ctx.terminals.registerBackend(backend)
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    if (step === 2) {
      const root = ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
      await ctx.sandboxPolicy.workspaceAccess.revoke(root, path => ctx.sandbox.revokeWorkspaceWriteGrant(path))
    }
    return next()
  }, { prepend: true })
}
