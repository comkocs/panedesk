/** `pdesk init` writes the home provider patch and stores keys without echoing them. */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { loadOptionalPatches } from '@panedesk/dsh-app-boot'
import { parseDshArgs } from '../src/args.ts'
import { runInit, type InitIo, type InitWindowsSecurity } from '../src/init.ts'

const SECRET = 'sk-init-test-value'

/** Queue-based terminal double: canned answers in prompt order, captured output. */
function queueIo(answers: readonly string[] = [], secrets: readonly string[] = []): { io: InitIo; written: string[] } {
  const written: string[] = []
  const questions = [...answers]
  const pending = [...secrets]
  return {
    written,
    io: {
      write: (text) => { written.push(text) },
      question: async () => questions.shift() ?? '',
      secret: async () => pending.shift() ?? '',
    },
  }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cli-init-'))
  vi.stubEnv('PANEDESK_HOME', home)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  onTestFinished(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, stdout, stderr }
}

/** Failing Windows security double records the owner-only calls. */
function windowsSecurity(): InitWindowsSecurity & { secured: string[]; replaced: [string, string][] } {
  const secured: string[] = []
  const replaced: [string, string][] = []
  return {
    secured,
    replaced,
    secureOwnerOnly: (path) => { secured.push(path) },
    replaceOwnerOnly: (source, target) => {
      replaced.push([source, target])
      return 0
    },
  }
}

const NONINTERACTIVE_ENV = ['--api', 'openai-completions', '--base-url', 'https://gw.example.com/v1',
  '--model', 'm1', '--provider', 'gw', '--api-key-env', 'GW_KEY']
const NONINTERACTIVE_STORE = ['--api', 'anthropic-messages', '--base-url', 'https://api.anthropic.com',
  '--model', 'claude-x', '--provider', 'anthropic', '--store-key', 'ANTHROPIC_KEY']

afterEach(() => { vi.restoreAllMocks() })

it('routes init as a launcher subcommand instead of a profile name', () => {
  expect(parseDshArgs(['init', ...NONINTERACTIVE_ENV], '1.2.3')).toEqual({ mode: 'init', args: NONINTERACTIVE_ENV })
  expect(parseDshArgs(['init'], '1.2.3')).toEqual({ mode: 'init', args: [] })
})

it('writes a home patch the launcher reads, referencing only the key name', async () => {
  const { home, stdout, stderr } = fixture()
  const { io } = queueIo()
  expect(await runInit(NONINTERACTIVE_ENV, { io })).toBe(0)
  const patchFile = join(home, 'cordis.patch.yml')
  expect(existsSync(patchFile)).toBe(true)
  const text = readFileSync(patchFile, 'utf8')
  expect(text).toContain('apiKeyEnv: GW_KEY')
  expect(text).toContain('baseURL: https://gw.example.com/v1')
  expect(text).toContain('id: agent-default-model')
  // The launcher reads the same file through its home patch layer.
  const patches = loadOptionalPatches('panedesk', patchFile)
  expect(patches).toBeInstanceOf(Array)
  expect(JSON.stringify(patches)).toContain('GW_KEY')
  expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).not.toHaveBeenCalled()
})

it('asks interactively in order and writes the same overlay', async () => {
  const { home } = fixture()
  const { io } = queueIo(
    ['2', 'https://x.example.com/v1', 'x-model', '', '1', 'XGW_KEY'],
  )
  expect(await runInit([], { io })).toBe(0)
  const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
  expect(text).toContain('api: openai-completions')
  expect(text).toContain('baseURL: https://x.example.com/v1')
  expect(text).toContain('model: x-model')
  expect(text).toContain('apiKeyEnv: XGW_KEY')
})

it('stores a typed key in the owner-only credentials document and never prints it', async () => {
  const { home, stdout, stderr } = fixture()
  const { io, written } = queueIo([], [SECRET])
  expect(await runInit(NONINTERACTIVE_STORE, { io })).toBe(0)
  const document = join(home, '.credentials.yaml')
  const text = readFileSync(document, 'utf8')
  expect(text).toContain('version: 1')
  expect(text).toContain(`ANTHROPIC_KEY: ${SECRET}`)
  // Linux/macOS: owner read and write only.
  expect(statSync(document).mode & 0o777).toBe(0o600)
  const patch = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('apiKeyEnv: ANTHROPIC_KEY')
  expect(patch).not.toContain(SECRET)
  expect(written.join('')).not.toContain(SECRET)
  expect(stdout.mock.calls.flat().join('')).not.toContain(SECRET)
  expect(stderr.mock.calls.flat().join('')).not.toContain(SECRET)
})

it('routes the credentials document through the Windows owner-only seam on win32', async () => {
  const { home } = fixture()
  const security = windowsSecurity()
  const { io } = queueIo([], [SECRET])
  expect(await runInit(NONINTERACTIVE_STORE, { io, platform: 'win32', windowsSecurity: security })).toBe(0)
  expect(security.secured).toHaveLength(1)
  expect(security.replaced).toHaveLength(1)
  expect(security.replaced[0]![1]).toBe(join(home, '.credentials.yaml'))
})

it('never widens an existing credentials document and keeps other refs', async () => {
  const { home } = fixture()
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  OTHER_KEY: other-value\n')
  const first = queueIo([], [SECRET])
  expect(await runInit(NONINTERACTIVE_STORE, { io: first.io })).toBe(0)
  const document = join(home, '.credentials.yaml')
  expect(statSync(document).mode & 0o777).toBe(0o600)
  const text = readFileSync(document, 'utf8')
  expect(text).toContain('OTHER_KEY: other-value')
  expect(text).toContain(`ANTHROPIC_KEY: ${SECRET}`)
})

it('backs up an existing home patch and preserves unrelated entries', async () => {
  const { home } = fixture()
  const patchFile = join(home, 'cordis.patch.yml')
  writeFileSync(patchFile, '- id: other-plugin\n  config:\n    x: 1\n')
  expect(await runInit(NONINTERACTIVE_ENV, { io: queueIo().io })).toBe(0)
  const afterFirst = readFileSync(patchFile, 'utf8')
  expect(afterFirst).toContain('id: other-plugin')
  const changed = ['--api', 'openai-completions', '--base-url', 'https://gw.example.com/v1',
    '--model', 'm2', '--provider', 'gw', '--api-key-env', 'GW_KEY']
  expect(await runInit(changed, { io: queueIo().io })).toBe(0)
  const backups = readdirSync(home).filter(name => /^cordis\.patch\.yml\.bak-\d+/.test(name))
  expect(backups).toHaveLength(2)
  expect(backups.filter(name => readFileSync(join(home, name), 'utf8') === afterFirst)).toHaveLength(1)
  const afterSecond = readFileSync(patchFile, 'utf8')
  expect(afterSecond).toContain('model: m2')
  expect(afterSecond).toContain('id: other-plugin')
})

it('reports invalid input without writing the patch', async () => {
  const { home, stderr } = fixture()
  const { io } = queueIo()
  const bad = ['--api', 'carrier-pigeon', '--base-url', 'https://gw.example.com/v1', '--model', 'm1']
  expect(await runInit(bad, { io })).toBe(1)
  expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false)
  expect(stderr.mock.calls.flat().join('')).toContain('carrier-pigeon')
})
