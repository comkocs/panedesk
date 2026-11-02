/** Authenticated owner consent for plugin-manager replay scenarios. */
import { ownerAnswer } from '../../../packages/fs/tool-fs/tests/owner-answer.ts'

export const name = 'plugin-owner-approval'

export function apply(ctx, config) {
  ctx.inject(['agents'], async scope => {
    await ownerAnswer(scope, async request => {
      if (request.purpose !== undefined || request.toolName !== 'plugin_manager') throw new Error('Unexpected owner request')
      return config.outcome
    })
  })
}
