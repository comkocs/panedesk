/** Session-only additions stay off startup and update copy after one locale switch. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@panedesk/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, openSettings } from './support.ts'

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.DSH_UI_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

it.each(['inbox', 'subagent-tree', 'monitoring', 'cache', 'right-session', 'mermaid'] as const)(
  'walks the %s session surface and switches its interface language', async (surface) => {
    const scaffold = await launchWebScaffold({ profile: { packages: [], hmr: false } })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'en-US' })
      const consoleWatch = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor()
      for (const name of ['Inbox', 'Subagent tree', 'Cache']) expect(await page.getByRole('button', { name, exact: true }).count()).toBe(0)
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const agent = scaffold.ctx.agents.list()[0]
      if (!agent) throw new Error('Workspace did not create a fixture session')
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect the retained session.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      agent.session.append('step/start', { turn: 1, step: 1 })
      agent.session.append('assistant/message', { stream: [], turn: 1, step: 1,
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: surface === 'mermaid' ? '```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```' : 'Retained fixture reply.' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 1, step: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(agent.session)
      const show = async (language: 'en' | 'zh'): Promise<void> => {
        if (surface === 'inbox') {
          await page.getByRole('button', { name: language === 'en' ? 'Inbox' : '收件', exact: true }).click()
          await page.getByRole('dialog', { name: language === 'en' ? 'Inbox' : '收件', exact: true }).waitFor()
        } else if (surface === 'cache') {
          await page.getByRole('button', { name: language === 'en' ? 'Cache' : '缓存', exact: true }).click()
          await page.getByRole('dialog', { name: language === 'en' ? 'Cache remaining' : '缓存剩余', exact: true }).waitFor()
        } else if (surface === 'subagent-tree' || surface === 'monitoring') {
          await page.getByRole('button', { name: language === 'en' ? 'Subagent tree' : '子代理树', exact: true }).click()
          await page.locator('[data-subagent-tree]').getByRole('heading', { name: language === 'en' ? 'Subagent tree' : '子代理树', exact: true }).waitFor()
          if (surface === 'monitoring') {
            await page.locator('[data-subagent-tree]').getByRole('button', { name: language === 'en' ? 'Monitor' : '监测', exact: true }).first().click()
            await page.getByRole('dialog').waitFor()
          }
        } else if (surface === 'right-session') {
          if (language === 'en') {
            const row = page.getByRole('treeitem').filter({ hasText: 'Inspect the retained session.' }).last()
            await row.hover()
            await row.getByRole('button', { name: /^Session actions for / }).click()
            await page.getByRole('menuitem', { name: 'Open in the right sidebar', exact: true }).click()
          }
          await page.locator('[data-session-tab]').getByText(language === 'en' ? 'Pinned entries' : '钉住的条目', { exact: true }).waitFor()
        } else {
          await page.locator('[data-mermaid="drawn"] > svg').waitFor()
        }
        await screenshot(page, `${surface}-${language}`)
      }
      await show('en')
      if (surface === 'inbox') await page.getByRole('dialog', { name: 'Inbox', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
      if (surface === 'cache') await page.getByRole('button', { name: 'Cache', exact: true }).click()
      if (surface === 'monitoring') await page.keyboard.press('Escape')
      await openSettings(page, 'en')
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'English', exact: true }).click()
      await page.getByRole('menuitem', { name: '中文', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
      await show('zh')
      expect(consoleWatch.pageErrors).toEqual([])
    } finally {
      await browser.close()
      await scaffold.close()
    }
  }, 120_000,
)
