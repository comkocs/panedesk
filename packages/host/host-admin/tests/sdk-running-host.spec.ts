/** Real loopback requests from separate SDK processes carry only host-issued authority. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Admin from '../src/index.ts'
import { SdkMethodRegistryProvider } from '@panedesk/dsh-sdk-jsonrpc-server'
import { JsonRpcResponseError } from '@panedesk/dsh-sdk-protocol'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { expect, test } from 'vitest'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callHostSdk } from '../src/sdk-client.ts'
import { SessionCredentials } from '../src/session-credentials.ts'
import { mountAdmin } from '../src/runtime.ts'
import { callLoopback } from '../src/loopback.ts'
import type { HostSessionBinding } from '../src/sdk.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
async function peer(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output += chunk })
  let errorOutput = ''
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolveExit()
      else reject(new Error(`SDK test peer failed (${command}, code ${code}, signal ${signal}): ${errorOutput}`))
    })
  })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 15000)
  try { await exited; return JSON.parse(output) } finally { clearTimeout(timer) }
}

test('dispatches registered namespaces across TS and Python processes with host binding and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-sdk-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = `${pathToFileURL(directory).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, admin: Admin, registry: SdkMethodRegistryProvider })
    const profile = join(directory, 'cordis.yml')
    await writeFile(profile, JSON.stringify([{ name: 'cordis:registry' }, { name: 'cordis:admin',
      config: { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
        port: 0, maxStoreBytes: 1048576, maxOperations: 100 } } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
    await expect.poll(() => ctx.get('hostSessionCredentials')).toBeDefined()
    const definition = {
      decodeRequest: (_value: unknown) => ({}),
      encodeResult: (value: { sessionId: string | null; seat: string | null }) => value,
      invoke: async (_params: object, context: import('@panedesk/dsh-sdk-jsonrpc-server').SdkMethodContext) =>
        ({ sessionId: context.sessionId ?? null, seat: context.seat ?? null }),
    }
    const unregister = ctx.get('sdkMethods')!.register({ namespace: 'example', version: '1',
      methods: { read: definition, write: definition,
        invalid: { ...definition, decodeRequest: () => { throw new JsonRpcResponseError(-32602, 'Invalid test request') } } },
      authorize: async (identity, method) => method === 'write' && identity.seat === undefined
        ? { status: 'rejected', code: 'unauthorized', reason: 'Seat binding required' } : { status: 'allowed' } })
    const endpointPath = join(directory, 'endpoint.json'), operatorPath = join(directory, 'credential')
    const binding: HostSessionBinding = { sessionId: 'session-a' as HostSessionBinding['sessionId'], seat: 'seat-a' as HostSessionBinding['seat'] }
    const bound = await ctx.get('hostSessionCredentials')!.issue(binding)
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const pythonEnvironment = process.env.UV_PROJECT_ENVIRONMENT ?? join(root, 'tmp/py-sdk-venv')
    const pythonExecutable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    const python = process.env.PYTHON ?? [join(pythonEnvironment, pythonExecutable),
      join(root, 'python/sdk/.venv', pythonExecutable)].find(path => existsSync(path)) ?? 'python3'
    const env = { ...process.env, PYTHONPATH: join(root, 'python/sdk/src'), TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json') }
    const clients = [
      (path: string, method: string) => peer(process.execPath, ['--import', 'tsx/esm', join(root, 'packages/sdk/client/tests/running-host-peer.ts'), endpointPath, path, method], env),
      (path: string, method: string) => peer(python, ['-B', join(root, 'python/sdk/tests/running_host_peer.py'), endpointPath, path, method], env),
    ]
    for (const call of clients) {
      expect(await call(operatorPath, 'example/read')).toEqual({ status: 'ok', result: { sessionId: null, seat: null } })
      expect(await call(operatorPath, 'example/write')).toEqual({ status: 'rejected', data: { reason: 'unauthorized' } })
      expect(await call(bound.credentialPath, 'example/write')).toEqual({ status: 'ok', result: { sessionId: 'session-a', seat: 'seat-a' } })
      expect(await call(operatorPath, 'absent/read')).toEqual({ status: 'rejected', data: { reason: 'method-unavailable' } })
      expect(await call(operatorPath, 'example/invalid')).toEqual({ status: 'rejected', data: { reason: 'invalid-params' } })
    }
    const files = new PosixPrivateFiles(directory, process.getuid!())
    const oldCredential = await new PosixPrivateFiles(resolve(bound.credentialPath, '..'), process.getuid!()).read('credential', 64)
    await files.write('old-credential', oldCredential!)
    const replacement = await ctx.get('hostSessionCredentials')!.issue(binding)
    for (const call of clients) expect(await call(join(directory, 'old-credential'), 'example/write')).toMatchObject({ status: 'rejected' })
    await replacement.revoke()
    await files.write('forged-credential', randomBytes(32).toString('hex'))
    for (const call of clients) expect(await call(join(directory, 'forged-credential'), 'example/read')).toMatchObject({ status: 'rejected' })
    const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
    const credential = (await files.read('credential', 64))!
    for (const headers of [{ origin: 'https://example.invalid' }, { cookie: 'ambient=1' }, { 'x-rpc-epoch': randomUUID() }]) {
      const status = await new Promise<number | undefined>((resolveStatus, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: endpoint.port, path: '/rpc', method: 'POST',
          headers: { authorization: credential, 'content-type': 'application/json', 'x-rpc-epoch': endpoint.processEpoch, ...headers } }, (response) => {
          response.resume(); response.on('end', () => { resolveStatus(response.statusCode) })
        })
        request.on('error', reject); request.end('{}')
      })
      expect(status).toBe(403)
    }
    await unregister()
    expect(await callHostSdk({ ...limits, endpointPath, credentialPath: operatorPath }, 'example/read', {}))
      .toEqual({ status: 'rejected', code: 'method-unavailable' })
    await chmod(operatorPath, 0o644)
    await expect(callHostSdk({ ...limits, endpointPath, credentialPath: operatorPath }, 'example/read', {})).rejects.toThrow('permissions')
    await chmod(operatorPath, 0o600)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 60000)

test('host disposal closes the listener even if a session credential file cannot be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-sdk-cleanup-'))
  const ctx = new Context()
  try {
    ctx.provide('hostAdminFiles', (path) => {
      const files = new PosixPrivateFiles(path, process.getuid!())
      return { prepare: () => files.prepare(), read: (name, size) => files.read(name, size),
        write: (name, value) => files.write(name, value), lock: () => files.lock(),
        remove: async (name) => {
          if (path !== directory) throw new Error('Test cleanup unavailable')
          await files.remove(name)
        } }
    })
    const dispose = await mountAdmin(ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { port: number; processEpoch: string }
    const credential = (await files.read('credential', 64))!
    await ctx.get('hostSessionCredentials')!.issue({ sessionId: 'cleanup' as HostSessionBinding['sessionId'],
      seat: 'seat' as HostSessionBinding['seat'] })
    await expect(dispose()).rejects.toThrow('cleanup failed')
    expect(await files.read('endpoint.json', 4096)).toBeNull()
    await expect(callLoopback(endpoint.port, { credential, epoch: endpoint.processEpoch }, {}, limits)).rejects.toThrow()
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('revocation prevents pending and replaced credentials from being published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-sdk-pending-'))
  const pending: (() => void)[] = []
  const issuer = new SessionCredentials(directory, randomUUID() as Admin.HostAdminEndpoint['processEpoch'], (path) => {
    const files = new PosixPrivateFiles(path, process.getuid!())
    return {
      prepare: () => files.prepare(), read: (name, size) => files.read(name, size),
      remove: name => files.remove(name), lock: () => files.lock(),
      write: async (name, content) => {
        await new Promise<void>((release) => { pending.push(release) })
        await files.write(name, content)
      },
    }
  })
  const binding: HostSessionBinding = { sessionId: 'pending' as HostSessionBinding['sessionId'], seat: 'seat' as HostSessionBinding['seat'] }
  try {
    const first = issuer.issue(binding)
    const firstRejected = expect(first).rejects.toThrow('revoked')
    await expect.poll(() => pending.length).toBe(1)
    const second = issuer.issue(binding)
    await expect.poll(() => pending.length).toBe(2)
    pending.shift()!()
    await firstRejected
    pending.shift()!()
    const live = await second
    expect(issuer.authentication()).toHaveLength(1)
    await live.revoke()
    expect(issuer.authentication()).toHaveLength(0)
    const third = issuer.issue(binding)
    const thirdRejected = expect(third).rejects.toThrow('revoked')
    await expect.poll(() => pending.length).toBe(1)
    await issuer.revoke(binding.sessionId)
    pending.shift()!()
    await thirdRejected
    expect(issuer.authentication()).toHaveLength(0)
    const fourth = issuer.issue(binding)
    const fourthRejected = expect(fourth).rejects.toThrow('revoked')
    await expect.poll(() => pending.length).toBe(1)
    const closing = issuer.close()
    pending.shift()!()
    await fourthRejected
    await closing
    expect(issuer.authentication()).toHaveLength(0)
  } finally {
    for (const release of pending) release()
    await issuer.close()
    await rm(directory, { recursive: true, force: true })
  }
})
