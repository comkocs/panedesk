/** Native profile hand-offs do not grant writable ancestors of live host inputs. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'

it('omits shared writable temp ancestors from the actual Seatbelt hand-off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seatbelt-live-input-'))
  const workspace = join(root, 'workspace')
  const input = join(root, 'host.mjs')
  mkdirSync(workspace); writeFileSync(input, 'export {}')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  provider.internals = { platform: 'darwin' }
  const handed = await provider.confine(['node', input], { mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [input] })
  expect(handed.argv[0]).toBe('sandbox-exec')
  expect(handed.argv[2]).toContain(`(allow file-write* (subpath ${JSON.stringify(workspace)}))`)
  expect(handed.argv[2]).not.toContain(`(subpath ${JSON.stringify(tmpdir())})`)
})
