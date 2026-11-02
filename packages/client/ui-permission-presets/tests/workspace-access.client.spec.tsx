// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@panedesk/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@panedesk/dsh-client-ui-slots'
import { WorkspaceAccessRow, type WorkspaceAccessRowProps } from '../src/client/WorkspaceAccessRow.tsx'
import type { WorkspaceAccessState } from '../src/client/workspace-access-store.ts'
import { workspaceEn, workspaceZh } from '../src/client/locales.ts'

afterEach(cleanup)
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const runtime = {
  ...allowAllAccess,
  useSessions: (() => { throw new Error('unused') }) as never,
  useWorkspaces: (() => { throw new Error('unused') }) as never,
  useSessionStatus: (() => { throw new Error('unused') }) as never,
  usePanelInfo: (() => { throw new Error('unused') }) as never,
  useSessionRetainInfo: () => undefined,
  useResource,
}
it.each([workspaceEn, workspaceZh])('shows authorization origins and routes select/revoke actions through callbacks', async (dictionary) => {
  const store = createSnapshotStore<WorkspaceAccessState>({ status: 'ready', supported: true, error: null, entries: [
    { workspace: 'C:\\project', source: 'legacy' },
    { workspace: 'C:\\pending', source: 'revocation-pending' },
    { workspace: 'C:\\recorded', source: 'first-confirmation', grantedAt: '2026-11-02T00:00:00.000Z' },
  ] })
  const selectDirectory = vi.fn(async () => {})
  const revoke = vi.fn(async () => {})
  const copy: Record<string, string> = dictionary
  const t: WorkspaceAccessRowProps['t'] = key => copy[key] ?? key
  render(<WorkspaceAccessRow {...runtime} t={t} load={async () => {}} selectDirectory={selectDirectory}
    revoke={revoke} useWorkspaceGrants={bindSnapshotSelector(store)} />)
  expect(screen.getByText(dictionary.title)).toBeDefined()
  expect(screen.getByText(dictionary.legacy)).toBeDefined()
  expect(screen.getByText(dictionary.pending)).toBeDefined()
  expect(screen.getByText('C:\\project')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: dictionary.preauthorize }))
  expect(selectDirectory).toHaveBeenCalledOnce()
  fireEvent.click(screen.getAllByRole('button', { name: dictionary.revoke })[0]!)
  expect(revoke).toHaveBeenCalledWith('C:\\project')
  fireEvent.click(screen.getAllByRole('button', { name: dictionary.revoke })[1]!)
  expect(revoke).toHaveBeenCalledWith('C:\\pending')
})
