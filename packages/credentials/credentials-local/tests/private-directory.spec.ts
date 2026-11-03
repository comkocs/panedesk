/** Upgrade preserves saved credentials while removing the publicly readable legacy location. */
import { Context } from '@panedesk/cordis'
import { credentialRef } from '@panedesk/dsh-credentials'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { LocalCredentialProvider, resolveSpec } from '../src/index.ts'

it('moves the default document into a private directory and preserves saved login material', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-private-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const legacy = join(home, '.credentials.yaml')
  const text = 'version: 1\nrefs:\n  SYNTHETIC_LOGIN: saved\n'
  await writeFile(legacy, text, { mode: 0o600 })
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  onTestFinished(() => fiber.dispose())
  await fiber
  const destination = join(home, 'private', '.credentials.yaml')
  expect(resolveSpec({ dshHome: home }).filename).toBe(destination)
  expect(await readFile(destination, 'utf8')).toBe(text)
  await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await ctx.credentials.resolve(credentialRef('SYNTHETIC_LOGIN'))).toEqual({ value: 'saved', source: 'file' })
  expect(ctx.credentials.protectedStoragePaths).toEqual([join(home, 'private')])
  if (process.platform !== 'win32') expect((await stat(join(home, 'private'))).mode & 0o777).toBe(0o700)
})

it.each(['directory-created', 'copy-published', 'copy-verified', 'legacy-removed'] as const)(
  'resumes a relocation interrupted after %s without losing or duplicating credentials', async (stage) => {
    const home = await mkdtemp(join(tmpdir(), 'credential-resume-'))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    const legacy = join(home, '.credentials.yaml')
    const destination = join(home, 'private', '.credentials.yaml')
    const text = 'version: 1\nrefs:\n  SYNTHETIC_LOGIN: saved\n'
    await mkdir(join(home, 'private'), { mode: 0o700 })
    if (stage !== 'legacy-removed') await writeFile(legacy, text, { mode: 0o600 })
    if (stage !== 'directory-created') await writeFile(destination, text, { mode: 0o600 })
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
    onTestFinished(() => fiber.dispose())
    await fiber
    expect(await readFile(destination, 'utf8')).toBe(text)
    await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await ctx.credentials.resolve(credentialRef('SYNTHETIC_LOGIN'))).toEqual({ value: 'saved', source: 'file' })
  },
)

it('creates an empty private directory before any credential is stored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-empty-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'attachments'))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  onTestFinished(() => fiber.dispose())
  await fiber
  expect((await stat(join(home, 'private'))).isDirectory()).toBe(true)
  expect(ctx.credentials.protectedStoragePaths).not.toContain(home)
})
