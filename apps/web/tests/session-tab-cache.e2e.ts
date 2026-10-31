/** Keyless shipped UI: clean startup, localized cache panel and retained sidebar conversation. */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@panedesk/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh } from './support.ts'

it.each([
  ['en', 'en-US', 'Cache', 'Cache remaining', 'Open in the right sidebar', 'Pinned entries'],
  ['zh', 'zh-CN', '缓存', '缓存剩余', '在右栏打开', '钉住的条目'],
] as const)('keeps startup clean and renders cache and sidebar session in %s', async (language, locale, cacheLabel, cacheTitle, openLabel, pinsLabel) => {
  const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false } })
  const browser = await chromium.launch()
  const directory = resolve(process.env.DSH_UI_SCREENSHOT_DIR ?? '.artifacts/screenshots/session-tab-cache')
  mkdirSync(directory, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale })
    const consoleWatch = watchConsole(page)
    const shot = async (name: string): Promise<void> => {
      await page.evaluate(async () => { await document.fonts.ready })
      await page.screenshot({ path: resolve(directory, `${language}-${name}.png`), animations: 'disabled' })
    }
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await page.locator('[data-session-tab]').count()).toBe(0)
    expect(await page.getByRole('menuitem', { name: openLabel }).count()).toBe(0)
    expect(await page.getByRole('button', { name: cacheLabel, exact: true }).count()).toBe(0)
    await shot('first-screen')

    if (language === 'en') await connectFreshWorkspace(page, scaffold.workspaceCwd)
    else await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Workspace did not create a fixture Session')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Review the session alongside the main conversation.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'The retained conversation is ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('The retained conversation is ready.', { exact: true }).waitFor()
    await page.getByRole('button', { name: cacheLabel, exact: true }).click()
    await page.getByRole('dialog', { name: cacheTitle }).waitFor()
    const pill = await page.getByRole('button', { name: cacheLabel, exact: true }).boundingBox()
    const panel = await page.getByRole('dialog', { name: cacheTitle }).boundingBox()
    if (!pill || !panel) throw new Error('Cache controls are not visible')
    expect(panel.y + panel.height).toBeLessThanOrEqual(pill.y)
    await shot('cache-pill')
    await page.getByRole('button', { name: cacheLabel, exact: true }).click()
    await page.getByRole('dialog', { name: cacheTitle }).waitFor({ state: 'hidden' })
    const pin = page.getByRole('button', { name: language === 'en' ? 'Pin' : '钉住', exact: true }).first()
    await page.getByText('The retained conversation is ready.', { exact: true }).hover()
    await pin.waitFor()
    expect(await pin.innerText()).toBe('')
    expect(await pin.locator('svg').count()).toBe(1)
    await shot('pin-icon')
    const row = page.getByRole('treeitem').filter({ hasText: 'Review the session alongside' }).last()
    await row.hover()
    const actions = row.getByRole('button', { name: language === 'en' ? /^Session actions for / : /^会话“.*”的操作$/ })
    await actions.click()
    await page.getByRole('menuitem', { name: openLabel }).click()
    const sidebar = page.locator('[data-session-tab]')
    await sidebar.getByText('The retained conversation is ready.', { exact: true }).waitFor()
    expect(await sidebar.getByText(pinsLabel, { exact: true }).count()).toBe(1)
    expect(await sidebar.locator('[data-composer-input]').count()).toBe(1)
    await shot('right-session')
    expect(consoleWatch.pageErrors).toEqual([])
  } finally { await browser.close(); await scaffold.close() }
}, 180_000)
