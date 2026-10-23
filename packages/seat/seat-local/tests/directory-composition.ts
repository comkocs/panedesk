/** Real Session permission projections govern additional-root writes. */
import { expect } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setSandboxMode } from '@panedesk/dsh-sandbox-policy'
import type { SessionId } from '@panedesk/dsh-session'
import type { engineFixture } from './engine-fixture.ts'
import type * as T from '@panedesk/dsh-seat'
import { operation } from './fixtures.ts'

/** Exercise registered directories through the real filesystem and mutable Session policy.
 * @param f - live engine and public services.
 * @param sessionId - created window identity.
 */
export async function checkDirectories(f: Awaited<ReturnType<typeof engineFixture>>, sessionId: SessionId): Promise<void> {
  const agent = f.ctx.agents.get(sessionId)
  if (!agent) throw new Error('Directory owner is unavailable')
  const additional = join(f.options.directory, 'additional')
  await mkdir(additional)
  const seats = f.ctx.get('seats')?.withAuthority({ principalId: 'user-a' as T.SeatPrincipalId,
    origin: 'manual', nodeId: f.options.nodeId })
  const directory = f.ctx.get('seatDirectories')
  if (!seats || !directory) throw new Error('Directory services are unavailable')
  const catalog = await seats.definitions({})
  expect(await seats.save({ definition: { ...f.definition, directories: [...f.definition.directories,
    { path: additional, startup: false }] }, expectedRevision: catalog.revision,
  operationId: operation('directory-definition') })).toMatchObject({ status: 'saved' })
  const root = (await directory.roots(sessionId)).find(item => item.kind === 'additional')
  if (!root) throw new Error('Registered additional root was not exposed')
  const request = { sessionId, rootId: root.rootId, relativePath: 'memo.txt', content: 'First', operationId: operation('directory-write') }
  expect(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
  expect(await directory.write(request)).toMatchObject({ status: 'written' })
  expect(await readFile(join(additional, 'memo.txt'), 'utf8')).toBe('First')
  setSandboxMode(agent.session, 'read-only')
  expect(await directory.write({ ...request, content: 'Blocked', operationId: operation('directory-denied') }))
    .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
  expect(await directory.read({ ...request, maxBytes: 100 })).toMatchObject({ status: 'read', content: 'First', complete: true })
  expect(await directory.write({ ...request, relativePath: '../outside.txt' }))
    .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
  setSandboxMode(agent.session, 'workspace-write')
  expect(await directory.edit({ sessionId, rootId: root.rootId, relativePath: 'memo.txt', oldText: 'First', newText: 'Second',
    operationId: operation('directory-edit') })).toMatchObject({ status: 'written' })
  expect(await readFile(join(additional, 'memo.txt'), 'utf8')).toBe('Second')
  await f.ctx.sessions.flush(agent.session)
}
