/** Directional credential overlap is bounded and authenticated epochs survive handshakes. */
import { afterEach, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callLoopback, listenAuthenticatedLoopback, PosixPrivateFiles } from '@panedesk/dsh-host-admin'
import { loadCredential } from '../src/credentials.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 4 }

test('accepts both epochs during overlap and rejects the expired epoch without restarting', async () => {
  const old = { epoch: 'old-epoch', credential: randomBytes(32).toString('hex') }
  const current = { epoch: 'current-epoch', credential: randomBytes(32).toString('hex'),
    previous: [{ ...old, expiresAt: Date.now() + 60000 }] }
  const listener = await listenAuthenticatedLoopback(0, limits, () => current, async (_value, epoch) => ({ epoch }))
  cleanup.push(() => listener.close())
  expect(await callLoopback(listener.port, old, {}, limits)).toEqual({ epoch: old.epoch })
  expect(await callLoopback(listener.port, current, {}, limits)).toEqual({ epoch: current.epoch })
  current.previous[0]!.expiresAt = Date.now() - 1
  await expect(callLoopback(listener.port, old, {}, limits)).rejects.toThrow('RPC request refused')
  expect(await callLoopback(listener.port, current, {}, limits)).toEqual({ epoch: current.epoch })
})

test('refuses unconfigured or excessive overlap and validates directional files on every reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rotation-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const files = new PosixPrivateFiles(root, process.getuid!())
  const credential = { sourceNodeId: 'node-a', targetNodeId: 'node-b', epoch: 'new-epoch',
    credential: randomBytes(32).toString('hex'), previous: [{ epoch: 'old-epoch',
      credential: randomBytes(32).toString('hex'), expiresAt: Date.now() + 60000 }] }
  await files.write('inbound.json', JSON.stringify(credential))
  await expect(loadCredential(files, 'inbound', 'node-a', 'node-b')).rejects.toThrow('Channel overlap exceeds configured bound')
  expect((await loadCredential(files, 'inbound', 'node-a', 'node-b', 60000)).previous).toHaveLength(1)
  await expect(loadCredential(files, 'inbound', 'node-b', 'node-a', 60000)).rejects.toThrow('Channel credential rejected')
  credential.previous[0]!.expiresAt = Date.now() - 1
  await files.write('inbound.json', JSON.stringify(credential))
  expect((await loadCredential(files, 'inbound', 'node-a', 'node-b')).previous).toEqual([])
})
