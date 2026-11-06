/** Isolated review processes remain terminable during synchronous reads and continue while work advances. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, it, onTestFinished, vi } from 'vitest'
import { runInputReviewThread } from '../src/input-review-thread.ts'

const fixtureProcess = vi.hoisted(() => ({ mode: 'stalled', configuration: '', pipe: '' }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: () => actual.spawn(process.execPath, ['-e', `
      const { readFileSync } = require('node:fs')
      process.once('message', () => {
        const fixture = ${JSON.stringify(fixtureProcess)}
        const timeoutMs = JSON.parse(readFileSync(fixture.configuration, 'utf8')).stallTimeoutMs
        process.send({ kind: 'configuration', timeoutMs })
        process.send({ kind: 'progress', completed: 0, total: 4 })
        if (fixture.mode === 'stalled') {
          if (fixture.pipe) readFileSync(fixture.pipe)
          else while (true) {}
        } else {
          let completed = 0
          const tick = () => {
            const until = performance.now() + timeoutMs / 2
            while (performance.now() < until) {}
            completed++
            process.send({ kind: 'progress', completed, total: 4 })
            if (completed < 4) setImmediate(tick)
            else process.send({ kind: 'result', result: 'accepted' })
          }
          tick()
        }
      })
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' }),
  }
})

function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'review-watchdog-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const directory = join(root, 'windows-workspace-write')
  mkdirSync(directory)
  fixtureProcess.mode = mode
  fixtureProcess.configuration = join(directory, 'input-review.json')
  fixtureProcess.pipe = ''
  if (mode === 'stalled' && process.platform !== 'win32') {
    fixtureProcess.pipe = join(root, 'blocked-read')
    execFileSync('mkfifo', [fixtureProcess.pipe], { timeout: 5000 })
  }
  writeFileSync(fixtureProcess.configuration, '{"stallTimeoutMs":100}', { mode: 0o600 })
}

it('terminates a synchronously stuck review with English and Chinese refusal', async () => {
  fixture('stalled')
  await expect(runInputReviewThread({}, () => {}, async () => false)).rejects.toThrow(/review stalled.*复核卡住/s)
})

it('admits slow advancing review after more than one configured stall interval', async () => {
  fixture('advancing')
  const progress: number[] = []
  const started = performance.now()
  expect(await runInputReviewThread({}, value => progress.push(value.completed), async () => false)).toBe('accepted')
  expect(performance.now() - started).toBeGreaterThan(100)
  expect(progress).toEqual([0, 1, 2, 3, 4])
})
