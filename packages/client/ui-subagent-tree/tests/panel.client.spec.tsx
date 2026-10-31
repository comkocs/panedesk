// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceStatus } from '@panedesk/dsh-client-resources/client'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SubagentTreeNode, SubagentTreeView } from '../src/types.ts'
import { en, zh } from '../src/client/locales.ts'
import { parseSubagentTreeAddress, subagentTreeAddress } from '../src/client/index.ts'
import { SubagentTreeAction, SubagentTreeTab } from '../src/client/panel.tsx'

const ROOT = 'session/root' as SessionId
const CHILD = 'session/child' as SessionId
const GRANDCHILD = 'session/grandchild' as SessionId
const ADDRESS = subagentTreeAddress(ROOT)

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('subagent tree address', () => {
  it('round-trips one session identity', () => {
    expect(ADDRESS).toBe(`dsh-resource://subagenttree/session/${encodeURIComponent(ROOT)}`)
    expect(parseSubagentTreeAddress(ADDRESS)).toBe(ROOT)
  })

  it.each([
    'not an address',
    'https://subagenttree/session/root',
    'dsh-resource://other/session/root',
    'dsh-resource://subagenttree/other/root',
    'dsh-resource://subagenttree/session/%',
  ])('rejects %s', (value) => {
    expect(parseSubagentTreeAddress(value)).toBeUndefined()
  })
})

const NULL_TOKENS = {
  inputTokens: null, cacheReadTokens: null, cacheWriteShortTokens: null,
  cacheWriteLongTokens: null, cacheWriteTokens: null, outputTokens: null,
}

function node(sessionId: SessionId, overrides: Partial<SubagentTreeNode> = {}): SubagentTreeNode {
  return {
    sessionId, parentSessionId: ROOT, children: [], status: 'running', liveness: 'confirmed',
    model: null, modelSource: 'transcript', tokens: NULL_TOKENS,
    usageState: 'missing', cacheHitRate: null, elapsedMs: null, runs: 0, calls: 0,
    lastToolCall: null, seat: null, taskId: null, ...overrides,
  }
}

function treeFixture(): SubagentTreeView {
  return {
    asOf: Date.parse('2026-10-31T04:01:00Z'), complete: true, refreshIntervalMs: 5000,
    root: node(ROOT, {
      status: 'finished', endReason: 'completed', elapsedMs: 2000, model: 'transcript-model-root', runs: 1, calls: 2,
      tokens: { ...NULL_TOKENS, inputTokens: 30, cacheReadTokens: 40, cacheWriteShortTokens: 6, cacheWriteLongTokens: 4, outputTokens: 10 },
      usageState: 'partial', cacheHitRate: 40 / 88,
      children: [node(CHILD, {
        status: 'waiting', model: 'transcript-model-child', runs: 1, calls: 1, seat: 'seat-a', taskId: 'task-1',
        tokens: { ...NULL_TOKENS, inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 8, outputTokens: 5 },
        usageState: 'complete', cacheHitRate: 30 / 48, elapsedMs: 60000,
        lastToolCall: { name: 'fs_write', time: Date.parse('2026-10-31T04:00:30Z') },
        children: [node(GRANDCHILD, { parentSessionId: CHILD, status: 'running', model: null, modelSource: 'unavailable' })],
      })],
    }),
  }
}

type Snapshot = { status: ResourceStatus; value?: SubagentTreeView; failure?: RemoteError }

function renderTab(snapshot: Snapshot, dictionary: typeof en = en, label: (id: SessionId) => string = id => id) {
  const props = {
    useTabInfo: () => ({ tab: { contentId: ADDRESS } }),
    useResource: (_address: string) => snapshot,
    t: (key: string) => dictionary[key as keyof typeof dictionary] ?? key,
    labelOf: label,
  } as Parameters<typeof SubagentTreeTab>[0]
  return render(<SubagentTreeTab {...props} />)
}

