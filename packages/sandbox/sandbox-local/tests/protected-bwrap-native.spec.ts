/** Real Linux mutations distinguish mount protection from host-owned name validation. */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { LocalSandboxProvider } from '@panedesk/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

const actions = [
  ['overwrite/append/truncate', 'printf changed > "$1"; printf appended >> "$1"; truncate -s 0 "$1"'],
  ['delete', 'rm -rf "$1"'],
  ['rename input and ancestor', 'mv "$1" "$1.moved"; mv "$2" "$2.moved"'],
  ['delete and recreate', 'rm -rf "$1"; printf replacement > "$1"'],
  ['create absent input', 'printf premature > "$1"'],
  ['replace symlink', 'rm "$1" && ln -s "$3" "$1"'],
] as const

for (const [action, command] of actions) it(`native bwrap protected inputs: ${action}`, async ({ skip }) => {
  if (process.platform !== 'linux') skip('native bubblewrap requires Linux')
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', '/bin/true'], { encoding: 'utf8', timeout: 5_000 })
  if (probe.status !== 0) {
    const reason = `bubblewrap unavailable: ${probe.error?.message ?? probe.stderr.trim()}; status=${probe.status}`
    console.info(reason)
    skip(reason)
  }
  const root = mkdtempSync(join(homedir(), '.protected-bwrap-native-'))
  const workspace = join(root, 'workspace')
  const parent = join(workspace, 'inputs')
  const input = join(parent, 'config.yml')
  const target = join(workspace, 'store', 'owner.yml')
  const replacement = join(workspace, 'replacement.yml')
  mkdirSync(parent, { recursive: true })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'owner\n')
  writeFileSync(replacement, 'unapproved\n')
  if (action === 'replace symlink') symlinkSync(target, input)
  else if (action !== 'create absent input') writeFileSync(input, 'owner\n')
  const original = existsSync(input) ? lstatSync(input) : undefined
  const originalParent = lstatSync(parent)
  const originalTarget = lstatSync(target)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider)
  const provider = ctx.sandbox
  if (!(provider instanceof LocalSandboxProvider)) throw new Error('Local provider missing')
  const ordinary = join(workspace, 'ordinary.txt')
  const script = `${command}\nmutation=$?\nprintf allowed > "$4" || exit 90\nprintf 'mutation=%s\\n' "$mutation"`
  const handed = await provider.confine(['/bin/sh', '-c', script, 'sh', input, parent, replacement, ordinary], {
    mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [input],
  })
  expect(handed.argv[0]).toBe('bwrap')
  if (action === 'create absent input') {
    const separator = handed.argv.indexOf('--')
    const startup = spawnSync(handed.argv[0]!, [...handed.argv.slice(1, separator), '--', '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    expect(startup.status, startup.stderr).toBe(0)
    expect(existsSync(input)).toBe(false)
    expect(handed.protectedInputs).toContainEqual({ path: input, enforcement: 'host-fallback', reason: 'unrepresentable' })
    const missingAncestor = join(workspace, 'missing')
    const nestedInput = join(missingAncestor, 'ancestor', 'config.yml')
    const nested = await provider.confine(['/bin/true'], {
      mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [nestedInput],
    })
    const nestedStartup = spawnSync(nested.argv[0]!, nested.argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
    expect(nestedStartup.status, nestedStartup.stderr).toBe(0)
    expect(existsSync(missingAncestor)).toBe(false)
    expect(nested.protectedInputs).toContainEqual({ path: nestedInput, enforcement: 'host-fallback', reason: 'unrepresentable' })
  }
  const result = spawnSync(handed.argv[0]!, handed.argv.slice(1), { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(ordinary, 'utf8')).toBe('allowed')
  expect(readFileSync(target, 'utf8')).toBe('owner\n')
  expect(lstatSync(target).ino).toBe(originalTarget.ino)
  expect(lstatSync(parent).ino).toBe(originalParent.ino)
  if (action === 'replace symlink') {
    expect(result.stdout).toBe('mutation=0\n')
    expect(readlinkSync(input)).toBe(replacement)
    console.info('native bwrap: link-name replacement succeeds; host input-integrity verification must reject the unapproved target before loading')
  } else if (action === 'create absent input') {
    expect(result.stdout).toBe('mutation=0\n')
    expect(readFileSync(input, 'utf8')).toBe('premature')
    console.info('native bwrap: absent-name creation requires host input-integrity validation before loading')
  } else {
    expect(result.stdout).not.toBe('mutation=0\n')
    expect(readFileSync(input, 'utf8')).toBe('owner\n')
    expect(lstatSync(input).ino).toBe(original?.ino)
    expect(existsSync(`${input}.moved`)).toBe(false)
    expect(existsSync(`${parent}.moved`)).toBe(false)
  }
  console.info(`native bwrap passed: ${action}`)
})
