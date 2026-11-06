/** A restarted Web host exposes its first protected-input review refusal in the browser. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

it('shows bilingual refusal when a protected input copy changes before restart review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-input-review-'))
  const home = join(root, 'owner')
  const workspace = join(root, 'workspace')
  const records = join(home, 'windows-workspace-write', 'protected-inputs')
  const cli = fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
  const fixture = fileURLToPath(new URL('../../cli/tests/fixtures/input-review-baseline.mjs', import.meta.url))
  const patch = join(root, 'capture.yml')
  const env = { PATH: process.env.PATH, HOME: root, PANEDESK_HOME: home,
    PANEDESK_AGENTS_HOME: join(root, 'agents'), TMPDIR: tmpdir(), LANG: 'C.UTF-8', CI: 'true' }
  const children = new Set<ChildProcess>()
  const browser = await chromium.launch({ headless: true })
  const launch = (): { child: ChildProcess; outcome: Promise<string | null>; logs: () => string } => {
    const child = spawn(process.execPath, [
      ...process.platform === 'win32' ? [] : ['--disable-sigusr1'],
      cli, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = ''
    const ready = Promise.withResolvers<string | null>()
    const receive = (data: Buffer): void => {
      output += data.toString()
      const url = /panedesk web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
      if (url !== undefined) ready.resolve(url)
    }
    child.stdout?.on('data', receive)
    child.stderr?.on('data', receive)
    child.once('error', ready.reject)
    child.once('close', () => { children.delete(child); ready.resolve(null) })
    return { child, outcome: ready.promise, logs: () => output }
  }
  const stop = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = once(child, 'close')
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
    try { child.kill('SIGTERM'); await closed }
    finally { clearTimeout(timer) }
  }
  try {
    await mkdir(workspace)
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'capture-review-input', name: fixture }] }]))
    const first = launch()
    expect(await first.outcome, 'The first Web host must start before the restart').not.toBeNull()
    await stop(first.child)
    const [blob] = await readdir(join(records, 'blobs'))
    if (blob === undefined) throw new Error('The first Web host did not persist a protected input copy')
    // The first host has exited; change its persisted protected copy before the second starts.
    await writeFile(join(records, 'blobs', blob), 'unapproved protected input copy')
    const restarted = launch()
    const url = await restarted.outcome
    expect(url, 'The rejected restart must publish a browser-visible refusal, not only stderr').not.toBeNull()
    if (url === null) return
    expect(restarted.logs()).toContain('Protected input copy changed')
    const page = await browser.newPage()
    const response = await page.goto(url)
    expect(response?.status()).toBe(503)
    const refusal = page.getByRole('alert')
    expect(await refusal.getAttribute('data-state')).toBe('refused')
    expect(await refusal.innerText()).toBe(
      'Protected host input review was refused. Restore the protected owner inputs and restart; workspace write access remains denied.\n\n'
      + '受保护宿主输入复核被拒绝。请恢复受保护的所有者输入后重启；工作区写入仍被拒绝。',
    )
    expect(await page.locator('[data-slot="root"]').count()).toBe(0)
    expect((await page.request.post(new URL('/api/session/create', url).href)).status()).toBe(404)
    await stop(restarted.child)
    expect(restarted.child.exitCode).toBe(1)
  } finally {
    await Promise.all([...children].map(stop))
    await browser.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
