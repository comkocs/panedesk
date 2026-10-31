// @vitest-environment jsdom
/** Skill settings show localized directory groups and open only listed paths. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceId, WorkspaceSnapshot } from '@panedesk/dsh-api-workspace-controller/client'
import { SkillsSection } from '../src/client/SkillsSection.tsx'
import type { SkillPageEntry, SkillPageOperations } from '../src/client/catalog.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const ROWS: readonly SkillPageEntry[] = [
  { name: 'shipped', description: 'Ships with the app', group: 'builtin', path: '/app/skills/shipped/SKILL.md' },
  { name: 'mine', description: 'A user skill', group: 'user', path: '/users/example/skills/mine/SKILL.md' },
  { name: 'local', description: 'A project skill', group: 'project', path: '/project/.agents/skills/local/SKILL.md' },
]
const snapshot: WorkspaceSnapshot = {
  items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}
const useDirectories = <T,>(selector: (value: WorkspaceSnapshot) => T): T => selector(snapshot)

function operations(): SkillPageOperations {
  return {
    list: async () => ({ kind: 'listed', entries: ROWS, workspace: true }),
    open: async () => undefined,
  }
}

describe('SkillsSection', () => {
  it('passes a registered workspace identity without requiring a session', async () => {
    const workspaceId = 'project-workspace' as WorkspaceId
    const selected: WorkspaceSnapshot = { ...snapshot, items: [{ workspaceId, path: '/project', title: 'Project workspace', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }
    const base = operations()
    const list = vi.fn((id?: WorkspaceId) => base.list(id))
    render(<SkillsSection
      close={() => {}} operations={{ ...base, list }} t={key => en[key]}
      useDirectories={selector => selector(selected)}
    />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: workspaceId } })
    fireEvent.click(screen.getByRole('button', { name: 'Load skills' }))
    expect(await screen.findByText(ROWS[2]!.path)).toBeTruthy()
    expect(list).toHaveBeenCalledWith(workspaceId)
  })

  it('contains an open rejection and reports failure', async () => {
    render(<SkillsSection close={() => {}} operations={{ ...operations(), open: async () => { throw new Error('opener unavailable') } }} t={key => en[key]} useDirectories={useDirectories} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load skills' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open source file' }))[0]!)
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Opening the source file failed: opener unavailable')
  })

  it.each([
    { reason: 'disabled' as const, notice: 'Skill listing is turned off.' },
    { reason: 'denied' as const, notice: 'You do not have permission to list skills.' },
    { reason: 'unavailable' as const, notice: 'Skill listing is not available in this deployment.' },
  ])('shows $reason without exposing an open action', async ({ reason, notice }) => {
    render(<SkillsSection close={() => {}} operations={{ ...operations(), list: async () => ({ kind: 'refused', reason }) }} t={key => en[key]} useDirectories={useDirectories} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load skills' }))
    expect(await screen.findByText(notice)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open source file' })).toBeNull()
  })

  it.each([
    { locale: 'en', copy: en, load: 'Load skills', groups: ['Built-in', 'User', 'Project'], open: 'Open source file', opened: 'Opened the source file.' },
    { locale: 'zh', copy: zh, load: '加载技能', groups: ['内置', '用户级', '项目级'], open: '打开源文件', opened: '已打开源文件。' },
  ])('shows all three $locale groups, source paths, and host open feedback', async ({ copy, load, groups, open, opened }) => {
    const hostOpen = vi.fn(async (_path: string) => undefined)
    render(<SkillsSection
      close={() => {}} operations={{ ...operations(), open: hostOpen }} t={key => copy[key]}
      useDirectories={useDirectories}
    />)
    fireEvent.click(screen.getByRole('button', { name: load }))
    expect(await screen.findByRole('heading', { name: groups[0]! })).toBeTruthy()
    for (const group of groups) expect(screen.getByRole('heading', { name: group })).toBeTruthy()
    for (const row of ROWS) expect(screen.getByText(row.path)).toBeTruthy()
    for (const button of screen.getAllByRole('button', { name: open })) fireEvent.click(button)
    expect(await screen.findByText(opened)).toBeTruthy()
    expect(hostOpen.mock.calls).toEqual(ROWS.map(row => [row.path]))
  })

  it('shows empty and no-workspace states without creating a session', async () => {
    const list = vi.fn(async () => ({ kind: 'listed' as const, entries: [], workspace: false }))
    render(<SkillsSection close={() => {}} operations={{ ...operations(), list }} t={key => en[key]} useDirectories={useDirectories} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load skills' }))
    expect(await screen.findByText('No skills were found.')).toBeTruthy()
    expect(screen.getByText(en.noWorkspace)).toBeTruthy()
    expect(list).toHaveBeenCalledWith(undefined)
  })

  it('contains transport rejection and offers a retry', async () => {
    render(<SkillsSection close={() => {}} operations={{ ...operations(), list: async () => { throw new Error('offline') } }} t={key => en[key]} useDirectories={useDirectories} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load skills' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Loading skills failed: offline')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
