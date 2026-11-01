/** Opt-in seat surfaces use synthetic owner observations and never open an agent window. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import type SeatUi from '@panedesk/dsh-client-ui-seats'
import type {} from '@panedesk/dsh-client-ui-seat-profiles'
import type SeatApprovals from '@panedesk/dsh-client-ui-seat-approvals'
import type { PendingSeatObservation } from '@panedesk/dsh-seat'
import type { SeatDefinition } from '@panedesk/dsh-seat/types'
import type { SeatProfileSnapshot } from '@panedesk/dsh-seat-local/types'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings } from './support.ts'

it.each(['seats', 'overview', 'profiles', 'profile-import', 'profile-delete', 'add-seat', 'approvals'] as const)(
  'retains the %s seat surface across a language change', async (surface) => {
    const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false },
      extraOverlayPath: join(import.meta.dirname, 'seat-locale.overlay.yml') })
    const definition: SeatDefinition = { schemaVersion: 1, revision: 1, seat: 'fixture-seat' as SeatDefinition['seat'],
      platform: 'server', node: 'fixture-node', projectId: 'fixture-project' as SeatDefinition['projectId'],
      directories: [{ path: scaffold.workspaceCwd, startup: true }], memoryDirectories: [],
      opening: { kind: 'text', text: 'Retained draft' }, openingInstructionFiles: [], agentPreset: 'standard',
      provider: 'fixture', model: 'fixture', reasoningEffort: 'off', permissionPreset: 'read-only',
      subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 1,
      subagentContextThresholdTokens: 400000, rules: [],
      worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 } }
    const snapshot: SeatProfileSnapshot = { revision: 1, engineSequence: 1, authority: 'seat-store',
      definitions: [definition], windows: [], pending: [], recentOpen: {} }
    const seatUi = scaffold.ctx.get('seatUi') as SeatUi
    const overview = vi.spyOn(seatUi, 'overview').mockResolvedValue({ available: true,
      complete: true, definitions: [definition], windows: [] })
    const dashboard = vi.spyOn(seatUi, 'dashboard').mockResolvedValue(snapshot)
    const profiles = vi.spyOn(scaffold.ctx.seatProfiles, 'read').mockResolvedValue(snapshot)
    const approvals = vi.spyOn(scaffold.ctx.get('seatApprovals') as SeatApprovals, 'watchPending')
      .mockImplementation(async function* (signal) {
        const item: PendingSeatObservation = { queueItemId: 'fixture-pending' as PendingSeatObservation['queueItemId'],
          seat: definition.seat, projectId: definition.projectId, triggerKind: 'external', action: 'open', sequence: 1,
          effectiveMode: 'remind', reason: 'provider-unavailable', blockedBy: [], sources: [], relatedTaskIds: [],
          queuedAt: '2026-01-01T00:00:00Z', stateVersion: 1,
          retention: { since: 0, deadline: 900000, remainingMs: 300000, phase: 'expiring' } }
        yield { enabled: true, items: [item], complete: true }
        if (!signal.aborted) await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'en-US' })
      const consoleWatch = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor()
      const show = async (language: 'en' | 'zh'): Promise<void> => {
        const chinese = language === 'zh'
        if (surface === 'approvals') {
          await page.getByRole('button', { name: chinese ? '可开 1 窗' : '1 windows ready for approval', exact: true }).click()
          await page.getByRole('dialog', { name: chinese ? '待批开窗' : 'Pending window approvals', exact: true }).waitFor()
          await page.getByText(chinese ? '暂态保留中' : 'Temporarily retained', { exact: true }).waitFor()
        } else if (surface === 'profiles' || surface === 'profile-import' || surface === 'profile-delete') {
          await openSettings(page, language)
          const settings = page.getByRole('dialog', { name: chinese ? '设置' : 'Settings', exact: true })
          await settings.getByRole('button', { name: chinese ? '工位档案' : 'Seat profiles', exact: true }).click()
          await settings.getByRole('heading', { name: chinese ? '工位档案' : 'Seat profiles', exact: true }).waitFor()
          if (surface === 'profile-import') await settings.getByRole('button', { name: chinese ? '从表格导入' : 'Import table', exact: true }).click()
          if (surface === 'profile-delete') {
            if (!chinese) await settings.getByRole('button', { name: 'fixture-seat', exact: true }).click()
            await settings.getByRole('button', { name: chinese ? '删除工位' : 'Delete profile', exact: true }).click()
            await page.getByRole('dialog', { name: chinese ? '确认删除本位档案？' : 'Delete this seat profile?', exact: true }).waitFor()
          }
        } else {
          const section = page.getByRole('region', { name: chinese ? '工位' : 'Seats', exact: true })
          await section.waitFor()
          if (surface === 'overview') {
            await section.getByRole('heading', { name: chinese ? '工位' : 'Seats', exact: true }).hover()
            await section.getByRole('button', { name: chinese ? '一览表' : 'Overview', exact: true }).click()
            await page.getByRole('heading', { name: chinese ? '一览表' : 'Overview', exact: true }).waitFor()
          }
          if (surface === 'add-seat') {
            await section.getByRole('button', { name: chinese ? '添加工位' : 'Add seat', exact: true }).click()
            await page.getByRole('dialog', { name: chinese ? '添加工位' : 'Add seat', exact: true }).waitFor()
          }
        }
        const directory = process.env.DSH_UI_SCREENSHOT_DIR
        if (directory) {
          await mkdir(directory, { recursive: true })
          await page.screenshot({ path: join(directory, `${surface}-${language}.png`), animations: 'disabled' })
        }
      }
      await show('en')
      if (surface === 'profile-delete' || surface === 'add-seat' || surface === 'approvals') await page.keyboard.press('Escape')
      if (surface.startsWith('profile')) await page.keyboard.press('Escape')
      await openSettings(page, 'en')
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'General', exact: true }).click()
      await settings.getByRole('button', { name: 'English', exact: true }).click()
      await page.getByRole('menuitem', { name: '中文', exact: true }).click()
      await page.keyboard.press('Escape')
      await show('zh')
      expect(consoleWatch.pageErrors).toEqual([])
    } finally {
      overview.mockRestore(); dashboard.mockRestore(); profiles.mockRestore(); approvals.mockRestore()
      await browser.close(); await scaffold.close()
    }
  }, 120_000,
)
