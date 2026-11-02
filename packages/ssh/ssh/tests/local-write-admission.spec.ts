/** The real helper cannot mutate this host's live inputs through a loopback SSH transport. */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SshConnection } from '../src/index.ts'
import { runSshHelper } from '../src/helper.ts'
import { targetSchema, writeResultSchema } from '../src/schemas.ts'
import type {} from '@panedesk/dsh-app-boot'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), networkInterfaces: () => ({
  test: [{ address: '192.0.2.17', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.0.2.17/24' }],
}) }))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill(): boolean { queueMicrotask(() => { this.emit('close', 0, null) }); return true }
}

for (const target of [
  { name: 'loopback alias', host: 'loopback-alias', address: '127.23.45.67', local: true },
  { name: 'interface alias', host: 'interface-alias', address: '192.0.2.17', local: true },
  { name: 'direct interface', host: '192.0.2.17', address: '192.0.2.17', local: true },
  { name: 'mapped interface', host: 'mapped-alias', address: '::ffff:c000:211', local: true },
  { name: 'remote control', host: 'remote-alias', address: '192.0.2.18', local: false },
]) {
  it(`denies executable input writes through ${target.name} only when local`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-host-input-'))
    const ctx = new Context()
    const child = new Child()
    const controller = new AbortController()
    const entryPath = fileURLToPath(new URL('../src/helper-entry.ts', import.meta.url))
    vi.stubEnv('SSH_CONNECTION', `192.0.2.1 12345 ${target.address} 22`)
    const serving = runSshHelper({ input: child.stdin, output: child.stdout, kind: 'node-script', entryPath, signal: controller.signal })
    void serving.catch(() => {})
    transport.spawn.mockReturnValue(child)
    const service = new SshConnection(ctx, {
      host: target.host, launch: { kind: 'node-script', node: process.execPath }, helper: entryPath,
      helperHash: createHash('sha256').update(readFileSync(entryPath)).digest('hex'), workspace: root,
      requestTimeoutMs: 5000, maxFrameBytes: 65536, maxPending: 8, leaseMs: 30_000,
    })
    onTestFinished(async () => {
      await service.dispose(); controller.abort(); await serving; await ctx.fiber.dispose()
      vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
    })
    await service.ready
    const profile = join(root, 'profile')
    mkdirSync(profile)
    const filename = join(profile, 'cordis.patch.yml')
    writeFileSync(filename, '[]\n')
    ctx.provide('profileContext', {
      name: 'active', dir: profile, patchPath: filename, home: join(root, 'home'), cwd: root,
      installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
    const resolved = await service.request('fs.resolve', { path: filename }, targetSchema)
    const write = service.request('fs.write', {
      target: resolved, content: '- name: ./model-plugin.mjs\n', policy: { mode: 'workspace-write', workspaceRoot: root },
    }, writeResultSchema)
    if (target.local) {
      await expect(write).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(readFileSync(filename, 'utf8')).toBe('[]\n')
    } else {
      await write
      expect(readFileSync(filename, 'utf8')).toBe('- name: ./model-plugin.mjs\n')
    }
  })
}
