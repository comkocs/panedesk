/** No subprocess transport is exercised by seat opening. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-shell'

export const name = 'unused-shell-transport'
export function apply(ctx: Context) {
  ctx.provide('shell', { sandboxMode: 'workspace-write',
    resolve() { throw new Error('Shell transport is not exercised') },
    run() { throw new Error('Shell transport is not exercised') },
    start() { throw new Error('Shell transport is not exercised') } })
}
