/** Workspace grants survive restart, stay private, and revoke before disappearing. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '@panedesk/dsh-atomic-write'
import { WorkspaceWriteAccess } from '../src/workspace-access.ts'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'workspace-access-'))
  scratch.push(home)
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  return { home, workspace, access: new WorkspaceWriteAccess(home) }
}

describe('workspace write authorization records', () => {
  it('refuses to store owner consent inside its writable workspace', async () => {
    const { workspace } = fixture()
    const access = new WorkspaceWriteAccess(join(workspace, 'owner-state'))
    await expect(access.authorize(workspace, 'first-confirmation')).rejects.toThrow('outside the writable workspace')
    expect(access.find(workspace)).toBeUndefined()
  })
  it('records consent for a workspace containing protected inputs without authorizing those inputs', async () => {
    const { home, workspace } = fixture()
    const input = join(workspace, '.panedesk', 'cordis.patch.yml')
    const access = new WorkspaceWriteAccess(home, () => [input])
    await expect(access.authorize(workspace, 'first-confirmation')).resolves.toMatchObject({ workspace })
    const materialize = vi.fn(() => 'protected native profile')
    await expect(access.withAuthorization(workspace, materialize)).resolves.toBe('protected native profile')
    expect(materialize).toHaveBeenCalledOnce()
  })
  it('refuses consent when the entire workspace is a protected input', async () => {
    const { home, workspace } = fixture()
    const access = new WorkspaceWriteAccess(home, () => [workspace])
    await expect(access.authorize(workspace, 'settings-preauthorization')).rejects.toThrow('protected host path')
    expect(access.find(workspace)).toBeUndefined()
  })
  it('starts absent and records canonical workspace, time, and first-confirmation source', async () => {
    const { home, workspace, access } = fixture()
    expect(access.find(workspace)).toBeUndefined()
    const record = await access.authorize(workspace, 'first-confirmation')
    expect(record.grantedAt).toEqual(expect.any(String))
    expect(record).toEqual({ workspace, grantedAt: record.grantedAt, source: 'first-confirmation' })
    expect(new WorkspaceWriteAccess(home).find(join(workspace, '.'))).toEqual(record)
    expect(access.list()).toEqual([record])
  })
  it('keeps independent preauthorizations and stores no executable content', async () => {
    const { home, workspace, access } = fixture()
    const other = join(home, 'other')
    mkdirSync(other)
    await Promise.all([access.authorize(workspace, 'settings-preauthorization'), access.authorize(other, 'settings-preauthorization')])
    expect(access.list()).toHaveLength(2)
    const file = access.recordPath(workspace)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(access.find(workspace))
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('removes the record only after the ACL revocation succeeds', async () => {
    const { workspace, access } = fixture()
    await access.authorize(workspace, 'first-confirmation')
    const revoke = vi.fn(() => { throw new Error('ACL unavailable') })
    await expect(access.revoke(workspace, revoke)).rejects.toThrow('ACL unavailable')
    expect(access.find(workspace)).toBeDefined()
    await access.revoke(workspace, () => {})
    expect(access.find(workspace)).toBeUndefined()
  })
  it('withdraws effective permission before native revocation and keeps a failed revoke blocked', async () => {
    const { home, workspace, access } = fixture()
    await access.authorize(workspace, 'first-confirmation')
    let effectiveDuringRevoke = true
    await expect(access.revoke(workspace, () => {
      effectiveDuringRevoke = access.isAuthorized(workspace)
      throw new Error('native unavailable')
    })).rejects.toThrow('native unavailable')
    expect(effectiveDuringRevoke).toBe(false)
    expect(new WorkspaceWriteAccess(home).isAuthorized(workspace)).toBe(false)
    expect(access.list()).toHaveLength(1)
    await expect(access.authorize(workspace, 'settings-preauthorization')).rejects.toThrow('revocation')
    await access.revoke(workspace, () => {})
    await access.authorize(workspace, 'settings-preauthorization')
    expect(access.find(workspace)).toBeDefined()
  })
  it('coordinates authorization and revocation with other product-home writers', async () => {
    const { workspace, access } = fixture()
    await access.authorize(workspace, 'first-confirmation')
    let release: () => void = () => {}
    let acquired: () => void = () => {}
    const ready = new Promise<void>((resolve) => { acquired = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const holder = withFileLock(access.recordPath(workspace), async () => { acquired(); await held })
    await ready
    const revoke = vi.fn()
    let authorized = false
    const authorizing = access.authorize(workspace, 'settings-preauthorization').then(() => { authorized = true })
    const revoking = access.revoke(workspace, revoke)
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(authorized).toBe(false)
      expect(revoke).not.toHaveBeenCalled()
    } finally {
      release()
      await Promise.all([holder, authorizing, revoking])
    }
  })
  it('serializes native materialization with revocation and rechecks consent after waiting', async () => {
    const { home, workspace, access } = fixture()
    await access.authorize(workspace, 'settings-preauthorization')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const order: string[] = []
    const materializing = access.withAuthorization(workspace, async () => {
      order.push('materializing')
      entered.resolve(undefined)
      await release.promise
      order.push('materialized')
    })
    await entered.promise
    const other = new WorkspaceWriteAccess(home)
    const revoking = other.revoke(workspace, () => { order.push('revoked') })
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(order).toEqual(['materializing'])
    } finally {
      release.resolve(undefined)
      await Promise.all([materializing, revoking])
    }
    expect(order).toEqual(['materializing', 'materialized', 'revoked'])
    const forbidden = vi.fn()
    await expect(access.withAuthorization(workspace, forbidden)).rejects.toThrow('authorization')
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('does not materialize when consent disappears during lock contention', async () => {
    const { workspace, access } = fixture()
    await access.authorize(workspace, 'first-confirmation')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const holding = withFileLock(access.recordPath(workspace), async () => {
      entered.resolve(undefined)
      await release.promise
      rmSync(access.recordPath(workspace))
    })
    await entered.promise
    const materialize = vi.fn()
    const result = access.withAuthorization(workspace, materialize)
    const rejected = expect(result).rejects.toThrow('authorization')
    release.resolve(undefined)
    await holding
    await rejected
    expect(materialize).not.toHaveBeenCalled()
  })
  it('retains orphan revocation markers across restart until retry completes', async () => {
    const { home, workspace, access } = fixture()
    await expect(access.revoke(workspace, () => { throw new Error('ACL unavailable') })).rejects.toThrow('ACL unavailable')
    expect(access.list()).toEqual([])
    expect(new WorkspaceWriteAccess(home).pendingRevocations()).toEqual([workspace])
    expect(access.isAuthorized(workspace)).toBe(false)
    await access.revoke(workspace, () => {})
    expect(access.pendingRevocations()).toEqual([])
  })
  it('rejects a revocation marker whose directory does not match its filename', async () => {
    const { home, workspace, access } = fixture()
    await expect(access.revoke(workspace, () => { throw new Error('ACL unavailable') })).rejects.toThrow('ACL unavailable')
    writeFileSync(`${access.recordPath(workspace)}.revoking`, JSON.stringify({ workspace: home }))
    expect(() => access.pendingRevocations()).toThrow('Invalid workspace revocation identity')
  })
  it('removes consent for a deleted directory without invoking native ACL operations', async () => {
    const { workspace, access } = fixture()
    await access.authorize(workspace, 'settings-preauthorization')
    rmSync(workspace, { recursive: true })
    const revoke = vi.fn()
    await access.revoke(workspace, revoke)
    expect(revoke).not.toHaveBeenCalled()
    expect(access.list()).toEqual([])
    mkdirSync(workspace)
    expect(access.isAuthorized(workspace)).toBe(false)
  })
  it('completes an orphan revocation after its directory was deleted', async () => {
    const { workspace, access } = fixture()
    await expect(access.revoke(workspace, () => { throw new Error('native unavailable') })).rejects.toThrow('native unavailable')
    rmSync(workspace, { recursive: true })
    const revoke = vi.fn()
    await access.revoke(workspace, revoke)
    expect(revoke).not.toHaveBeenCalled()
    expect(access.pendingRevocations()).toEqual([])
  })
  it('does not follow a replacement symlink when revoking a recorded directory', async () => {
    const { home, workspace, access } = fixture()
    await access.authorize(workspace, 'settings-preauthorization')
    const other = join(home, 'replacement')
    mkdirSync(other)
    rmSync(workspace, { recursive: true })
    symlinkSync(other, workspace, 'junction')
    const revoke = vi.fn()
    await expect(access.revoke(workspace, revoke)).rejects.toThrow('identity changed')
    expect(revoke).not.toHaveBeenCalled()
    expect(access.list()).toHaveLength(1)
  })
  it('does not discard consent when its directory is replaced by a dangling symlink', async () => {
    const { home, workspace, access } = fixture()
    await access.authorize(workspace, 'settings-preauthorization')
    rmSync(workspace, { recursive: true })
    symlinkSync(join(home, 'missing'), workspace, 'junction')
    const revoke = vi.fn()
    await expect(access.revoke(workspace, revoke)).rejects.toThrow()
    expect(revoke).not.toHaveBeenCalled()
    expect(access.list()).toHaveLength(1)
  })
  it('does not discard consent through a replaced ancestor with a missing child', async () => {
    const { home, workspace, access } = fixture()
    const child = join(workspace, 'child')
    mkdirSync(child)
    await access.authorize(child, 'settings-preauthorization')
    const other = join(home, 'replacement')
    mkdirSync(other)
    rmSync(workspace, { recursive: true })
    symlinkSync(other, workspace, 'junction')
    const revoke = vi.fn()
    await expect(access.revoke(child, revoke)).rejects.toThrow('identity changed')
    expect(revoke).not.toHaveBeenCalled()
    expect(access.list()).toHaveLength(1)
  })
  it('revokes legacy ACLs even without an authorization record', async () => {
    const { workspace, access } = fixture()
    const revoke = vi.fn()
    await access.revoke(workspace, revoke)
    expect(revoke).toHaveBeenCalledWith(workspace)
    expect(access.list()).toEqual([])
  })
})
