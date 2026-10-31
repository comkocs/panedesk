/** Keyless node settings navigation uses only synthetic providers on an owned loopback scaffold. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import type {} from '@panedesk/dsh-client-ui-nodes'
import type { SeatNodeId, CallbackId } from '@panedesk/dsh-seat/types'
import { launchWebScaffold } from './scaffold.ts'
import { openSettings } from './support.ts'

it.each(['en', 'zh'] as const)('shows nodes only in secondary settings and confirms operator actions in %s', async (language) => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: language === 'zh' ? 'zh-CN' : 'en-US' })
  const labels = language === 'zh' ? { title: '节点', rebuild: '单独重拉', confirm: '确认操作',
    resume: '恢复', abandon: '放弃', accepted: '提供方已接受操作，请刷新核对当前状态。',
    startup: '事件仅自本次启动保留于进程内，每个对端最近 20 条。' }
    : { title: 'Nodes', rebuild: 'Rebuild this link', confirm: 'Confirm action', resume: 'Resume', abandon: 'Abandon',
      accepted: 'Action accepted by the provider. Refresh to inspect the current state.',
      startup: 'Events are process-local, from this startup only; the latest 20 are retained.' }
  const read = vi.spyOn(scaffold.ctx.nodes, 'read').mockResolvedValue({ refreshIntervalMs: 10000, view: {
    nodes: [{ nodeId: 'peer-fixture' as SeatNodeId, nodeName: 'Peer fixture', local: false, engine: 'unavailable',
      linkState: 'exhausted', safeReason: 'node-tunnel-exhausted', openWindows: null, limit: null,
      lastHeartbeatAt: '2026-01-01T00:00:00Z', rebuildable: true, events: [{ sequence: 1,
        at: '2026-01-01T00:00:00Z', kind: 'exhausted', safeReason: 'node-tunnel-exhausted' }] }],
    callbacks: [{ callbackId: 'callback-fixture' as CallbackId, source: 'source-fixture', target: 'peer-fixture',
      phase: 'paused', attempt: 5, parkingCode: 'transport-transient', detail: 'callback-transient-limit-reached',
      firstAttemptAt: '2026-01-01T00:00:00Z', lastAttemptAt: '2026-01-01T01:00:00Z', count: 5,
      attemptsAtLeast: true, latestReason: 'Synthetic safe reason' }],
    callbacksAvailable: true, callbacksComplete: true, sourceOperations: [], sourceAvailable: false,
  } })
  const act = vi.spyOn(scaffold.ctx.nodes, 'act').mockResolvedValue({ status: 'ok' })
  const screenshots = process.env.DSH_NODES_SCREENSHOT_DIR
  const shot = async (name: string) => {
    if (!screenshots) return
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `${language}-nodes-${name}.png`) })
  }
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: language === 'zh' ? '账号菜单' : 'Account menu' }).waitFor()
    expect(await page.getByText(labels.title, { exact: true }).count()).toBe(0)
    expect(read).not.toHaveBeenCalled()
    await shot('initial-1600x1100')
    await openSettings(page, language)
    await page.getByRole('button', { name: labels.title, exact: true }).click()
    await page.getByRole('heading', { name: labels.title, exact: true }).waitFor()
    await page.getByText(labels.startup, { exact: true }).waitFor()
    await page.getByRole('button', { name: labels.rebuild, exact: true }).waitFor()
    await page.getByText('Peer fixture · ' + (language === 'zh' ? '远程' : 'Remote'), { exact: true }).waitFor()
    await shot('health')
    for (const action of ['rebuild', 'resume', 'abandon'] as const) {
      const before = act.mock.calls.length
      await page.getByRole('button', { name: labels[action], exact: true }).click()
      expect(act.mock.calls.length).toBe(before)
      await page.getByRole('button', { name: labels.confirm, exact: true }).waitFor()
      await page.getByRole('dialog', { name: labels.confirm, exact: true })
        .evaluate(async (element) => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
      await shot(`${action}-confirmation`)
      await page.getByRole('button', { name: labels.confirm, exact: true }).click()
      await page.getByText(labels.accepted, { exact: true }).waitFor()
      await expect.poll(() => act.mock.calls.length).toBe(before + 1)
    }
    expect(act.mock.calls[0]?.[0]).toEqual({ kind: 'rebuild', peerNodeId: 'peer-fixture' })
    expect(act.mock.calls[1]?.[0]).toMatchObject({ kind: 'callback', request: { action: 'resume', expectedAttempt: 5 } })
    expect(act.mock.calls[2]?.[0]).toMatchObject({ kind: 'callback', request: { action: 'abandon', expectedAttempt: 5 } })
    await shot('result')
  } finally {
    read.mockRestore(); act.mockRestore()
    await browser.close(); await scaffold.close()
  }
}, 120000)
