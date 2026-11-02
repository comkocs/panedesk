/** Isolated Python SDK test environment shared by specs that execute the Python SDK. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock } from '@panedesk/dsh-atomic-write'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const uvLockPath = join(repositoryRoot, 'python/sdk/uv.lock')
/** Runtime closure pin mirrored from `python/sdk/uv.lock`; bump both together. */
const LOCKED_PYDANTIC = 'pydantic==2.13.5'
/** Runtime closure of `deepseek-harness-sdk` in `python/sdk/uv.lock`; bump together with the lock. */
const RUNTIME_LOCK_PACKAGES = ['annotated-types', 'pydantic', 'pydantic-core', 'typing-extensions', 'typing-inspection'] as const

function importableBySdk(python: string): boolean {
  const probe = spawnSync(python, ['-B', '-c', 'import deepseek_harness'], {
    env: { ...process.env, PYTHONPATH: join(repositoryRoot, 'python/sdk/src') },
    stdio: 'ignore',
  })
  return probe.status === 0
}

function candidateInterpreters(): string[] {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  const environment = process.env.UV_PROJECT_ENVIRONMENT ?? cachedVenvDirectory() ?? join(repositoryRoot, 'tmp/py-sdk-venv')
  return [
    process.env.PYTHON,
    join(environment, executable),
    join(repositoryRoot, 'python/sdk/.venv', executable),
    'python3',
  ].filter((value): value is string => value !== undefined)
}

function run(python: string, args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(python, args, { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

/**
 * Build a `pip --require-hashes` requirements pin list for the SDK runtime closure straight
 * from `python/sdk/uv.lock`, keeping the lock as the single source of truth. Selection takes
 * the CPython linux-x64 wheels plus the universal `py3-none-any` wheels so the offline seed
 * resolves on the CI interpreter.
 */
function offlineInstallRequirements(): string {
  const lock = readFileSync(uvLockPath, 'utf8')
  const pins = new Map<string, string[]>()
  for (const block of lock.split('\n[[package]]\n')) {
    const header = /^name = "([^"]+)"\nversion = "([^"]+)"/.exec(block)
    if (header === null || header[1] === undefined || header[2] === undefined
      || !(RUNTIME_LOCK_PACKAGES as readonly string[]).includes(header[1])) continue
    for (const wheel of block.matchAll(/\{ url = "(https:\/\/files\.pythonhosted\.org\/[^"]+\.whl)", hash = "sha256:([0-9a-f]{64})"/g)) {
      const url = wheel[1]
      const digest = wheel[2]
      if (url === undefined || digest === undefined) continue
      const filename = url.split('/').pop() ?? ''
      if (!filename.endsWith('-py3-none-any.whl') && !/-cp3\d+-cp3\d+-(manylinux[0-9_]*_x86_64(\.manylinux[0-9_]*_x86_64)*|musllinux_1_[12]_x86_64)\.whl$/.test(filename)) continue
      const pin = `${header[1]}==${header[2]}`
      pins.set(pin, [...pins.get(pin) ?? [], `--hash=sha256:${digest}`])
    }
  }
  const requirements = [...pins.entries()].map(([pin, hashes]) => `${pin} ${hashes.join(' ')}`)
  if (requirements.length !== RUNTIME_LOCK_PACKAGES.length) {
    throw new Error(`python-sdk-env: uv.lock runtime closure incomplete: ${requirements.join('; ')}`)
  }
  return requirements.join('\n') + '\n'
}

/** Persistent venv location: keyed by the uv.lock digest so concurrent CI jobs share one build per lock revision. */
function cachedVenvDirectory(): string | undefined {
  const findLinks = process.env.PIP_FIND_LINKS
  if (findLinks === undefined || findLinks === '') return undefined
  const cacheRoot = process.env.PANEDESK_PY_SDK_VENV_CACHE
    ?? (process.env.HOME !== undefined && process.env.HOME !== '' ? join(process.env.HOME, '.cache', 'panedesk', 'py-sdk-venv') : undefined)
  if (cacheRoot === undefined) {
    throw new Error('python-sdk-env: offline seed mode requires HOME or PANEDESK_PY_SDK_VENV_CACHE for the persistent venv cache')
  }
  const lockDigest = createHash('sha256').update(readFileSync(uvLockPath)).digest('hex').slice(0, 16)
  return join(cacheRoot, lockDigest)
}

/**
 * Resolve an interpreter that can import the Python SDK, building a locked venv under the
 * repository cache directory when no prepared environment exists. Installation failures
 * fail the test instead of skipping it.
 * @returns absolute or PATH-resolved interpreter executable.
 */
export async function pythonSdkInterpreter(): Promise<string> {
  const existing = candidateInterpreters().find(importableBySdk)
  if (existing !== undefined) return existing
  const cached = cachedVenvDirectory()
  const venv = process.env.UV_PROJECT_ENVIRONMENT ?? cached ?? join(repositoryRoot, 'tmp/py-sdk-venv')
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  mkdirSync(venv, { recursive: true })
  await withFileLock(join(venv, '.tool-fs-test.lock'), async () => {
    if (importableBySdk(python)) return
    const created = run('python3', ['-m', 'venv', venv])
    if (created.status !== 0) throw new Error(`python-sdk-env: venv creation failed: ${created.stderr}`)
    const installed = cached !== undefined
      ? installOffline(python, venv)
      : run(python, ['-m', 'pip', 'install', '--no-input', '--quiet', LOCKED_PYDANTIC])
    if (installed.status !== 0) throw new Error(`python-sdk-env: locked dependency install failed: ${installed.stderr}`)
    if (!importableBySdk(python)) throw new Error('python-sdk-env: installed environment cannot import the SDK')
  })
  if (!existsSync(python)) throw new Error(`python-sdk-env: expected interpreter at ${python}`)
  return python
}

/** Install the locked closure from the offline seed directory; never falls back to the network. */
function installOffline(python: string, venv: string): { status: number | null; stderr: string } {
  const requirementsPath = join(venv, '.requirements-lock.txt')
  writeFileSync(requirementsPath, offlineInstallRequirements(), 'utf8')
  return run(python, ['-m', 'pip', 'install', '--no-input', '--quiet', '--no-index',
    '--find-links', process.env.PIP_FIND_LINKS ?? '', '--require-hashes', '-r', requirementsPath])
}
