/** Test-only platform and native-call substitutes; policy, approval, and tools remain real. */
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { AclWriteGrant } from '@panedesk/dsh-sandbox-windows-acl'
import WindowsPolicy from '../fs-windows-read-only/windows-policy.mjs'

export const name = 'workspace-write-snapshot-runtime'

export function apply(ctx, config) {
  const active = new Set()
  const original = AclWriteGrant.create
  AclWriteGrant.create = () => {
    const temporary = new Set()
    return {
      add(path, standing = false) {
        active.add(path)
        if (!standing) temporary.add(path)
      },
      has: path => active.has(path),
      revoke: path => { active.delete(path) },
      dispose: () => { for (const path of temporary) active.delete(path) },
    }
  }
  ctx.effect(() => () => { AclWriteGrant.create = original }, 'snapshot native ACL replacement')
  ctx.plugin(WindowsPolicy, {})
  ctx.plugin(LocalSandboxProvider, {})
  ctx.inject(['sandbox'], (scope) => {
    scope.sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['snapshot-native-runner'] }
  })
  ctx.on('approval/request', request => {
    if (request.purpose?.type !== 'workspace-write') throw new Error('Unexpected approval in workspace snapshot')
    return Promise.resolve(config.outcome)
  }, { prepend: true })
}
