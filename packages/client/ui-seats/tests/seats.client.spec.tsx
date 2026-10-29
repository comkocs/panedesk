// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeatDefinition } from '@panedesk/dsh-seat/types'
import type { SeatOverview } from '../src/types.ts'
import { SeatHeader, SeatPicker, SeatsSection, type SeatHeaderProps, type SeatPickerProps, type SeatsSectionProps } from '../src/client/Seats.tsx'
import { en } from '../src/client/locales.ts'

const seat: SeatDefinition = {
  schemaVersion: 1, revision: 1, seat: 'seat-a' as never, platform: 'server', node: 'node-a', projectId: 'project-a' as never,
  directories: [{ path: '/profile', startup: true }], memoryDirectories: ['/memory'], opening: { kind: 'text', text: 'Opening draft' },
  openingInstructionFiles: [], agentPreset: 'agent-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  permissionPreset: 'read-only', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 2,
  subagentContextThresholdTokens: 400000, rules: [],
  worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
}
const data: SeatOverview = { available: true, definitions: [seat], windows: [], complete: true }
function fixture(value = data, cwd?: string, notice: { seq: number; message: string; sessionId?: string } | null = null) {
  const openSeat = vi.fn(async () => {})
  const unused = (() => { throw new Error('Unused fixture hook') }) as never
  const props = {
    wide: true, currentDirectory: cwd,
    sessionId: cwd === undefined ? undefined : 'session-a' as never,
    useSession: unused, useProjection: unused, useAccess: unused, useConversation: unused, useInput: unused,
    useRemoteAccess: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: unused,
    usePanelInfo: unused, useWorkspaces: unused, useWorkspaceAccess: unused,
    inputActions: undefined,
    useResource: (() => ({ status: 'live' as const, value, failure: undefined })) as SeatPickerProps['useResource'],
    useSessions: ((select: (snapshot: object) => unknown) => select({ ids: ['session-a'], byId: { 'session-a': { cwd, retainedBy: { mainView: 1 } } } })) as SeatPickerProps['useSessions'],
    useSeatNotice: ((select: (value: typeof notice) => unknown) => select(notice)) as SeatHeaderProps['useSeatNotice'],
    openSeat, openWindow: vi.fn(), dismiss: vi.fn(),
    t: (key: keyof typeof en) => en[key],
  }
  return { props, openSeat }
}
afterEach(cleanup)

