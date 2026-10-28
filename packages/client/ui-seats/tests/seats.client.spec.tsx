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
    expect(screen.getByText('Unknown')).toBeTruthy()
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
