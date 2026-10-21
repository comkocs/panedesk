/**
 * Panedesk fork check: six-step keyless smoke walk over the fork's web UI,
 * used for milestone hand-off. One scaffold, one headless browser, one page:
 * main screen, blank session page after connecting a workspace, a seeded
 * chat reply, the tool-call trajectory with long bash output, settings, and
 * the plugins page. Seeded session replays only — no model call, no
 * credentials. The server binds 127.0.0.1 on an OS-assigned port through the
 * repository's own web e2e scaffold and is torn down with the browser.
 * Entry: `node scripts/panedesk/smoke/run.mjs <results-dir>` (sets SMOKE_OUT).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@panedesk/dsh-llm'
import { Session, SessionId } from '@panedesk/dsh-session'
import {
  launchWebScaffold,
  rawSessionLog,
  seedSession,
  watchConsole,
  type WebConsoleTripwire,
  type WebScaffold,
} from '../../../apps/web/tests/scaffold.ts'
import {
  WEB_FIXTURE_TIME,
  connectFreshWorkspaceZh,
  expandTurnProcesses,
  openSettings,
} from '../../../apps/web/tests/support.ts'

// The browser engine lives in the web app's devDependency slot; the type-only
// deep import carries the declarations, the require below carries the value.
import type * as playwrightModule from '../../../apps/web/node_modules/playwright/index.js'

type Browser = playwrightModule.Browser
type Page = playwrightModule.Page
const requireFromWebApp = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = requireFromWebApp('playwright') as typeof playwrightModule

const smokeOut = process.env.SMOKE_OUT
if (smokeOut === undefined || smokeOut === '') {
  throw new Error('web smoke: SMOKE_OUT must name the results directory; start through run.mjs')
}
const OUT = smokeOut
mkdirSync(OUT, { recursive: true })
const log = (tag: string, ...parts: unknown[]): void => { console.log(`[smoke] ${tag}`, ...parts) }

// Known console-error noise with the reason it is ignored in step 01; any
// other console error or page error fails the step.
const KNOWN_NOISE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /favicon/i, why: 'headless bundle serves no favicon; harmless 404 noise' },
]

const CHAT_ID = 'm3-smoke-chat'
const CHAT_PROMPT = 'Smoke: please say hi'
const CHAT_REPLY = 'Smoke reply: hello, this assistant message was replayed from the seeded session.'
const BASH_ID = 'm3-smoke-bash-300'
const BASH_PROMPT = 'Print 300 numbered lines with seq.'
const LINES = 300
// Numbered output lines: "001: numbered-line-001" .. "300: numbered-line-300".
const BASH_OUTPUT = Array.from({ length: LINES },
  (_, i) => `${String(i + 1).padStart(3, '0')}: numbered-line-${String(i + 1).padStart(3, '0')}`).join('\n')

type StepRecord = { id: string; name: string; pass: boolean; ms: number; evidence: string }
const steps: StepRecord[] = []
function record(id: string, name: string, evidence: string, pass = true, startedAt = Date.now()): void {
  steps.push({ id, name, pass, ms: Date.now() - startedAt, evidence })
  writeFileSync(join(OUT, 'steps.json'), JSON.stringify(steps, null, 2))
  log(id, pass ? 'PASS' : 'FAIL', evidence)
}

/** Append one closed recorded turn: turn start, user prompt, one assistant step, turn end. */
function appendClosedTurn(session: Session, prompt: string, appendStep: () => void): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  appendStep()
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** One user prompt plus one assistant text reply, as a closed recorded turn. */
function chatFixture(): string {
  const session = Session.create(SessionId(CHAT_ID))
  appendClosedTurn(session, CHAT_PROMPT, () => {
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: CHAT_REPLY }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
  })
  return rawSessionLog(session)
}

/** One turn with a single bash call whose result is 300 numbered lines. */
function bashLongFixture(): string {
  const session = Session.create(SessionId(BASH_ID))
  const callId = ToolCallId('call-seq-300')
  const args = JSON.stringify({ command: 'seq-demo 1 300', description: 'Print 300 numbered lines' })
  appendClosedTurn(session, BASH_PROMPT, () => {
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    const source = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: args })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: BASH_OUTPUT }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  })
  return rawSessionLog(session)
}

