// @vitest-environment jsdom
/** The cache pill lists a reading and offers a tier switch only for an explicit route. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@panedesk/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import type { SessionId } from '@panedesk/dsh-session/types'
import { CachePill, type CachePillProps } from '../src/client/CachePill.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { CacheRead, CacheTier } from '../src/client/view.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const zhT = makeTranslate(zh)
const enT = makeTranslate(en)
const MAIN = 'main' as SessionId
const CHILD = 'child' as SessionId

function resource(read: CacheRead): CachePillProps['useResource'] {
  return (() => ({ status: 'live', value: read, failure: undefined })) as CachePillProps['useResource']
}

function Pill({ preset = 'standard', ...props }: Pick<CachePillProps, 't' | 'sessionId' | 'useResource' | 'write'> & { preset?: string }) {
  const sessions: Parameters<Parameters<CachePillProps['useSessions']>[0]>[0] = {
    ids: [props.sessionId], byId: { [props.sessionId]: {
      id: props.sessionId, displayTitle: 'Session', running: false, retainedBy: {}, blank: false, updatedAt: 0,
      projectionValues: { agentPreset: preset },
    } }, phase: 'ready', projectionsBySession: {},
  }
  const useSessions: CachePillProps['useSessions'] = select => select(sessions)
  return <CachePill {...{ ...props, useSessions } as CachePillProps} />
}

function mount(read: CacheRead, t: typeof zhT, write: (tier: CacheTier) => Promise<boolean> = async () => true) {
  return render(<Pill t={t} sessionId={MAIN} useResource={resource(read)} write={write} />)
}

describe('CachePill', () => {
  it('keeps the minimal preset composer free of the cache entry', () => {
    const ui = render(<Pill preset="minimal" sessionId={MAIN} t={enT} useResource={resource({ status: 'empty' })} write={async () => true} />)
    expect(ui.queryByRole('button')).toBeNull()
    expect(ui.queryByRole('dialog')).toBeNull()
  })
  it.each([undefined, { status: 'ready', rows: [], tiers: ['none'] } satisfies CacheRead])('reports a failed resource read without loading or writable stale evidence: %j', (previous) => {
    const useResource = (() => ({ status: 'failed', value: previous, failure: undefined })) as CachePillProps['useResource']
    const ui = render(<Pill sessionId={MAIN} t={enT} useResource={useResource} write={async () => true} />)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    expect(ui.getByText(en['panel.error'])).toBeTruthy()
    expect(ui.queryByText(en['panel.loading'])).toBeNull()
    expect(ui.queryByRole('group', { name: en['tier.label'] })).toBeNull()
  })

  it('disables tier changes while saving and reports a refused write without claiming success', async () => {
    let finish: ((saved: boolean) => void) | undefined
    const write = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const ui = mount({ status: 'ready', rows: [], tiers: ['none', '5m'], retention: '5m' }, enT, write)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    fireEvent.click(ui.getByRole('button', { name: en['tier.none'] }))
    expect(ui.getByText(en['tier.pending'])).toBeTruthy()
    expect(ui.getByRole('button', { name: en['tier.5m'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => { finish?.(false) })
    expect(ui.getByText(en['tier.failed'])).toBeTruthy()
    expect(ui.queryByText(en['tier.saved'])).toBeNull()
    expect(ui.getByRole('button', { name: en['tier.5m'] }).getAttribute('aria-pressed')).toBe('true')
    expect(ui.getByRole('button', { name: en['tier.5m'] }).hasAttribute('disabled')).toBe(false)
  })

  it('reports a rejected tier write without claiming success', async () => {
    const ui = mount({ status: 'ready', rows: [], tiers: ['none'] }, enT, () => Promise.reject(new Error('unavailable')))
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    fireEvent.click(ui.getByRole('button', { name: en['tier.none'] }))
    await waitFor(() => { expect(ui.getByText(en['tier.failed'])).toBeTruthy() })
    expect(ui.queryByText(en['tier.saved'])).toBeNull()
  })

  it('decrements evidence-backed seconds while closed and replaces them on a new resource snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const view: CacheRead = { status: 'ready', tiers: [], rows: [{ sessionId: MAIN, role: 'main', kind: 'estimated', seconds: 125, evidenceAt: Date.now(), ttlSeconds: 125 }] }
    const ui = mount(view, enT)
    expect(ui.getByText('Estimated cache left 2 minutes 5 seconds')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(ui.getByText('Estimated cache left 2 minutes 2 seconds')).toBeTruthy()
    const renewed: CacheRead = { ...view, rows: [{ sessionId: MAIN, role: 'main', kind: 'estimated', evidenceAt: Date.now(), ttlSeconds: 300 }] }
    ui.rerender(<Pill sessionId={MAIN} t={enT} useResource={resource(renewed)} write={async () => true} />)
    expect(ui.getByText('Estimated cache left 5 minutes 0 seconds')).toBeTruthy()
  })

  it.each([
    ['loading', '正在读取缓存剩余时间', 'Reading the cache time'],
    ['empty', '暂无缓存数据', 'No cache data yet'],
    ['error', '缓存剩余时间读取失败', 'The cache time could not be read'],
    ['denied', '无权限读取这个会话的缓存', 'You do not have access to this session cache'],
    ['unavailable', '当前部署没有缓存账本', 'This deployment has no cache ledger'],
  ] as const)('localizes the %s state in both languages', (_status, chinese, english) => {
    const view: CacheRead = { status: _status }
    const zhUI = mount(view, zhT)
    fireEvent.click(zhUI.getByRole('button', { expanded: false }))
    expect(zhUI.getByText(chinese)).toBeTruthy()
    zhUI.unmount()
    const enUI = mount(view, enT)
    fireEvent.click(enUI.getByRole('button', { expanded: false }))
    expect(enUI.getByText(english)).toBeTruthy()
  })
  it('keeps second precision above a minute so the reading stays within five seconds of the ledger', async () => {
    const ui = mount({
      status: 'ready',
      rows: [{ sessionId: MAIN, role: 'main', kind: 'estimated', seconds: 125 }],
      tiers: [],
    }, enT)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    expect(await ui.findByText('Estimated 2 minutes 5 seconds left')).toBeTruthy()
  })

  it('lists the estimated main window and a subagent in Chinese, without inventing an unknown duration', async () => {
    const ui = mount({
      status: 'ready',
      rows: [
        { sessionId: MAIN, role: 'main', kind: 'estimated', seconds: 125 },
        { sessionId: CHILD, role: 'subagent', kind: 'unknown' },
      ],
      tiers: ['none', '5m', '1h'],
      retention: '5m',
    }, zhT)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    expect(await ui.findByText('主窗口')).toBeTruthy()
    expect(ui.getByText('估算剩余 2 分钟 5 秒')).toBeTruthy()
    expect(ui.getByText('子代理 child')).toBeTruthy()
    expect(ui.getByText('未知')).toBeTruthy()
    expect(ui.getByRole('button', { name: '5 分钟' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('offers no tier switch for an automatic route, in English', async () => {
    const ui = mount({
      status: 'ready',
      rows: [{ sessionId: MAIN, role: 'main', kind: 'automatic', cacheReadTokens: 128 }],
      tiers: [],
    }, enT)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    expect(await ui.findByText('Cache hit: 128 tokens')).toBeTruthy()
    expect(ui.queryByRole('group', { name: 'Cache tier' })).toBeNull()
  })

  it('stores the chosen tier and says the next request uses it', async () => {
    const write = vi.fn(async () => true)
    const ui = mount({
      status: 'ready',
      rows: [{ sessionId: MAIN, role: 'main', kind: 'estimated', seconds: 10 }],
      tiers: ['none', '5m', '1h'],
    }, enT, write)
    fireEvent.click(ui.getByRole('button', { expanded: false }))
    fireEvent.click(await ui.findByRole('button', { name: '1 hour' }))
    await waitFor(() => { expect(write).toHaveBeenCalledWith('1h') })
    expect(ui.getByText('Saved; the next request uses it')).toBeTruthy()
  })
})
