/** Optional private packages expose disconnected settings without contacting a desk. */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings } from './support.ts'

const privateRoot = process.env.DSH_PRIVATE_UI_ROOT
const privateTest = it.runIf(privateRoot !== undefined && existsSync(join(privateRoot, 'packages/ticket-desk-ui/package.json')))
privateTest.each([
  ['private-desk', 'Ticket desk', '工单台'],
  ['private-token-import', 'Import desk token', '导入台面令牌'],
] as const)('walks disconnected %s settings and changes language', async (name, english, chinese) => {
  if (!privateRoot) throw new Error('Private UI root is required')
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [
    { dir: join(privateRoot, 'packages/ticket-desk-ui') },
    { dir: join(privateRoot, 'packages/ticket-desk-workflow') },
  ] }, extraOverlayPath: join(import.meta.dirname, 'private-interface-locale.overlay.yml') })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'en-US' })
    const consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    try {
      await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor({ timeout: 10_000 })
    } catch (error) {
      throw new Error(`Private client did not reach the shell: ${JSON.stringify(consoleWatch.pageErrors)}; ${await page.locator('body').innerText()}`, { cause: error })
    }
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: english, exact: true }).click()
    if (name === 'private-desk') await settings.getByText('Not connected · see the setup guide', { exact: true }).waitFor()
    const screenshot = async (language: string): Promise<void> => {
      const directory = process.env.DSH_UI_SCREENSHOT_DIR
      if (!directory) return
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: join(directory, `${name}-${language}.png`), animations: 'disabled' })
    }
    await screenshot('en')
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    const translated = page.getByRole('dialog', { name: '设置', exact: true })
    await translated.getByRole('button', { name: chinese, exact: true }).click()
    if (name === 'private-desk') await translated.getByText('未接入 · 见上机说明', { exact: true }).waitFor()
    else await translated.getByRole('button', { name: chinese, exact: true }).last().waitFor()
    await screenshot('zh')
    expect(consoleWatch.pageErrors).toEqual([])
  } finally { await browser.close(); await scaffold.close() }
}, 120_000)
