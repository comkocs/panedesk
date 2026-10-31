/** Windows Git Bash discovery and the product-level enablement the base profiles gate on. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_BASH_CONFIG_FILENAME, clearWindowsBashConfig, parseWindowsBashConfig, probeWindowsBash,
  readWindowsBashConfig, windowsBashCandidates, windowsBashConfigPath, writeWindowsBashConfig,
  type WindowsBashSource,
} from '../src/windows-bash.ts'

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LocalAppData: 'C:\\Users\\dev\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\dev',
  PANEDESK_HOME: undefined,
} as Record<string, string | undefined>

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function homeEnv(): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'windows-bash-'))
  scratch.push(dir)
  return { ...ENV, PANEDESK_HOME: dir }
}

describe('windowsBashCandidates', () => {
  it('orders installers, per-user installs, Scoop, and portable locations after their anchors', () => {
    const candidates = windowsBashCandidates(ENV)
    expect(candidates.map(row => [row.source, row.bashPath] as const)).toEqual([
      ['program-files', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      ['program-files-x86', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'],
      ['user-programs', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'],
      ['user-git', 'C:\\Users\\dev\\AppData\\Local\\Git\\bin\\bash.exe'],
      ['scoop', 'C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe'],
      ['scoop-shim', 'C:\\Users\\dev\\scoop\\shims\\bash.exe'],
      ['portable', 'C:\\Users\\dev\\PortableGit\\bin\\bash.exe'],
    ] satisfies (readonly [WindowsBashSource, string])[])
  })

  it('skips candidates whose anchor is unset and matches anchors case-insensitively', () => {
    const partial = { ...ENV, 'ProgramFiles(x86)': undefined, localappdata: ENV.LocalAppData, LocalAppData: undefined }
    expect(windowsBashCandidates(partial).map(row => row.source)).toEqual([
      'program-files', 'user-programs', 'user-git', 'scoop', 'scoop-shim', 'portable',
    ])
  })
})

describe('probeWindowsBash', () => {
  it('returns the first candidate the filesystem reports and names its family', () => {
    const scoop = 'C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe'
    const existing = new Set(['C:\\Program Files\\Git\\bin\\bash.exe'])
    expect(probeWindowsBash({ existsSync: path => existing.has(String(path)) }, ENV))
      .toEqual({ bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', source: 'program-files' })
    expect(probeWindowsBash({ existsSync: path => String(path) === scoop }, ENV)).toEqual({ bashPath: scoop, source: 'scoop' })
  })

  it('reports nothing when no candidate exists', () => {
    expect(probeWindowsBash({ existsSync: () => false }, ENV)).toBeUndefined()
  })
})

describe('WindowsBashConfig document', () => {
  it('accepts only an enabled selection with a usable path and ignores extra fields', () => {
    expect(parseWindowsBashConfig(JSON.stringify({ enabled: true, bashPath: 'C:\\Git\\bin\\bash.exe' })))
      .toEqual({ enabled: true, bashPath: 'C:\\Git\\bin\\bash.exe' })
    expect(parseWindowsBashConfig(JSON.stringify({ enabled: true, bashPath: 'C:\\Git\\bin\\bash.exe', addedLater: 1 })))
      .toEqual({ enabled: true, bashPath: 'C:\\Git\\bin\\bash.exe' })
  })

  it('reads disabled, empty-path, and non-object documents as absent so the default stands', () => {
    for (const document of [
      JSON.stringify({ enabled: false, bashPath: 'C:\\Git\\bin\\bash.exe' }),
      JSON.stringify({ enabled: true, bashPath: '' }),
      JSON.stringify({ enabled: 'yes', bashPath: 'C:\\Git\\bin\\bash.exe' }),
      'not json', 'null', '"bash"',
    ]) {
      expect(parseWindowsBashConfig(document)).toBeUndefined()
    }
  })

  it('locates the config under the harness home and reads a missing file as absent', async () => {
    const env = await homeEnv()
    expect(windowsBashConfigPath(env)).toBe(join(env.PANEDESK_HOME!, WINDOWS_BASH_CONFIG_FILENAME))
    const missing = { existsSync: () => false, readFileSync: () => { throw new Error('unreadable') } }
    expect(readWindowsBashConfig(missing, env)).toBeUndefined()
    expect(readWindowsBashConfig(undefined, env)).toBeUndefined()
  })

  it('writes after confirmation, gates on the written value, and clears back to the default', async () => {
    const env = await homeEnv()
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
    await writeWindowsBashConfig({ enabled: true, bashPath }, undefined, env)
    expect(readWindowsBashConfig(undefined, env)).toEqual({ enabled: true, bashPath })
    // The committed selection is what the base-profile gate expression reads.
    const gate = readWindowsBashConfig(undefined, env)?.enabled === true
    expect(gate).toBe(true)
    await clearWindowsBashConfig(env)
    expect(readWindowsBashConfig(undefined, env)).toBeUndefined()
  })

  it('refuses to commit a selection without a usable path', async () => {
    const env = await homeEnv()
    await expect(writeWindowsBashConfig({ enabled: true, bashPath: '' }, undefined, env)).rejects.toThrow('nonempty bashPath')
    await expect(writeWindowsBashConfig({ enabled: false, bashPath: 'C:\\Git\\bin\\bash.exe' }, undefined, env))
      .rejects.toThrow('enabled true')
    expect(readWindowsBashConfig(undefined, env)).toBeUndefined()
  })
})
