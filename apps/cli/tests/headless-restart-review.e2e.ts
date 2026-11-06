/** A restarted built headless CLI passes its first protected-input review and finishes a keyless task. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'
import { startMockLlmServer } from '@panedesk/dsh-llm-mock-server'

/** Startup banner the launcher prints before the first review reads owner records. */
const BANNER = 'Panedesk starting; protected input review precedes application startup. / Panedesk 正在启动；应用启动前先复核受保护输入。'
/** One bilingual review progress line, e.g. "… 0 checked, 1 remaining. / …已核 0，还剩 1。". */
const PROGRESS = /Reviewing protected host inputs: \d+ checked, \d+ remaining\. \/ 正在复核受保护宿主输入：已核 \d+，还剩 \d+。/u
/** Bilingual refusal lines that must stay absent from a passing restart. */
const REFUSALS = [
  'Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline.',
  'Protected host input requires owner confirmation before creating an agent. Explicitly authorize workspace write access again to capture a new baseline.',
  'Protected host input review stalled: no progress within the configured interval (30 seconds by default). Check storage responsiveness and retry; workspace write access remains denied.',
  'Protected input copy changed',
  '受保护宿主输入捕获失败。',
  '受保护宿主输入复核未通过，无法创建代理。',
  '受保护宿主输入复核卡住：',
]

const WEB_READY_TIMEOUT_MS = 60_000
const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 150_000
/** Scripted final answer of the keyless model. */
const SUCCESS_TEXT = 'HEADLESS RESTART REVIEW OK'
/** The single task the restarted headless CLI must finish. */
const TASK = 'prove the tool path'

/** The baseline-capturing fixture mounted during the first real launch. */
const baselineFixture = pathToFileURL(fileURLToPath(new URL('./fixtures/input-review-baseline.mjs', import.meta.url))).href
/** The CLI source entry the shared example-launch resolver derives the built `lib/` bin from. */
const srcBin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/** One isolated world: home, workspace, and the baseline-capturing overlay. */
interface World {
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly capturePatch: string
}

/** Create the isolated home and workspace plus the baseline-capturing overlay. */
async function createWorld(prefix: string): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const home = join(root, 'owner')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const capturePatch = join(root, 'capture.yml')
  await writeFile(capturePatch, JSON.stringify([{ insert: [{ id: 'capture-review-input', name: baselineFixture }] }]))
  return { root, home, workspace, capturePatch }
}

/** Environment shared by every launch in one world. */
function worldEnv(world: World): NodeJS.ProcessEnv {
  return {
    HOME: world.root,
    PANEDESK_HOME: world.home,
    PANEDESK_AGENTS_HOME: join(world.root, 'agents'),
    PANEDESK_TELEMETRY_DISABLED: '1',
  }
}

/**
 * Boot the Web host once without a model request: the mounted fixture captures
 * and grants the durable protected-input baseline, then SIGTERM ends the launch.
 */
async function firstLaunch(world: World): Promise<void> {
  const launch = resolveExampleLaunch({
    srcBin,
    configArgs: ['--profile', 'web', '--patch', world.capturePatch, '--no-open', '--port', '0'],
    tsconfigPath,
    env: worldEnv(world),
  })
  const child = spawn(launch.command, launch.args, {
    cwd: world.workspace,
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const ready = Promise.withResolvers<string>()
  const receive = (chunk: Buffer): void => {
    output += chunk.toString()
    const url = /panedesk web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
    if (url !== undefined) ready.resolve(url)
  }
  child.stdout?.on('data', receive)
  child.stderr?.on('data', receive)
  child.once('error', ready.reject)
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = once(child, 'close')
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
    try {
      child.kill('SIGTERM')
      await closed
    } finally { clearTimeout(timer) }
  }
  try {
    const timer = setTimeout(() => {
      ready.reject(new Error(`the first Web launch never became ready. output:\n${output}`))
    }, WEB_READY_TIMEOUT_MS)
    try { await ready.promise } finally { clearTimeout(timer) }
    await stop()
    expect(child.exitCode, `the first Web launch did not exit cleanly. output:\n${output}`).toBe(0)
    const blobs = await readdir(join(world.home, 'windows-workspace-write', 'protected-inputs', 'blobs'))
    expect(blobs.length, 'the first launch must persist a protected input copy').toBeGreaterThan(0)
  } finally {
    await stop()
  }
}

/** One headless run's process outcome. */
interface RunOutcome {
  readonly exitCode: number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Run the one-shot task through the headless profile against the keyless mock model. */
async function restartTask(world: World, baseUrl: string): Promise<RunOutcome> {
  const launch = resolveExampleLaunch({
    srcBin,
    configArgs: ['--profile', 'headless', TASK],
    tsconfigPath,
    env: {
      ...worldEnv(world),
      DEEPSEEK_API_KEY: 'headless-restart-review-keyless',
      DEEPSEEK_BASE_URL: baseUrl,
    },
  })
  const result = await execa(launch.command, launch.args, {
    cwd: world.workspace,
    env: { ...process.env, ...launch.env },
    stdin: 'ignore',
    reject: false,
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
}

it('restarts the headless CLI onto a passing first review and finishes the keyless task', async () => {
  const world = await createWorld('cli-headless-restart-ok-')
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: SUCCESS_TEXT })
  try {
    await firstLaunch(world)
    const restarted = await restartTask(world, server.baseURL)
    expect(restarted.timedOut).toBe(false)
    expect(restarted.exitCode, `restart failed. stdout:\n${restarted.stdout}\nstderr:\n${restarted.stderr}`).toBe(0)
    const bannerAt = restarted.stderr.indexOf(BANNER)
    expect(bannerAt, 'the startup banner must precede the first review').toBeGreaterThanOrEqual(0)
    const progressAt = restarted.stderr.search(PROGRESS)
    expect(progressAt, 'the restart must report bilingual review progress after the banner').toBeGreaterThan(bannerAt)
    expect(restarted.stderr).toContain('1 checked, 0 remaining. / 正在复核受保护宿主输入：已核 1，还剩 0。')
    for (const refusal of REFUSALS) {
      expect(`${restarted.stdout}\n${restarted.stderr}`).not.toContain(refusal)
    }
    expect(restarted.stdout).toContain(SUCCESS_TEXT)
  } finally {
    await server.close()
    await rm(world.root, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('exits nonzero without the task when a protected copy changed before the restart', async () => {
  const world = await createWorld('cli-headless-restart-changed-')
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: SUCCESS_TEXT })
  try {
    await firstLaunch(world)
    const blobs = join(world.home, 'windows-workspace-write', 'protected-inputs', 'blobs')
    const [blob] = await readdir(blobs)
    if (blob === undefined) throw new Error('The first launch did not persist a protected input copy')
    await writeFile(join(blobs, blob), 'unapproved protected input copy')
    const restarted = await restartTask(world, server.baseURL)
    expect(restarted.timedOut).toBe(false)
    expect(restarted.exitCode).not.toBe(0)
    expect(restarted.stderr).toContain('Protected input copy changed')
    expect(restarted.stdout).not.toContain(SUCCESS_TEXT)
  } finally {
    await server.close()
    await rm(world.root, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)
