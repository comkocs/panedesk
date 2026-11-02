/** Isolated Python SDK test environment shared by specs that execute the Python SDK. */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock } from '@panedesk/dsh-atomic-write'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
/** Runtime closure pin mirrored from `python/sdk/uv.lock`; bump both together. */
const LOCKED_PYDANTIC = 'pydantic==2.13.5'

function importableBySdk(python: string): boolean {
  const probe = spawnSync(python, ['-B', '-c', 'import deepseek_harness'], {
    env: { ...process.env, PYTHONPATH: join(repositoryRoot, 'python/sdk/src') },
    stdio: 'ignore',
  })
  return probe.status === 0
}

function candidateInterpreters(): string[] {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  const environment = process.env.UV_PROJECT_ENVIRONMENT ?? join(repositoryRoot, 'tmp/py-sdk-venv')
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
 * Resolve an interpreter that can import the Python SDK, building a locked venv under the
 * repository cache directory when no prepared environment exists. Installation failures
 * fail the test instead of skipping it.
 * @returns absolute or PATH-resolved interpreter executable.
 */
export async function pythonSdkInterpreter(): Promise<string> {
  const existing = candidateInterpreters().find(importableBySdk)
  if (existing !== undefined) return existing
  const venv = process.env.UV_PROJECT_ENVIRONMENT ?? join(repositoryRoot, 'tmp/py-sdk-venv')
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  mkdirSync(venv, { recursive: true })
  await withFileLock(join(venv, '.tool-fs-test.lock'), async () => {
    if (importableBySdk(python)) return
    const created = run('python3', ['-m', 'venv', venv])
    if (created.status !== 0) throw new Error(`python-sdk-env: venv creation failed: ${created.stderr}`)
    const installed = run(python, ['-m', 'pip', 'install', '--no-input', '--quiet', LOCKED_PYDANTIC])
    if (installed.status !== 0) throw new Error(`python-sdk-env: locked dependency install failed: ${installed.stderr}`)
    if (!importableBySdk(python)) throw new Error('python-sdk-env: installed environment cannot import the SDK')
  })
  if (!existsSync(python)) throw new Error(`python-sdk-env: expected interpreter at ${python}`)
  return python
}