describe('seat entry presentations', () => {
  it('shows a cold-start picker and optional sidebar, hiding unavailable, empty and collapsed sections', () => {
    const f = fixture()
    const view = render(<SeatPicker {...f.props as SeatPickerProps} />)
    expect(screen.getByRole('button', { name: 'Seat' })).toBeTruthy()
    view.unmount()
    const section = render(<SeatsSection {...f.props as SeatsSectionProps} wide />)
    expect(screen.getByRole('region', { name: 'Seats' })).toBeTruthy()
    expect(screen.getByText('Not open')).toBeTruthy()
    section.rerender(<SeatsSection {...f.props as SeatsSectionProps} wide={false} />)
    expect(screen.queryByRole('region')).toBeNull()
    section.unmount()
    for (const value of [{ ...data, available: false }, { ...data, definitions: [] }]) {
      const hidden = fixture(value)
      const entries = render(<>
        <SeatPicker {...hidden.props as SeatPickerProps} /><SeatsSection {...hidden.props as SeatsSectionProps} wide />
      </>)
      expect(screen.queryByRole('button')).toBeNull()
      entries.unmount()
    }
  })
  it.each(['Use profile directory', 'Stay in this directory', 'Cancel'])('handles directory choice: %s', async (choice) => {
    const f = fixture(data, '/current')
    render(<SeatPicker {...f.props as SeatPickerProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Seat' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'seat-a' }))
    expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : 1)
    if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenCalledWith(seat, '/current')
    if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenCalledWith(seat)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it.each(['Use profile directory', 'Stay in this directory', 'Cancel'])('handles sidebar directory choice: %s', (choice) => {
    const f = fixture(data, '/current')
    render(<SeatsSection {...f.props as SeatsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open seat' }))
    expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : 1)
    if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenCalledWith(seat, '/current')
    if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenCalledWith(seat)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it.each(['Use profile directory', 'Stay in this directory', 'Cancel'])('uses the sidebar projected directory after cd and refresh: %s', (choice) => {
    const registered = { ...seat, directories: [...seat.directories, { path: '/current', startup: false }] }
    const f = fixture({ ...data, definitions: [registered] }, '/profile')
    const useSessions = ((select: (value: object) => unknown) => select({ ids: ['session-a'], byId: {
      'session-a': { cwd: '/profile', retainedBy: { mainView: 1 }, projectionValues: { workingDirectory: '/current' } },
    } })) as SeatsSectionProps['useSessions']
    const view = render(<SeatsSection {...f.props as SeatsSectionProps} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<SeatsSection {...f.props as SeatsSectionProps} useSessions={useSessions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open seat' }))
    expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : 1)
    if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenCalledWith(registered, '/current')
    if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenCalledWith(registered)
    view.unmount()
    render(<SeatsSection {...f.props as SeatsSectionProps} useSessions={useSessions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open seat' }))
    expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : 2)
    if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenLastCalledWith(registered, '/current')
    if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenLastCalledWith(registered)
  })
  it('does not open from an ambiguous main-view directory', () => {
    const f = fixture(data, '/current')
    const useSessions = ((select: (value: object) => unknown) => select({ ids: ['session-a', 'session-b'], byId: {
      'session-a': { cwd: '/current', retainedBy: { mainView: 1 } },
      'session-b': { cwd: '/other', retainedBy: { mainView: 1 } },
    } })) as SeatsSectionProps['useSessions']
    render(<SeatsSection {...f.props as SeatsSectionProps} useSessions={useSessions} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open seat' }).disabled).toBe(true)
    expect(f.openSeat).not.toHaveBeenCalled()
  })
  it.each([null, { status: 'rejected', error: { code: 'unavailable', message: 'Binding unavailable',
    alternative: 'Retry', retryable: true, effectState: 'none' } }] as const)('does not infer a free window from missing or rejected binding: %j', (binding) => {
    const f = fixture({ ...data, binding }, '/current')
    render(<SeatHeader {...f.props as SeatHeaderProps} />)
    expect(screen.getByText('Identity read failed')).toBeTruthy()
    expect(screen.queryByText('Free window')).toBeNull()
  })
  it.each(['Use profile directory', 'Stay in this directory', 'Cancel'])('uses the hero directory after cd and refresh: %s', async (choice) => {
    const registered = { ...seat, directories: [...seat.directories, { path: '/current', startup: false }] }
    const f = fixture({ ...data, definitions: [registered] }, '/profile')
    let view = render(<SeatPicker {...f.props as SeatPickerProps} />)
    view.rerender(<SeatPicker {...f.props as SeatPickerProps} currentDirectory="/current" />)
    for (let pass = 0; pass < 2; pass++) {
      fireEvent.click(screen.getByRole('button', { name: 'Seat' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'seat-a' }))
      expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: choice }))
      expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : pass + 1)
      if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenLastCalledWith(registered, '/current')
      if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenLastCalledWith(registered)
      view.unmount()
      if (pass === 0) view = render(<SeatPicker {...f.props as SeatPickerProps} currentDirectory="/current" />)
    }
  })
  it('keeps verified seat identity during failure and reconnect, then isolates a switched Session', () => {
    const binding = { kind: 'seat' as const, sessionId: 'session-a' as never, nodeId: 'node-a' as never,
      seat: seat.seat, projectId: seat.projectId, bindingSource: 'seat-definition' as const, identitySource: 'settings' as const,
      openOperationId: 'open-a' as never, seatRevision: 1, relatedTaskIds: [], directories: seat.directories,
      memoryDirectories: seat.memoryDirectories, subscriptions: [], openingDigest: 'digest-a' as never }
    const value: SeatOverview = { ...data, binding }
    const f = fixture(value, '/current')
    const view = render(<SeatHeader {...f.props as SeatHeaderProps} />)
    for (const status of ['failed', 'loading', 'live'] as const) {
      view.rerender(<SeatHeader {...f.props as SeatHeaderProps}
        useResource={(() => ({ status, value, failure: undefined })) as SeatHeaderProps['useResource']} />)
      expect(screen.getByText('seat-a · node-a')).toBeTruthy()
      if (status === 'live') expect(screen.queryByRole('status')).toBeNull()
      else expect(screen.getByRole('status')).toBeTruthy()
    }
    view.rerender(<SeatHeader {...f.props as SeatHeaderProps} sessionId={'session-b' as never} />)
    expect(screen.queryByText('seat-a · node-a')).toBeNull()
    expect(screen.getByText('Identity read failed')).toBeTruthy()
  })
  it('uses the cold-start owner directory without requiring a Session', async () => {
    const f = fixture(data, '/current')
    render(<SeatPicker {...f.props as SeatPickerProps} sessionId={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Seat' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'seat-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stay in this directory' }))
    expect(f.openSeat).toHaveBeenCalledWith(seat, '/current')
  })
  it('opens directly when the current directory matches the profile', async () => {
    const f = fixture(data, '/profile')
    const view = render(<SeatPicker {...f.props as SeatPickerProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Seat' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'seat-a' }))
    expect(f.openSeat).toHaveBeenCalledWith(seat)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.unmount()
    render(<SeatsSection {...f.props as SeatsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open seat' }))
    expect(f.openSeat).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('disables opening when the catalog is incomplete', () => {
    const f = fixture({ ...data, complete: false })
    render(<><SeatPicker {...f.props as SeatPickerProps} /><SeatsSection {...f.props as SeatsSectionProps} /></>)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Seat' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open seat' }).disabled).toBe(true)
    expect(f.openSeat).not.toHaveBeenCalled()
  })
  it('distinguishes explicit free metadata from unknown binding evidence', () => {
    const f = fixture(data, '/current')
    const view = render(<SeatHeader {...f.props as SeatHeaderProps} />)
    expect(screen.getByText('Identity read failed')).toBeTruthy()
    const free = fixture({ ...data, binding: { kind: 'free', sessionId: 'session-a' as never, nodeId: 'node-a' as never, identitySource: 'free' } }, '/current')
    view.rerender(<SeatHeader {...free.props as SeatHeaderProps} />)
    expect(screen.getByText('Free window')).toBeTruthy()
  })
  it('renders verified seat and node identity even when the window list is empty', () => {
    const f = fixture({ ...data, binding: { kind: 'seat', sessionId: 'session-a' as never, nodeId: 'node-a' as never,
      seat: seat.seat, projectId: seat.projectId, bindingSource: 'seat-definition', identitySource: 'settings',
      openOperationId: 'open-a' as never, seatRevision: 1, relatedTaskIds: [], directories: seat.directories,
      memoryDirectories: seat.memoryDirectories, subscriptions: [], openingDigest: 'digest-a' as never } }, '/current')
    render(<SeatHeader {...f.props as SeatHeaderProps} />)
    expect(screen.getByText('seat-a · node-a')).toBeTruthy()
    expect(screen.queryByText('Free window')).toBeNull()
  })
  it.each(['failed', 'loading'] as const)('preserves verified occurrence identity while the resource is %s', (status) => {
    const value: SeatOverview = { ...data, binding: { kind: 'free', sessionId: 'session-a' as never,
      nodeId: 'node-a' as never, identitySource: 'free' } }
    const f = fixture(value, '/current')
    render(<SeatHeader {...f.props as SeatHeaderProps}
      useResource={(() => ({ status, value, failure: undefined })) as SeatHeaderProps['useResource']} />)
    expect(screen.getByText('Free window')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(status === 'failed' ? 'failed' : 'Loading')
  })
  it.each(['failed', 'loading'] as const)('names an unverified identity state while the resource is %s', (status) => {
    const f = fixture(data, '/current')
    render(<SeatHeader {...f.props as SeatHeaderProps}
      useResource={() => ({ status, value: undefined, failure: undefined })} />)
    expect(screen.getByText(status === 'failed' ? 'Identity read failed' : 'Loading identity')).toBeTruthy()
    expect(screen.queryByText('Free window')).toBeNull()
    expect(screen.queryByText('Unknown')).toBeNull()
  })
  it('does not borrow a verified identity from a different occurrence', () => {
    const f = fixture({ ...data, binding: { kind: 'free', sessionId: 'other-session' as never,
      nodeId: 'node-a' as never, identitySource: 'free' } }, '/current')
    render(<SeatHeader {...f.props as SeatHeaderProps} />)
    expect(screen.queryByText('Free window')).toBeNull()
    expect(screen.getByText('Identity read failed')).toBeTruthy()
  })
  it('shows a coded memory refusal only in its addressed Session', () => {
    const notice = { seq: 1, message: 'Memory write refused [memory-seat-mismatch]', sessionId: 'session-a' }
    const other = fixture(data, undefined, notice)
    const view = render(<SeatHeader {...other.props as SeatHeaderProps} />)
    expect(screen.queryByText(notice.message)).toBeNull()
    const addressed = fixture(data, '/current', notice)
    view.rerender(<SeatHeader {...addressed.props as SeatHeaderProps} />)
    expect(screen.getByText(notice.message)).toBeTruthy()
  })
  it('renders free-window identity without borrowing another occurrence', () => {
    const f = fixture()
    render(<SeatHeader {...f.props as SeatHeaderProps} />)
    expect(screen.getByText('Free window')).toBeTruthy()
  })
})
