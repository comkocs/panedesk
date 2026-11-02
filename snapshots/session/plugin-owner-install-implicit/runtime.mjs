/** Native platform and package-manager substitutes; owner approval and Loader stay real. */
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WindowsPolicy from '../fs-windows-read-only/windows-policy.mjs'
import { ownerAnswer } from '../../../packages/fs/tool-fs/tests/owner-answer.ts'

export const name = 'plugin-owner-snapshot-runtime'

export function apply(ctx, config) {
  ctx.plugin(WindowsPolicy, config)
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Snapshot requires the shipped profile launcher')
  const mkdtemp = fs.mkdtemp
  const operationPrefix = join(profile.dir, '.plugin-manager', 'logs', 'operation-')
  fs.mkdtemp = async (prefix, options) => {
    if (prefix !== operationPrefix) return mkdtemp(prefix, options)
    const path = `${operationPrefix}fixture`
    await fs.mkdir(path)
    return path
  }
  syncBuiltinESMExports()
  ctx.effect(() => () => { fs.mkdtemp = mkdtemp; syncBuiltinESMExports() }, 'snapshot operation directory')
  const previous = profile.packageManager
  profile.packageManager = {
    command: process.execPath,
    args: [fileURLToPath(new URL('./package-manager.mjs', import.meta.url))],
    env: {},
  }
  ctx.effect(() => () => { profile.packageManager = previous }, 'snapshot package manager')
  const original = readFileSync(join(profile.dir, 'package.json'), 'utf8')
  let requests = 0
  ctx.inject(['agents'], async scope => {
    await ownerAnswer(scope, async request => {
      if (request.purpose !== undefined || request.toolName !== 'plugin_manager') throw new Error('Unexpected owner request')
      if (readFileSync(join(profile.dir, 'package.json'), 'utf8') !== original) throw new Error('Package changed before owner consent')
      requests += 1
      await new Promise(resolve => setImmediate(resolve))
      return requests === 1 ? 'rejected' : 'allowed-once'
    })
  })
}
