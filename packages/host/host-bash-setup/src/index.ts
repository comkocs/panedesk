/** First-run Git Bash discovery Remote over the bash-local Windows product config. */

import { Context } from '@panedesk/cordis'
import { TypertRemoteService, Remote, RemoteError } from '@panedesk/dsh-typert-protocol'
import { probeWindowsBash, readWindowsBashConfig, clearWindowsBashConfig, writeWindowsBashConfig } from '@panedesk/dsh-bash-local'
import type { BashSetupStatus, BashSetupWriteResult } from './types.ts'

export type { BashSetupStatus, BashSetupWriteResult } from './types.ts'

/** Remote-only service the Web Settings General row drives. */
export class BashSetupGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'bashSetup')
  }

  private checkCancellation(): void {
    if (this.ctx.invocation?.signal.aborted) {
      throw new RemoteError('gateway/cancelled', 'Bash setup unavailable', {})
    }
  }

  /** Read the probe result, the committed selection, and the environment override in one call.
   * @returns Current first-run setup facts for the settings row.
   */
  @Remote('status')
  async status(): Promise<BashSetupStatus> {
    return Promise.resolve(this.snapshot())
  }

  /** Commit the user-confirmed selection and report the state after the write.
   * @param params - `bashPath` from the probe result or the operator's own entry.
   * @returns Status after the committed write; composition takes effect on the next start.
   */
  @Remote('enable')
  async enable(params: { bashPath: string }): Promise<BashSetupWriteResult> {
    this.checkCancellation()
    await writeWindowsBashConfig({ enabled: true, bashPath: params.bashPath })
    return this.snapshot()
  }

  /** Remove the committed selection so the platform default stands again.
   * @returns Status after the removal.
   */
  @Remote('disable')
  async disable(): Promise<BashSetupWriteResult> {
    this.checkCancellation()
    await clearWindowsBashConfig()
    return this.snapshot()
  }

  /** Current facts; the probe only resolves candidates on Windows. */
  private snapshot(): BashSetupStatus {
    const config = readWindowsBashConfig()
    const probe = process.platform === 'win32' ? probeWindowsBash() : undefined
    return {
      platform: process.platform,
      ...process.env.PANEDESK_BASH_PATH === undefined ? {} : { envOverride: process.env.PANEDESK_BASH_PATH },
      ...config === undefined ? {} : { config },
      ...probe === undefined ? {} : { probe },
    }
  }
}

export default BashSetupGateway
