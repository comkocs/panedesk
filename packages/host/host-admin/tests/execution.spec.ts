/** Missing audit adapters cannot fall back to unaudited approval. */
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, expectTypeOf, test } from 'vitest'
import * as Admin from '../src/index.ts'
import { callAdmin } from '../src/client.ts'
import { PosixPrivateFiles } from '../src/private-files.ts'

test('refuses approval without an executor instead of calling a legacy engine entry', async () => {
  expectTypeOf<Admin.HostAdminExecutionAdapter['create']>().returns.toEqualTypeOf<Admin.HostAdminExecutor>()
  const root = await mkdtemp(join(process.env.TEST_RESOURCE_ROOT!, 'admin-seam-'))
  const ctx = new Context()
  const limits = { maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 4 }
  try {
    await ctx.plugin(Admin, { runtime: { ...limits, directory: root, nodeId: 'node-a',
      principalId: 'operator-a', port: 0, maxStoreBytes: 65536, maxOperations: 100 } })
    const files = new PosixPrivateFiles(root, process.getuid!())
    await expect.poll(async () => files.read('endpoint.json', 4096)).not.toBeNull()
    expect(ctx.get('hostAdminExecutor')).toBeUndefined()
    expect(ctx.get('seatEngine')).toBeUndefined()
    expect(await callAdmin(files, 'engine.approve', { operationId: 'operation-a', queueItemId: 'queue-a',
      expectedStateVersion: 1 }, limits)).toMatchObject({ status: 'rejected', code: 'admin-method-unavailable' })
    expect(ctx.get('seatEngine')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
