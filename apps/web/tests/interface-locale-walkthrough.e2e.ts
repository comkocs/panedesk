/** Keyless navigation keeps the same feature page across an explicit locale change. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings } from './support.ts'

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.DSH_UI_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

const sections = [
  ['general', 'General', '通用设置'],
  ['bash', 'General', '通用设置'],
  ['statistics-overview', 'Statistics', '统计台'],
  ['statistics-history', 'Statistics', '统计台'],
  ['statistics-models', 'Statistics', '统计台'],
  ['statistics-throughput', 'Statistics', '统计台'],
  ['statistics-ledger', 'Statistics', '统计台'],
  ['models', 'Models', '模型'],
  ['plugins', 'Built-in plugins', '内置插件'],
  ['nodes', 'Nodes', '节点'],
  ['statistics', 'Statistics', '统计台'],
  ['skills', 'Skills', '技能'],
  ['project-onboarding', 'Project opening settings', '项目开窗设置'],
] as const

it.each(sections)('retains the %s settings page when switching from English to Chinese', async (name, english, chinese) => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false } })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'en-US' })
    const consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: english, exact: true }).click()
    expect(await dialog.getByRole('button', { name: english, exact: true }).getAttribute('aria-current')).toBe('true')
    const statisticsTabs = {
      'statistics-overview': ['Project overview', '项目总览'], 'statistics-history': ['Historical statistics', '历史统计'],
      'statistics-models': ['Model usage', '模型用量'], 'statistics-throughput': ['Model throughput', '模型吞吐'],
      'statistics-ledger': ['Ledger details', '账本明细'],
    } as const
    const tab = statisticsTabs[name as keyof typeof statisticsTabs]
    if (tab) {
      await dialog.getByRole('button', { name: 'Open in main area', exact: true }).click()
      await page.getByRole('button', { name: tab[0], exact: true }).click()
    }
    if (name === 'bash') await dialog.getByText('This row applies to Windows hosts only.', { exact: true }).waitFor()
    await screenshot(page, `${name}-en`)
    if (tab) await openSettings(page, 'en')
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    const translated = page.getByRole('dialog', { name: '设置', exact: true })
    await translated.getByRole('button', { name: chinese, exact: true }).click()
    expect(await translated.getByRole('button', { name: chinese, exact: true }).getAttribute('aria-current')).toBe('true')
    if (tab) {
      await translated.getByRole('button', { name: '在主区打开', exact: true }).click()
      await page.getByRole('button', { name: tab[1], exact: true }).click()
      expect(await page.getByRole('button', { name: tab[1], exact: true }).getAttribute('aria-pressed')).toBe('true')
    }
    if (name === 'bash') await translated.getByText('本行只在 Windows 宿主上适用。', { exact: true }).waitFor()
    if (name === 'nodes') await translated.getByText('暂无已配置节点或停车回调。', { exact: true }).waitFor()
    if (name === 'skills') await translated.getByRole('heading', { name: '技能', exact: true }).waitFor()
    if (name === 'statistics') await translated.getByRole('button', { name: '在主区打开', exact: true }).waitFor()
    if (name === 'plugins') await translated.getByRole('heading', { name: '内置插件', exact: true }).waitFor()
    await screenshot(page, `${name}-zh`)
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
    expect(consoleWatch.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