/** Walk visible sidebar tree items (expanding collapsed groups) until the seeded prompt text renders. */
async function openSeededSession(page: Page, prompt: string): Promise<void> {
  const promptText = page.getByText(prompt, { exact: true })
  await page.locator('[role="treeitem"]').first().waitFor({ timeout: 15_000 })
  for (let round = 0; round < 3 && !await promptText.isVisible().catch(() => false); round++) {
    const items = page.locator('[role="treeitem"]')
    for (let index = 0; index < await items.count(); index++) {
      const item = items.nth(index)
      if (!await item.isVisible().catch(() => false)) continue
      await item.click().catch(() => {})
      await page.waitForTimeout(400)
      if (await promptText.isVisible().catch(() => false)) break
    }
    if (await promptText.isVisible().catch(() => false)) break
    const collapsed = page.locator('[role="treeitem"][aria-expanded="false"]')
    for (let index = 0; index < await collapsed.count(); index++) await collapsed.nth(index).click().catch(() => {})
    await page.waitForTimeout(600)
  }
  await promptText.waitFor({ timeout: 20_000 })
}

interface SmokeRig {
  scaffold: WebScaffold
  browser: Browser
  page: Page
  tripwire: WebConsoleTripwire
}
let rig: SmokeRig | undefined

/** The rig assembled by beforeAll; it bodies run only after it exists. */
function rigOrThrow(): SmokeRig {
  if (rig === undefined) throw new Error('web smoke: rig not assembled — beforeAll failed')
  return rig
}

