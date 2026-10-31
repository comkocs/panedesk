// @vitest-environment jsdom
/** The overview displays journal facts and sends only checked seat identities. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Overview, type OverviewProps } from '../src/client/Overview.tsx'
import { en, zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import type { SeatDefinition } from '@panedesk/dsh-seat/types'

const definition: SeatDefinition = { schemaVersion: 1, revision: 1, seat: 'seat-a' as never, platform: 'server', node: 'node-a',
  projectId: 'project-a' as never, directories: [{ path: '/work', startup: true }], memoryDirectories: [], opening: { kind: 'text', text: 'Draft' },
  openingInstructionFiles: [], agentPreset: 'standard', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', permissionPreset: 'read-only',
  subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 1, subagentContextThresholdTokens: 400000, rules: [],
  worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 } }
afterEach(cleanup)
describe('middle-column seat overview', () => {
  it.each(['en', 'zh'] as const)('shows real opening time and opens only checked seats: %s', async (language) => {
    const copy = language === 'en' ? en : zh
    const batch = vi.fn(async () => {})
    const value = { revision: 1, authority: 'seat-store' as const, definitions: [definition], windows: [], pending: [], recentOpen: { 'seat-a': '2026-01-02T03:04:05Z' } }
    const useResource: OverviewProps['useResource'] = (() => ({ status: 'live', value, failure: undefined })) as OverviewProps['useResource']
    const unused = (() => { throw new Error('Unused fixture hook') }) as never
    const props: OverviewProps = {
      useResource, batch, refresh: vi.fn(), t: key => Object.entries(copy).find(([name]) => name === key)?.[1] ?? key,
      usePanelInfo: unused, useRemoteAccess: unused, useSessions: unused, useSessionStatus: unused,
      useSessionRetainInfo: unused, useSessionAccess: unused, useWorkspaces: unused, useWorkspaceAccess: unused,
    }
    render(<Overview {...props} />)
    expect(screen.getByRole('heading', { name: copy.overview })).toBeTruthy()
    expect(screen.getByText('2026-01-02T03:04:05Z')).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.batchOpen }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'seat-a' }))
    fireEvent.click(screen.getByRole('button', { name: copy.batchOpen }))
    expect(batch).toHaveBeenCalledWith(['seat-a'])
    expect(await screen.findByText(copy.batchSuccess)).toBeTruthy()
  })
})
