/** The shared profile launcher reports startup before owner review and never composes denied inputs. */
import { createLaunchEnvironmentSnapshot } from '@panedesk/dsh-launch-environment'
import { ProtectedInputIntegrity, boot } from '@panedesk/dsh-app-boot'
import { installProxyFromEnvironment } from '@panedesk/dsh-http-proxy'
import { afterEach, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@panedesk/dsh-app-boot', async original => ({
  ...await original<typeof import('@panedesk/dsh-app-boot')>(), boot: vi.fn(),
}))
vi.mock('@panedesk/dsh-http-proxy', () => ({ installProxyFromEnvironment: vi.fn() }))
afterEach(() => { vi.restoreAllMocks() })

it('prints the startup banner before review output and propagates bilingual stalled refusal', async () => {
  const output: string[] = []
  const dispose = vi.fn(() => Promise.resolve())
  vi.mocked(installProxyFromEnvironment).mockResolvedValue(dispose)
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => { output.push(String(value)); return true })
  vi.spyOn(ProtectedInputIntegrity, 'openOwnerRecordsAsync').mockImplementation(async (_workspace, _home, report) => {
    report?.('Panedesk starting / Panedesk 正在启动')
    report?.('Reviewing protected host inputs / 正在复核受保护宿主输入')
    throw new Error('Protected host input review stalled / 受保护宿主输入复核卡住')
  })
  await expect(runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: 'headless', patchFiles: [], args: [] }))
    .rejects.toThrow('review stalled / 受保护宿主输入复核卡住')
  expect(output).toEqual([
    'Panedesk starting / Panedesk 正在启动\n',
    'Reviewing protected host inputs / 正在复核受保护宿主输入\n',
  ])
  expect(boot).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})
