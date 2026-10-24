/** Authenticated administration drives the original approval with a real issued fact. */
import { expect, test } from 'vitest'
import { join } from 'node:path'
import { harness, trigger } from '../../../seat/seat-engine/tests/fixtures.ts'
import { mountAdmin } from '../src/runtime.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { callAdmin } from '../src/client.ts'
import { decodeRequest } from '../src/codec.ts'
import { HOST_ADMIN_VERSION, HOST_ADMIN_METHODS, type HostAdminAuthority } from '../src/index.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
test('authenticates local approval, rejects a self-declared operator and recovers attribution', async () => {
  const h = await harness()
  let stop: (() => Promise<void>) | undefined
  try {
    const accepted = await h.engine.accept(trigger())
    expect(accepted.status).toBe('accepted')
    const pending = (await h.engine.pending({ limit: 10 })).items[0]!
    const directory = join(h.home, 'admin')
    stop = await mountAdmin(h.ctx, { runtime: { ...limits, directory, nodeId: 'node-a', principalId: 'operator-a',
      port: 0, maxStoreBytes: 1048576, maxOperations: 100 } })
    const files = new PosixPrivateFiles(directory, process.getuid!())
    const endpoint = JSON.parse((await files.read('endpoint.json', 4096))!) as { processEpoch: string }
    const params = { operationId: 'approve-authenticated', queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion }
    const fake: HostAdminAuthority = { principalId: 'operator-a' as HostAdminAuthority['principalId'],
      authorizationRef: 'self-declared' as HostAdminAuthority['authorizationRef'], kind: 'local-operator', methods: HOST_ADMIN_METHODS }
    const request = decodeRequest({ version: HOST_ADMIN_VERSION, method: 'engine.approve', params,
      processEpoch: endpoint.processEpoch, requestId: 'forged-request', nonce: 'forged-nonce' })
    expect(await h.ctx.get('hostAdmin')!.dispatch(request, fake)).toMatchObject({ status: 'rejected', code: 'admin-unauthorized' })
    expect(await h.engine.authorizations.query({ limit: 10 })).toMatchObject({ facts: [] })
    expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ status: 'ok', result: { status: 'approved' } })
    expect(await callAdmin(files, 'engine.approve', params, limits)).toMatchObject({ status: 'ok', result: { status: 'approved' } })
    expect(await h.ctx.get('hostAdmin')!.dispatch(request, fake)).toMatchObject({ status: 'rejected', code: 'admin-unauthorized' })
    const frames = h.engine.journal.projection.authorizationDecisions.filter(frame =>
      frame.effects.some(effect => effect.kind === 'authorization/checked'))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.effects.map(effect => effect.kind)).toEqual(['queue/approved', 'authorization/checked'])
    const before = await h.engine.authorizations.query({ kind: 'local-operator', limit: 10 })
    expect(before).toMatchObject({ facts: [{ principalId: 'operator-a', operationId: params.operationId }] })
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    await stop(); stop = undefined
    await h.engine.shutdown()
    const restarted = await h.start()
    const after = await restarted.authorizations.query({ kind: 'local-operator', limit: 10 })
    if ('status' in before || 'status' in after) throw new Error('Expected authorization pages')
    expect(after.facts).toEqual(before.facts)
  } finally { await stop?.(); await h.close() }
})