describe('Panedesk web UI milestone smoke', () => {
  const consoleErrors: string[] = []

  /** Run one smoke step: pass/fail plus evidence into steps.json, screenshot either way. */
  async function step(page: Page, id: string, name: string, shot: string, body: () => Promise<string>): Promise<void> {
    const startedAt = Date.now()
    try {
      const evidence = await body()
      record(id, name, evidence, true, startedAt)
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error)
      record(id, name, summary.split('\n').slice(0, 3).join(' | ').slice(0, 400), false, startedAt)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      await page.screenshot({ path: join(OUT, shot), fullPage: true }).catch(() => {})
    }
  }

  beforeAll(async () => {
    const scaffold = await launchWebScaffold({})
    log('scaffold up', scaffold.baseUrl)
    await seedSession(scaffold, chatFixture(), CHAT_ID, undefined, { createdAt: WEB_FIXTURE_TIME })
    await seedSession(scaffold, bashLongFixture(), BASH_ID, undefined, { createdAt: WEB_FIXTURE_TIME + 1000 })
    log('sessions seeded', CHAT_ID, BASH_ID)
    const browser = await chromium.launch()
    // Chinese surface: the product copy under smoke is Chinese.
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300))
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    rig = { scaffold, browser, page, tripwire }
    log('page loaded')
  }, 240_000)

  afterAll(async () => {
    if (rig === undefined) {
      writeFileSync(join(OUT, '01_console.txt'), 'rig not assembled — beforeAll failed; see vitest.log\n')
      return
    }
    // Evidence for step 01 lands here so the whole session's noise is covered.
    const ignored = consoleErrors.map((text) => {
      const hit = KNOWN_NOISE.find(({ pattern }) => pattern.test(text))
      return hit === undefined ? undefined : { text, why: hit.why }
    })
    const blocking = consoleErrors.filter((_, index) => !ignored[index])
    writeFileSync(join(OUT, '01_console.txt'), [
      `console error total: ${consoleErrors.length}`,
      `ignored known noise: ${ignored.filter(item => item !== undefined).length}`,
      ...ignored.flatMap(item => item === undefined ? [] : [`  IGNORED: ${item.text} — ${item.why}`]),
      `blocking errors: ${blocking.length}`,
      ...blocking.map(text => `  ERROR: ${text}`),
      `pageerror total: ${rig.tripwire.pageErrors.length}`,
      ...rig.tripwire.pageErrors.map(text => `  PAGEERROR: ${text}`),
      `connection warnings: ${rig.tripwire.warnings.length}`,
      ...rig.tripwire.warnings.slice(0, 10).map(text => `  WARN: ${text}`),
      '',
    ].join('\n'))
    try { await rig.browser.close() } finally { await rig.scaffold.close() }
    log('torn down')
  })

  it('01 main screen loads without console errors', async () => {
    const { page, tripwire } = rigOrThrow()
    await step(page, '01', 'Main view loads', '01_main.png', async () => {
      await page.locator('[data-composer-input]').first().waitFor({ timeout: 20_000 })
      // Settle window for late errors before adjudicating.
      await page.waitForTimeout(2500)
      if (tripwire.pageErrors.length > 0) throw new Error(`pageerror: ${tripwire.pageErrors[0] ?? 'no page error text'}`)
      const blocking = consoleErrors.filter(text => !KNOWN_NOISE.some(({ pattern }) => pattern.test(text)))
      if (blocking.length > 0) throw new Error(`console error: ${blocking[0] ?? 'no console error text'}`)
      const ignoredCount = consoleErrors.length - blocking.length
      return `No error-level console output (${consoleErrors.length} error entries, ${ignoredCount} known-noise entries ignored, details in 01_console.txt); composer rendered`
    })
  })

  it('02 blank new-session page after connecting a workspace', async () => {
    const { page, scaffold } = rigOrThrow()
    await step(page, '02', 'Blank new session', '02_blank_session.png', async () => {
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
      await page.waitForTimeout(600)
      const heroCount = await page.locator('div[class*="heroOptions"]').count()
      const children = heroCount > 0
        ? await page.locator('div[class*="heroOptions"]').first().evaluate(el => el.childElementCount)
        : -1
      writeFileSync(join(OUT, '02_hero_options.txt'),
        `selector: div[class*="heroOptions"]\nblank new-session page after connecting a fresh workspace: ${heroCount} matches, first match child elements ${children}\n`)
      return `Blank new-session page with workspace connected; div[class*="heroOptions"] matched ${heroCount} (first match child elements: ${children})`
    })
  })

  it('03 send a message and get a reply (seeded session replay)', async () => {
    const { page } = rigOrThrow()
    await step(page, '03', 'Send a message and get a reply', '03_reply.png', async () => {
      await openSeededSession(page, CHAT_PROMPT)
      // The sidebar may truncate the prompt in the session title, so the list
      // membership proof is the opened (selected) tree item plus a short-substring
      // probe; the full tree aria goes to the evidence file for inspection.
      const treeHits = await page.locator('[role="treeitem"]', { hasText: 'say hi' }).count()
      const selected = await page.locator('[role="treeitem"][aria-selected="true"]').count()
      const treeAria = await page.locator('[role="tree"]').first().ariaSnapshot().catch(() => 'no [role=tree]')
      writeFileSync(join(OUT, '03_session_tree.txt'), treeAria.split('\n').slice(0, 40).join('\n') + '\n')
      await page.getByText(CHAT_REPLY, { exact: true }).waitFor({ timeout: 15_000 })
      if (selected < 1) throw new Error('no selected tree item after opening the session')
      return `Selected treeitems: ${selected} (including this session); treeitems whose title contains "say hi": ${treeHits}; message area rendered the user message "${CHAT_PROMPT}" and the reply "${CHAT_REPLY.slice(0, 18)}…"`
    })
  })

  it('04 tool call and Inspect trajectory with 300-line bash output', async () => {
    const { page } = rigOrThrow()
    await step(page, '04', 'Tool call trajectory', '04_trajectory.png', async () => {
      await openSeededSession(page, BASH_PROMPT)
      await expandTurnProcesses(page)
      const row = page.locator('[data-sample="bash"]').first()
      await row.waitFor({ timeout: 15_000 })
      await row.click()
      await page.waitForTimeout(500)
      const card = row.locator('xpath=..')
      // The hover-revealed Inspect pill ("查看") jumps to the trajectory record.
      await card.hover()
      await card.getByRole('button', { name: '查看', exact: true }).click({ timeout: 10_000 })
      const timeline = page.getByLabel('轨迹时间线')
      await timeline.first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(800)
      // Read the panel, then scroll every inner scroller to its bottom and read
      // again until the text stops growing (virtualized lists render lazily).
      // The callback is serialized into the page, so it must not close over
      // anything; unrendered nodes fall back like textContent.
      const readTimeline = async (): Promise<string> => await timeline.first()
        .evaluate((el) => {
          const root = el.closest('[class*="trajectory"], [class*="view"]') ?? el
          return root instanceof HTMLElement ? root.innerText : ''
        })
      const seen = new Set<string>()
      const harvest = (text: string): void => { for (const m of text.match(/numbered-line-\d{3}/g) ?? []) seen.add(m) }
      let text = await readTimeline()
      harvest(text)
      for (let round = 0; round < 12; round++) {
        await timeline.first().evaluate((el) => {
          const root = el.closest('[class*="trajectory"], [class*="view"]') ?? el
          const scrollers = [el, root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
            .filter(node => node.scrollHeight > node.clientHeight + 8)
          for (const scroller of scrollers) scroller.scrollTop = scroller.scrollHeight
        }).catch(() => {})
        await page.waitForTimeout(500)
        const next = await readTimeline()
        harvest(next)
        if (next === text) break
        text = next
      }
      const numbered = Array.from(seen).sort()
      const numbers = numbered.map(m => Number(m.slice('numbered-line-'.length)))
      const firstOk = text.includes('001: numbered-line-001') || seen.has('numbered-line-001')
      const lastOk = text.includes('300: numbered-line-300') || seen.has('numbered-line-300')
      const maxSeen = numbers.length > 0 ? Math.max(...numbers) : 0
      const verdict = seen.size === LINES ? 'full' : `truncated at line ${maxSeen}`
      writeFileSync(join(OUT, '04_trajectory_text.txt'), `${text}\n\n===== Scroll-harvest union: numbered lines hit ${seen.size}/${LINES}; first line 001: ${firstOk}; last line 300: ${lastOk}; verdict: ${verdict} =====\n`)
      writeFileSync(join(OUT, '04_verdict.txt'),
        `Trajectory panel text ${text.length} chars; scroll-harvest union hit numbered lines ${seen.size}/${LINES}; first line 001 present=${firstOk}; last line 300 present=${lastOk}; verdict: ${verdict}\n`)
      if (seen.size === 0) throw new Error('trajectory panel rendered no numbered bash output')
      return `Trajectory panel opened; 300-line numbered output verdict: ${verdict} (${seen.size}/${LINES} lines hit, 001: ${firstOk}, 300: ${lastOk}; text in 04_trajectory_text.txt)`
    })
  })

  it('05 settings dialog opens with the General page', async () => {
    const { page } = rigOrThrow()
    await step(page, '05', 'Settings', '05_settings.png', async () => {
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ timeout: 10_000 })
      const current = await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')
      await dialog.getByRole('button', { name: '工作区内修改' }).waitFor({ timeout: 10_000 })
      const language = await dialog.getByText('语言', { exact: true }).count()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
      return `Settings dialog opened; General page aria-current=${current ?? '(null)'}; workspace-level edits control and language entry (count ${language}) visible; Esc closed the dialog`
    })
  })

  it('06 plugins page opens with a non-empty list', async () => {
    const { page } = rigOrThrow()
    await step(page, '06', 'Plugins', '06_plugins.png', async () => {
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.waitFor({ timeout: 10_000 })
      while (await panel.getByRole('button', { name: /^返回/ }).count() > 0) {
        await panel.getByRole('button', { name: /^返回/ }).first().click()
      }
      await panel.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
      await panel.getByRole('heading', { name: '内置插件配置' }).waitFor({ timeout: 10_000 })
      // Settle the inventory load, then count list items across the panel.
      await page.waitForTimeout(1000)
      const items = await panel.getByRole('listitem').count()
      if (items < 1) throw new Error('plugin list rendered 0 items')
      return `Plugins page opened; built-in plugin configuration section present; panel listitems: ${items} (non-empty)`
    })
  })
})
