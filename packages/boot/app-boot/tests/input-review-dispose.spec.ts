/** Disposing an idle resident review isolate returns and the child exits. */
import { execFile } from 'node:child_process'
import { expect, it } from 'vitest'

const driver = `
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { InputReviewThread } from './src/input-review-thread.ts'
  const root = mkdtempSync(join(tmpdir(), 'review-dispose-'))
  const thread = new InputReviewThread()
  const review = thread.run({ kind: 'open', workspace: join(root, 'workspace'), home: join(root, 'home') },
    () => {}, async () => false, undefined, true)
  review.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 2500))
  const started = performance.now()
  let outcome = 'pending'
  const timer = setTimeout(() => { outcome = 'timed-out' }, 5000)
  timer.unref()
  await thread.dispose()
  outcome = 'returned'
  console.log(JSON.stringify({ outcome, elapsedMs: Math.round(performance.now() - started) }))
  rmSync(root, { recursive: true, force: true })
`

it('returns from disposing an unreferenced resident review isolate', async () => {
  const child = execFile(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', driver], {
    cwd: new URL('..', import.meta.url).pathname,
    timeout: 20_000,
    killSignal: 'SIGKILL',
  })
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('exit', (code) => { resolve({ stdout, stderr, code }) })
  })
  const line = result.stdout.trim().split('\n').at(-1)
  const report = line === undefined || line === '' ? undefined : JSON.parse(line) as { outcome: string; elapsedMs: number }
  expect(report?.outcome, result.stderr.slice(0, 600)).toBe('returned')
  expect(report?.elapsedMs ?? Number.POSITIVE_INFINITY).toBeLessThan(5_000)
  expect(result.code).toBe(0)
}, 25_000)