describe('subagent tree tab', () => {
  it('renders the three-generation rows with state, model, tokens, and hit rate', () => {
    const view = renderTab({ status: 'live', value: treeFixture() })
    expect(view.getAllByRole('row')).toHaveLength(4)
    const childRow = view.getByText('session/child').closest('tr')!
    expect(childRow.textContent).toContain(en.waiting)
    expect(childRow.textContent).toContain('transcript-model-child')
    expect(childRow.textContent).toContain('10 / 30 / 5')
    expect(childRow.textContent).toContain('63%')
    expect(view.getByText('session/root').closest('tr')!.textContent).toContain(`${en.finished} · ${en.completed}`)
    expect(view.getByText('session/grandchild').closest('tr')!.textContent).toContain(en.modelUnknown)
  })

  it('keeps an unknown model explicit and never shows a stop control', () => {
    const view = renderTab({ status: 'live', value: treeFixture() })
    expect(view.getByText(en.modelUnknown)).toBeTruthy()
    expect(view.getAllByRole('button')).toHaveLength(3)
    expect(view.getAllByRole('button').every(button => button.textContent === en.monitor)).toBe(true)
  })

  it('opens the read-only monitoring view from a row and states every unknown', async () => {
    const view = renderTab({ status: 'live', value: treeFixture() })
    fireEvent.click(view.getAllByRole('button', { name: en.monitor })[1]!)
    const dialog = await view.findByRole('dialog')
    expect(dialog.textContent).toContain('transcript-model-child')
    expect(dialog.textContent).toContain(en.complete)
    expect(dialog.textContent).toContain('fs_write')
    expect(dialog.textContent).toContain('60000 ms')
    expect(dialog.textContent).toContain('seat-a')
    expect(dialog.textContent).toContain('task-1')
    fireEvent.click(view.getByRole('button', { name: en.monitorClose }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('shows the monitoring unknowns for a fresh node', () => {
    const view = renderTab({ status: 'live', value: { ...treeFixture(), root: node(ROOT) } })
    fireEvent.click(view.getAllByRole('button', { name: en.monitor })[0]!)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain(en.modelUnknown)
    expect(dialog.textContent).toContain(en.noToolCall)
    expect(dialog.textContent).toContain(en.noSeat)
    expect(dialog.textContent).toContain(en.noTask)
  })

  it.each([
    ['unauthorized', { status: 'failed', failure: new RemoteError('subagentTree/unauthorized', 'x', {}) }] as const,
    ['disabled', { status: 'failed', failure: new RemoteError('subagentTree/disabled', 'x', {}) }] as const,
    ['error', { status: 'failed' }] as const,
    ['failed', { status: 'failed', value: treeFixture() }] as const,
    ['loading', { status: 'loading' }] as const,
    ['idle', { status: 'none' }] as const,
    ['partial', { status: 'live', value: { ...treeFixture(), complete: false } }] as const,
    ['empty', { status: 'live', value: { ...treeFixture(), root: node(ROOT) } }] as const,
    ['success', { status: 'live', value: treeFixture() }] as const,
  ])('renders the %s state copy', (state, snapshot) => {
    const view = renderTab(snapshot)
    expect(view.getByText(en[state])).toBeTruthy()
  })

  it('renders the Chinese dictionary copy for the same live view', () => {
    const view = renderTab({ status: 'live', value: treeFixture() }, zh)
    expect(view.getByText(zh.waiting)).toBeTruthy()
    expect(view.getByText(zh.modelUnknown)).toBeTruthy()
  })

  it('labels rows through the session projection with the session id fallback', () => {
    const view = renderTab({ status: 'live', value: treeFixture() }, en, id => id === CHILD ? 'Worker one' : id)
    expect(view.getByText('Worker one')).toBeTruthy()
    expect(view.getByText('session/root')).toBeTruthy()
  })
})

describe('subagent tree action pill', () => {
  it('opens this session tree page on click', () => {
    const open = vi.fn()
    const props = {
      sessionId: ROOT, t: (key: string) => en[key as keyof typeof en] ?? key,
      open,
    } as Parameters<typeof SubagentTreeAction>[0]
    const view = render(<SubagentTreeAction {...props} />)
    fireEvent.click(view.getByRole('button'))
    expect(open).toHaveBeenCalledWith(ROOT)
  })
})
