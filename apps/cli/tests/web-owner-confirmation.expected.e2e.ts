/** Built Web authentication keeps owner confirmation outside redirected input and ambient configuration. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const bin = join(repo, 'apps/cli/lib/bin.js')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-owner-confirmation-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(cwd)
  await mkdir(home)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))),
    HOME: home,
    PANEDESK_HOME: home,
    PANEDESK_AGENTS_HOME: join(root, 'agents'),
    PANEDESK_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
  }
  return { cwd, home, env }
}

async function launch(ambientOverride = false, tamperedOverlay = false) {
  const f = await fixture()
  const patch = join(f.cwd, 'cordis.patch.yml')
  if (tamperedOverlay) {
    await writeFile(patch, '- id: connection\n  config: {}\n')
    const integrity = new ProtectedInputIntegrity(f.cwd, f.home)
    integrity.observe(patch)
    await integrity.grantWrite()
  }
  if (ambientOverride || tamperedOverlay) {
    await writeFile(patch, '- id: connection\n  config:\n    requireOwnerConfirmation: false\n')
  }
  const child = execa(process.execPath, [bin, '--profile', 'web',
    ...tamperedOverlay ? ['--patch', patch] : [], '--no-open', '--port', '0'], {
    cwd: f.cwd, extendEnv: false,
    env: { ...f.env, ...ambientOverride ? { requireOwnerConfirmation: 'false', REQUIRE_OWNER_CONFIRMATION: 'false' } : {} },
    stdin: 'pipe', reject: false, timeout: 60_000,
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  onTestFinished(async () => { child.kill('SIGTERM'); await child })
  const ready = expect.poll(() => /panedesk web: (http:\/\/[^\s]+)/u.exec(output)?.[1], { timeout: 30_000 }).toBeDefined()
  await Promise.race([ready, child.then((result) => { throw new Error(`Web exited before readiness (exit ${result.exitCode})`) })])
  return /panedesk web: (http:\/\/[^\s]+)/u.exec(output)![1]!
}

it.each([false, true])('refuses a built Web launch without a terminal (ambient override=%s)', async (ambientOverride) => {
  const response = await fetch(await launch(ambientOverride), { redirect: 'manual' })
  expect(response.status).toBe(401)
  expect(response.headers.get('set-cookie')).toBeNull()
  const body = await response.text()
  expect(body).toContain('Owner confirmation is required')
  expect(body).toContain('需要所有者确认')
  expect(body).toContain('requireOwnerConfirmation: false')
  expect(body).toContain('protected host configuration')
  expect(body).toContain('受保护的宿主配置')
})

it('keeps approved confirmation bytes when a writable workspace overlay is changed', async () => {
  const response = await fetch(await launch(false, true), { redirect: 'manual' })
  expect(response.status).toBe(401)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.text()).toContain('Owner confirmation is required')
})

it('does not expose an owner-confirmation command-line switch', async () => {
  const f = await fixture()
  const result = await execa(process.execPath, [bin, 'web', '--requireOwnerConfirmation=false'], {
    cwd: f.cwd, extendEnv: false, env: f.env, reject: false,
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('unknown option')
})

it.skipIf(process.platform === 'win32').each(['y', 'n'] as const)('applies the explicit terminal answer %s to a built Web browser', async (answer) => {
  const f = await fixture()
  const script = `import os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], 'web', '--no-open', '--port', '0'])
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 1024)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(master)
`
  const child = execa('python3', ['-I', '-c', script, process.execPath, bin], {
    cwd: f.cwd, extendEnv: false, env: f.env, stdin: 'pipe', reject: false, timeout: 60_000,
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  onTestFinished(async () => { child.stdin.end(); await child })
  await expect.poll(() => /panedesk web: (http:\/\/[^\s]+)/u.exec(output)?.[1], { timeout: 30_000 }).toBeDefined()
  const url = /panedesk web: (http:\/\/[^\s]+)/u.exec(output)![1]!
  const response = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Owner acceptance fixture' } })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  expect(typeof cookie).toBe('string')
  if (cookie === undefined) throw new Error('Owner browser cookie missing')
  await expect.poll(() => output.includes('[y/N]')).toBe(true)
  expect(output).toContain('Owner acceptance fixture')
  child.stdin.write(`${answer}\n`)
  if (answer === 'y') {
    await expect.poll(async () => (await fetch(new URL('/', url), { headers: { cookie } })).status).toBe(200)
  } else {
    await expect.poll(async () => (await fetch(new URL('/', url), { headers: { cookie } })).status).toBe(401)
  }
})
