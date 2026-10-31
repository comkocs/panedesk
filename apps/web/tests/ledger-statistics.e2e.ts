/** Keyless statistics navigation over synthetic ledger evidence through the shipped owner bridge. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import type { LedgerCall, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { summarizeStats } from '../../../packages/session/ledger-query/src/stats.ts'
import type {} from '@panedesk/dsh-client-ui-stats'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import { en, zh } from '../../../packages/client/ui-stats/src/client/locales.ts'
import { launchWebScaffold } from './scaffold.ts'
import { openSettings } from './support.ts'

it.each(['en', 'zh'] as const)('replays five statistics tabs, cursor navigation and read states in %s', async (language) => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: language === 'zh' ? 'zh-CN' : 'en-US' })
  const locale = language === 'zh' ? zh : en
  const asOf = Date.now()
  const rows: LedgerCall[] = Array.from({ length: 101 }, (_, index) => ({ kind: 'call', start: {
    callId: `call-${String(index).padStart(3, '0')}` as LedgerCall['start']['callId'],
    runId: 'run' as LedgerCall['start']['runId'], logicalRequestId: `request-${index}` as LedgerCall['start']['logicalRequestId'],
    sessionId: `session-${index % 3}` as LedgerCall['start']['sessionId'], rootSessionId: 'root' as LedgerCall['start']['rootSessionId'],
    nodeId: 'fixture' as LedgerCall['start']['nodeId'], seat: `seat-${index % 3}`, window: `window-${index % 3}`,
    taskId: `job-${index % 2}`, accountLabel: 'unknown', identitySource: 'startup', attemptIndex: 0, attemptVisibility: 'physical',
    provider: 'fixture', modelFamily: 'fixture', requestedModel: 'model-fixture', purpose: 'conversation', startedAt: asOf - 1000,
    cache: { cacheMode: 'unknown', breakReasons: [] }, cacheWriteTiering: { kind: 'unknown' },
    priceVersion: 'fixture', priceKey: 'model-fixture', referencePrice: true,
  } }))
  let source: LedgerSnapshot = { asOf, complete: true, watermarks: {}, rows }
  let code: 'stats/disabled' | 'stats/unauthorized' | 'stats/unavailable' | undefined
  let waiting: Promise<undefined> | undefined
  const query = vi.spyOn(scaffold.ctx.ledgerQuery, 'stats').mockImplementation(async (request) => {
    if (waiting) await waiting
    if (code) throw new RemoteError(code, 'Synthetic read state', {})
    return summarizeStats(source, request, asOf)
  })
  const screenshots = process.env.DSH_STATS_SCREENSHOT_DIR
  const shot = async (name: string) => {
    if (!screenshots) return
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `${language}-${name}.png`) })
  }
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: language === 'zh' ? '账号菜单' : 'Account menu' }).waitFor()
    expect(await page.getByText(locale.title, { exact: true }).count()).toBe(0)
    await shot('initial')
    await openSettings(page, language)
    const dialog = page.getByRole('dialog', { name: language === 'zh' ? '设置' : 'Settings', exact: true })
    await dialog.getByRole('button', { name: locale.title, exact: true }).click()
    await dialog.getByRole('button', { name: locale.open, exact: true }).click()
    await page.getByRole('heading', { name: locale.title, exact: true }).waitFor()
    await page.getByText(locale.success, { exact: true }).waitFor()
    await page.getByRole('button', { name: locale.pause, exact: true }).click()
    for (const tab of ['overview', 'history', 'models', 'throughput', 'ledger'] as const) {
      await page.getByRole('button', { name: locale[tab], exact: true }).click()
      await shot(tab)
    }
    expect(await page.getByText('call-100', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: locale.nextPage, exact: true }).click()
    await page.getByText('call-100', { exact: true }).waitFor()
    expect(await page.getByText('call-000', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: locale.nextPage, exact: true }).isDisabled()).toBe(true)
    await shot('last-page')
    await page.getByRole('button', { name: locale.refresh, exact: true }).click()
    await page.getByText('call-000', { exact: true }).waitFor()
    await page.getByRole('button', { name: locale.resume, exact: true }).click()
    await page.getByText(locale.success, { exact: true }).waitFor()
    code = 'stats/unavailable'
    await page.getByText(locale.failed, { exact: true }).waitFor({ timeout: 20_000 })
    await shot('failed-refresh')
    code = undefined
    await page.getByRole('button', { name: locale.pause, exact: true }).click()
    source = { ...source, rows: [] }
    await page.getByRole('button', { name: locale.refresh, exact: true }).click()
    await page.getByText(locale.empty, { exact: true }).first().waitFor()
    await shot('empty')
    for (const [failure, name] of [['stats/unauthorized', 'unauthorized'], ['stats/disabled', 'disabled'], ['stats/unavailable', 'error']] as const) {
      code = failure
      await page.getByRole('button', { name: locale.refresh, exact: true }).click()
      await page.getByText(locale[name], { exact: true }).waitFor()
      await shot(name)
    }
    code = undefined
    const pending = Promise.withResolvers<undefined>()
    waiting = pending.promise
    await page.getByRole('button', { name: locale.refresh, exact: true }).click()
    await page.getByText(locale.loading, { exact: true }).waitFor()
    await shot('loading')
    pending.resolve(undefined)
    waiting = undefined
    await page.getByText(locale.empty, { exact: true }).first().waitFor()
    expect(query).toHaveBeenCalled()
  } finally {
    query.mockRestore()
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
