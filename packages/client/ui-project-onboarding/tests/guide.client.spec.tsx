// @vitest-environment jsdom
/** Localized first-entry guidance, explicit selection, and draft-only startup. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectGuide, ProjectSettings } from '../src/client/ProjectGuide.tsx'
import type { GuideProps, SettingsProps } from '../src/client/props.ts'
import type { ProjectPreferences } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(language: 'en' | 'zh', projects: ProjectPreferences['projects'] = {}) {
  const dictionary = language === 'en' ? en : zh
  const state: ProjectPreferences = { status: 'ready', writable: true, projects, revision: 0, error: false, saved: false }
  const unused = (() => { throw new Error('Unused fixture hook') }) as never
  const inputActions = {
    captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })),
    insertText: vi.fn(() => true), persistDraft: vi.fn(), setDraft: vi.fn(),
    addAttachments: vi.fn(() => true), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn(),
  }
  const props = {
    sessionId: 'session-a' as never,
    useSession: unused, useAccess: unused, useConversation: unused, useInput: unused,
    useRemoteAccess: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: unused,
    usePanelInfo: unused, useWorkspaceAccess: unused, useResource: unused, useChat: unused, useTrajectory: unused,
    usePreferences: ((select: (value: ProjectPreferences) => unknown) => select(state)) as GuideProps['usePreferences'],
    useWorkspaces: (() => ({ path: '/project', sessionIds: ['session-a'] })) as GuideProps['useWorkspaces'],
    useProjection: (() => '/project') as GuideProps['useProjection'],
    useSessions: (() => '/project') as GuideProps['useSessions'],
    select: vi.fn(async () => true), retry: vi.fn(async () => {}), close: vi.fn(), inputActions,
    t: (key: keyof typeof en) => dictionary[key],
  }
  return { props, state, dictionary }
}

describe('project opening guidance', () => {
  it('renders loading, empty, read-only, disabled, saved, and failed states with retry', () => {
    const { props, state, dictionary } = fixture('en')
    state.status = 'loading'
    const ui = render(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByRole('status').textContent).toBe(dictionary.loading)
    state.status = 'ready'
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByText(dictionary.empty)).toBeTruthy()
    state.projects = { '/project': { mode: 'remind', chosen: true } }
    state.writable = false
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByText(dictionary.readonly)).toBeTruthy()
    expect(ui.getByRole('button', { name: dictionary.save }).hasAttribute('disabled')).toBe(true)
    state.writable = true
    state.status = 'saving'
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByRole('button', { name: dictionary.saving }).hasAttribute('disabled')).toBe(true)
    state.status = 'ready'
    state.saved = true
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByText(dictionary.success)).toBeTruthy()
    state.saved = false
    state.error = true
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    expect(ui.getByRole('alert').textContent).toBe(dictionary.error)
    state.status = 'error'
    ui.rerender(<ProjectSettings {...props as SettingsProps} />)
    fireEvent.click(ui.getByRole('button', { name: dictionary.retry }))
    expect(props.retry).toHaveBeenCalledOnce()
  })

  it.each(['en', 'zh'] as const)('defaults to remind and saves only an explicit choice: %s', (language) => {
    const { props, dictionary } = fixture(language)
    const ui = render(<ProjectGuide {...props as GuideProps} />)
    expect(ui.getByRole('dialog', { name: dictionary.title })).toBeTruthy()
    expect(ui.getByRole('button', { name: dictionary.remind }).getAttribute('aria-pressed')).toBe('true')
    expect(props.select).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole('button', { name: dictionary.auto }))
    fireEvent.click(ui.getByRole('button', { name: dictionary.save }))
    expect(props.select).toHaveBeenCalledWith('/project', 'auto')
  })

  it('does not reopen for a confirmed workspace and leaves another workspace unchosen', () => {
    const { props } = fixture('en', { '/project': { mode: 'off', chosen: true } })
    const ui = render(<ProjectGuide {...props as GuideProps} />)
    expect(ui.queryByRole('dialog')).toBeNull()
    ui.rerender(<ProjectGuide {...{ ...props, useWorkspaces: (() => ({ path: '/other-project' })) as GuideProps['useWorkspaces'] } as GuideProps} />)
    expect(ui.getByRole('dialog')).toBeTruthy()
  })

  it('inserts the getting-started request without sending or opening a model turn', () => {
    const { props, dictionary } = fixture('zh')
    const ui = render(<ProjectGuide {...props as GuideProps} />)
    fireEvent.click(ui.getByRole('button', { name: dictionary.start }))
    expect(props.inputActions.insertText).toHaveBeenCalledWith(dictionary.request, { start: 0, end: 0, draftRev: 0 })
    expect(props.inputActions.persistDraft).toHaveBeenCalledOnce()
    expect(props.inputActions.submit).not.toHaveBeenCalled()
    expect(ui.queryByRole('dialog')).toBeNull()
  })

  it.each(['en', 'zh'] as const)('allows changing a saved mode from product settings: %s', (language) => {
    const { props, dictionary } = fixture(language, { '/project': { mode: 'remind', chosen: true } })
    const ui = render(<ProjectSettings {...props as SettingsProps} />)
    fireEvent.click(ui.getByRole('button', { name: dictionary.off }))
    fireEvent.click(ui.getByRole('button', { name: dictionary.save }))
    expect(props.select).toHaveBeenCalledWith('/project', 'off')
  })
})
