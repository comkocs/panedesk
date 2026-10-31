/** Visible conversations share one budget across every layout commit. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTabPane, getPane, record, type TabId } from '@panedesk/dsh-client-ui-dockkit'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { readSidebarLayout } from '../src/client/persistence.ts'

const SESSION = 'budget-session'

function harness() {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const actions = instance.actions
  actions.open(SESSION)
  const surface = () => instance.getSnapshot().bySession[SESSION]!
  const open = (name: string, kind = 'session', preferNewPane = false) => {
    let opened: TabId | undefined
    actions.openContent(SESSION, { kind, contentId: `resource:${name}`, title: name, preferNewPane }, (id) => { opened = id })
    return opened
  }
  const float = (name: string) => {
    const tab = open(name)!
    actions.floatTab(SESSION, tab)
    return tab
  }
  return { instance, actions, surface, open, float }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('visible session budget', () => {
  it.each(['session', 'subagentchat'])('rejects an over-budget %s open without publishing navigation', (kind) => {
    const h = harness()
    h.float('one')
    h.float('two')
    const before = h.surface()
    expect(h.open('three', kind)).toBeUndefined()
    expect(h.surface()).toBe(before)
  })

  it('rejects floating a hidden session when two other sessions are visible', () => {
    const h = harness()
    const hidden = h.open('hidden')!
    h.open('shown')
    h.float('floating')
    const before = h.surface()
    h.actions.floatTab(SESSION, hidden)
    expect(h.surface()).toBe(before)
  })

  it('rejects a drop that reveals an extra session pane', () => {
    const h = harness()
    const hidden = h.open('hidden')!
    h.open('shown')
    h.float('floating')
    const before = h.surface()
    h.actions.dropTab(SESSION, hidden, findTabPane(before.layout, hidden).id, 'right')
    expect(h.surface()).toBe(before)
  })

  it('rejects copying a floating session into a non-session dock pane at the limit', () => {
    const h = harness()
    const first = h.float('one')
    h.float('two')
    const before = h.surface()
    h.actions.duplicateTab(SESSION, first)
    expect(h.surface()).toBe(before)
  })

  it('does not count hidden tabs and permits another float after collapsing the dock', () => {
    const h = harness()
    const hidden = h.open('hidden')!
    h.open('shown')
    h.float('floating')
    h.actions.setExpanded(SESSION, false)
    h.actions.floatTab(SESSION, hidden)
    expect(h.surface().layout.floats).toHaveLength(2)
    const before = h.surface()
    h.actions.setExpanded(SESSION, true)
    expect(h.surface()).toBe(before)
    h.actions.closeTab(SESSION, hidden)
    expect(h.open('replacement')).toBeDefined()
  })

  it.each(['undo', 'redo'] as const)('rejects over-budget legacy %s without moving its cursor', (direction) => {
    const h = harness()
    h.float('one')
    h.float('two')
    const current = h.surface()
    const pane = getPane(current.layout, current.layout.rootId)
    const guide = current.layout.tabs[pane.activeTabId!]!
    const changed = record(current.history, current.layout, [{
      type: 'openTab', paneId: pane.id, index: pane.tabs.length,
      tab: { ...guide, id: 'tab999' as TabId, kind: 'session', contentId: 'resource:legacy' },
    }])
    const entry = changed.history.entries.at(-1)!
    const history = direction === 'redo'
      ? { entries: [entry], cursor: 0 }
      : { entries: [{ ops: entry.inverse, inverse: entry.ops }], cursor: 1 }
    h.instance.store.set({ bySession: { [SESSION]: { ...current, history } } })
    const before = h.surface()
    h.actions[direction](SESSION)
    expect(h.surface()).toBe(before)
  })

  it('rejects an over-budget saved layout before rendering any session body', () => {
    const h = harness()
    h.float('one')
    h.float('two')
    const current = h.surface()
    const root = getPane(current.layout, current.layout.rootId)
    const guideId = root.activeTabId!
    const guide = current.layout.tabs[guideId]!
    const layout = { ...current.layout, tabs: { ...current.layout.tabs, [guideId]: { ...guide, kind: 'session' } } }
    const removeItem = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ bySession: { [SESSION]: { ...current, layout } } }),
      removeItem,
    })
    expect(readSidebarLayout(SESSION)).toBeUndefined()
    expect(removeItem).toHaveBeenCalledWith(`dsh.sidebar-right.v1.${SESSION}`)
  })
})
