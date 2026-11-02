/** Native PTC denial substitute; policy, dispatch, and durable tool results remain real. */
import { PtcRuntime } from '@panedesk/dsh-ptc-runtime'

export default class DeniedRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'process'
  get sandboxMode() { return 'read-only' }

  resolve(request) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 }
  }

  async run(spec) {
    if (spec.sandboxPolicy?.mode !== 'read-only') throw new Error('Expected read-only confinement')
    return {
      logs: ['earlier output'],
      sandbox: { mode: 'read-only', denied: true },
      error: { kind: 'exception', message: 'write denied' },
    }
  }
}
