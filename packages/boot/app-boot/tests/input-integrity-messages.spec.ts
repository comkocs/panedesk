/** Mutable message trees retain the same structural checks as other host authorities. */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

for (const platform of ['linux', 'darwin'] as const) {
  for (const operation of ['capture', 'verify'] as const) {
    it.each(['root-link', 'group-write', 'outside-link', 'outside-hard-link'] as const)(
      `rejects an unsafe messages %s during ${platform} ${operation}`, async (change) => {
        const workspace = mkdtempSync(join(tmpdir(), 'message-structure-'))
        onTestFinished(() => { vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }) })
        const home = join(workspace, '.panedesk')
        const tree = join(home, 'messages')
        mkdirSync(tree, { recursive: true, mode: 0o700 })
        writeFileSync(join(tree, 'initial.json'), 'host state', { mode: 0o600 })
        const integrity = new ProtectedInputIntegrity(workspace, home)
        integrity.observe(home)
        const owner = { blocked: vi.fn(), confirm: vi.fn(async () => false) }
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
        if (operation === 'verify') await integrity.grantWrite([home])
        const outside = join(workspace, 'outside')
        mkdirSync(outside, { mode: 0o700 })
        if (change === 'root-link') {
          renameSync(tree, join(outside, 'moved'))
          symlinkSync(join(outside, 'moved'), tree, 'dir')
        } else if (change === 'group-write') chmodSync(join(tree, 'initial.json'), 0o660)
        else if (change === 'outside-link') symlinkSync(outside, join(tree, 'escape'), 'dir')
        else linkSync(join(tree, 'initial.json'), join(outside, 'alias'))
        const result = operation === 'capture' ? integrity.grantWrite([home]) : integrity.verify(owner)
        await expect(result).rejects.toThrow('Protected authoritative home tree')
        expect(owner.confirm).not.toHaveBeenCalled()
      },
    )
  }
}
