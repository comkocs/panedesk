/** Host mailbox registration remains outside protected input content comparisons. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { serviceFixture } from './fixtures/persistence.ts'

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'message-input-review-'))
  onTestFinished(() => rm(workspace, { recursive: true, force: true }))
  const home = join(workspace, '.panedesk')
  await mkdir(home, { mode: 0o700 })
  const service = await serviceFixture(home)
  onTestFinished(() => service.dispose())
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(home)
  await integrity.grantWrite([home])
  const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
  return { ...service, workspace, home, integrity, owner }
}

it('accepts the next review after the host registers a mailbox through agent creation', async () => {
  const f = await fixture()
  const mailboxes = join(f.home, 'messages', 'nodes', 'node-a', 'mailboxes')
  expect(await readdir(mailboxes)).toEqual([])
  await f.resume()
  expect(await readdir(mailboxes)).toEqual([f.session.id])
  await expect(f.integrity.verify(f.owner)).resolves.toBe(true)
  expect(f.owner.blocked).not.toHaveBeenCalled()
  expect(f.owner.confirm).not.toHaveBeenCalled()
})

it('rejects an unlisted product-home input outside messages', async () => {
  const f = await fixture()
  await writeFile(join(f.home, 'unlisted.json'), 'unapproved', { mode: 0o600 })
  await expect(f.integrity.verify(f.owner)).resolves.toBe(false)
  expect(f.owner.blocked).toHaveBeenCalledOnce()
  expect(f.owner.confirm).toHaveBeenCalledOnce()
})
