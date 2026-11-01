// @vitest-environment jsdom
/** Profile edits and deletion retain observed CAS and impact until explicit confirmation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SeatDefinition, SeatImportPlan, SeatImportPlanId, SeatDigest } from '@panedesk/dsh-seat/types'
import type { SeatProfileSnapshot } from '../src/types.ts'
import { Profiles, type ProfilesProps } from '../src/client/Profiles.tsx'
import { en, zh } from '../src/client/locales.ts'

const definition: SeatDefinition = { schemaVersion: 1, revision: 1, seat: 'seat-a' as never, platform: 'server', node: 'node-a',
  projectId: 'project-a' as never, directories: [{ path: '/work', startup: true }], memoryDirectories: [], opening: { kind: 'text', text: 'Draft' },
  openingInstructionFiles: ['/charter.md'], agentPreset: 'standard', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', permissionPreset: 'read-only',
  subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 1, subagentContextThresholdTokens: 400000, rules: [],
  worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 } }
function text(copy: Record<string, string>, key: string, params?: Record<string, string>): string {
  const template = copy[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
function fixture(language: 'en' | 'zh') {
  const copy = language === 'en' ? en : zh
  const snapshot: SeatProfileSnapshot = { revision: 7, engineSequence: 3, authority: 'seat-store', definitions: [definition], windows: [{ seat: definition.seat, sessionId: 'window-a' as SeatProfileSnapshot['windows'][number]['sessionId'], nodeId: 'node-a' as SeatProfileSnapshot['windows'][number]['nodeId'], title: 'Active draft', stateVersion: 3, stateKnown: true }],
    pending: [{ seat: definition.seat, queueItemId: 'approval-a' as SeatProfileSnapshot['pending'][number]['queueItemId'], reason: 'approval', stateVersion: 2 }], recentOpen: {} }
  const save = vi.fn(async () => 8), remove = vi.fn(async () => {})
  const translate = (key: keyof typeof en, params?: Record<string, unknown>): string =>
    text(copy, key, params as Record<string, string> | undefined)
  const props = { t: translate,
    useStore: (select: (state: { seat: typeof definition.seat }) => unknown) => select({ seat: definition.seat }),
    useResource: () => ({ status: 'live', value: snapshot }), actions: { select: vi.fn() },
    takeover: vi.fn(), save, remove, preview: vi.fn(), commit: vi.fn(), refresh: vi.fn(), presets: [] } as ProfilesProps
  return { copy, props, snapshot, save, remove }
}
afterEach(cleanup)
describe('seat profile settings', () => {
  it.each(['loading', 'failed', 'empty'] as const)('keeps the %s observation explicit without writing profiles', (state) => {
    const f = fixture('en')
    const value = state === 'empty' ? { ...f.snapshot, definitions: [] } : undefined
    const useResource = (() => ({ status: state === 'failed' ? 'failed' : state === 'empty' ? 'live' : 'loading', value, failure: undefined })) as ProfilesProps['useResource']
    render(<Profiles {...f.props} useResource={useResource} />)
    expect(screen.getByText(f.copy[state === 'failed' ? 'unavailable' : state === 'empty' ? 'empty' : 'loading'])).toBeTruthy()
    expect(f.save).not.toHaveBeenCalled()
    expect(f.remove).not.toHaveBeenCalled()
    if (state === 'failed') {
      fireEvent.click(screen.getByRole('button', { name: f.copy.refresh }))
      expect(f.props.refresh).toHaveBeenCalledOnce()
    }
  })
  it.each(['en', 'zh'] as const)('lists windows and pending approvals before confirmed deletion: %s', async (language) => {
    const f = fixture(language)
    render(<Profiles {...f.props} />)
    expect(screen.getByLabelText(f.copy.openingInstructionFiles)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    const modal = screen.getByRole('dialog')
    expect(within(modal).getByText(f.copy.removeWarning)).toBeTruthy()
    expect(within(modal).getByText('Active draft — window-a')).toBeTruthy()
    expect(within(modal).getByText('approval-a — approval')).toBeTruthy()
    expect(within(modal).getByText(`${f.copy.stateVersion}: 3`)).toBeTruthy()
    expect(f.remove).not.toHaveBeenCalled()
    fireEvent.click(within(modal).getByRole('button', { name: f.copy.confirmRemove }))
    expect(f.remove).toHaveBeenCalledWith(f.snapshot, 'seat-a')
    expect(await screen.findByText(f.copy.removed)).toBeTruthy()
  })
  it.each(['en', 'zh'] as const)('marks a cold window in the deletion confirmation and keeps other seats selectable: %s', (language) => {
    const f = fixture(language)
    const cold = { ...f.snapshot.windows[0]!, stateVersion: null, stateKnown: false }
    const snapshot = { ...f.snapshot, windows: [cold] }
    const useResource = (() => ({ status: 'live', value: snapshot, failure: undefined })) as ProfilesProps['useResource']
    render(<Profiles {...f.props} useResource={useResource} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    const modal = screen.getByRole('dialog')
    expect(within(modal).getByText(f.copy.stateUnknown)).toBeTruthy()
    expect(within(modal).queryByText(`${f.copy.stateVersion}: 0`)).toBeNull()
    expect(within(modal).getByRole('button', { name: f.copy.confirmRemove }).hasAttribute('disabled')).toBe(false)
  })
  it.each(['en', 'zh'] as const)('shows the cold-window refusal and its repair when deletion is rejected: %s', async (language) => {
    const f = fixture(language)
    f.remove.mockRejectedValueOnce(Object.assign(new Error('evidence-unavailable'), { name: 'SeatWriteRejected' }))
    render(<Profiles {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: f.copy.confirmRemove }))
    expect(await screen.findByText(f.copy.rejectEvidenceUnavailable)).toBeTruthy()
    expect(f.save).not.toHaveBeenCalled()
  })
  it.each(['en', 'zh'] as const)('blocks save and deletion after a timeout until a refreshed observation arrives: %s', async (language) => {
    const f = fixture(language)
    f.save.mockRejectedValueOnce(new Error('Timed out'))
    const view = render(<Profiles {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    expect(await screen.findByText(f.copy.failed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: f.copy.refresh }))
    expect(screen.getByRole('button', { name: f.copy.save }).hasAttribute('disabled')).toBe(true)
    const useResource = (() => ({ status: 'live', value: { ...f.snapshot, revision: 8 }, failure: undefined })) as ProfilesProps['useResource']
    view.rerender(<Profiles {...f.props} useResource={useResource} />)
    expect(screen.getByRole('button', { name: f.copy.save }).hasAttribute('disabled')).toBe(false)
  })
  it('does not accept an observation requested before the write became unknown', async () => {
    const f = fixture('en')
    const pending = Promise.withResolvers<number>()
    f.save.mockImplementationOnce(() => pending.promise)
    const view = render(<Profiles {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    fireEvent.click(screen.getByRole('button', { name: f.copy.refresh }))
    pending.reject(new Error('Timed out'))
    await screen.findByText(f.copy.failed)
    const useResource = (() => ({ status: 'live', value: { ...f.snapshot, revision: 8 }, failure: undefined })) as ProfilesProps['useResource']
    view.rerender(<Profiles {...f.props} useResource={useResource} />)
    expect(screen.getByRole('button', { name: f.copy.save }).hasAttribute('disabled')).toBe(true)
    expect(f.save).toHaveBeenCalledOnce()
  })
  it.each(['en', 'zh'] as const)('blocks writes after a deletion timeout even when the editor is reselected: %s', async (language) => {
    const f = fixture(language)
    f.remove.mockRejectedValueOnce(new Error('Disconnected'))
    render(<Profiles {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: f.copy.confirmRemove }))
    await screen.findByText(f.copy.failed)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: f.copy.confirmRemove }))
    expect(f.remove).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: f.copy.save }).hasAttribute('disabled')).toBe(true)
  })
  it.each(['en', 'zh'] as const)('keeps the edited draft when CAS rejects it: %s', async (language) => {
    const f = fixture(language)
    f.save.mockRejectedValue(new Error('revision-conflict'))
    render(<Profiles {...f.props} />)
    fireEvent.change(screen.getByLabelText(f.copy.model), { target: { value: 'model-b' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    expect(await screen.findByText(f.copy.conflict)).toBeTruthy()
    expect(f.save).toHaveBeenCalledWith({ ...definition, revision: 2, model: 'model-b' }, 7)
    expect(screen.getByLabelText<HTMLInputElement>(f.copy.model).value).toBe('model-b')
  })
  it.each(['en', 'zh'] as const)('retains drafts and blocks an already-open deletion dialog after observation fails: %s', (language) => {
    const f = fixture(language)
    const { rerender } = render(<Profiles {...f.props} />)
    fireEvent.change(screen.getByLabelText(f.copy.model), { target: { value: 'unsaved-model' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.remove }))
    const useResource = (() => ({ status: 'failed', value: f.snapshot, failure: undefined })) as ProfilesProps['useResource']
    rerender(<Profiles {...f.props} useResource={useResource} />)
    expect(screen.getByRole('alert').textContent).toBe(f.copy.unavailable)
    expect(screen.getByLabelText<HTMLInputElement>(f.copy.model).value).toBe('unsaved-model')
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: f.copy.confirmRemove })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirm)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })
  it.each(['en', 'zh'] as const)('requires separate confirmation before transferring source authority: %s', async (language) => {
    const f = fixture(language)
    f.snapshot.authority = 'import-source'
    const takeover = vi.fn(async () => {})
    render(<Profiles {...f.props} takeover={takeover} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.takeover }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(f.copy.takeoverWarning)).toBeTruthy()
    expect(takeover).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: f.copy.confirmTakeover }))
    expect(takeover).toHaveBeenCalledWith(7)
    expect(await screen.findByText(f.copy.takenOver)).toBeTruthy()
  })
  it.each(['en', 'zh'] as const)('advances CAS after saving without discarding the next draft: %s', async (language) => {
    const f = fixture(language)
    f.save.mockResolvedValueOnce(8).mockResolvedValueOnce(9)
    render(<Profiles {...f.props} />)
    fireEvent.change(screen.getByLabelText(f.copy.model), { target: { value: 'model-b' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    await screen.findByText(f.copy.saved)
    fireEvent.change(screen.getByLabelText(f.copy.node), { target: { value: 'node-b' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    await screen.findByText(f.copy.saved)
    expect(f.save).toHaveBeenLastCalledWith({ ...definition, revision: 3, model: 'model-b', node: 'node-b' }, 8)
  })
  it.each(['en', 'zh'] as const)('blocks a timed-out import until refreshed observations arrive: %s', async (language) => {
    const f = fixture(language)
    const plan: SeatImportPlan = { planId: 'plan-a' as SeatImportPlanId, sourceFileHash: 'source-a' as SeatDigest,
      mappingHash: 'mapping-a' as SeatDigest, baseRevision: 7,
      rows: [{ row: 1, seat: definition.seat, definition, rowHash: 'row-a' as SeatDigest, columnHashes: {}, action: 'create', selected: false, diagnostics: [], differences: [] }] }
    const commit = vi.fn(async () => { throw new Error('Timed out') })
    render(<Profiles {...f.props} preview={async () => plan} commit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.import }))
    fireEvent.change(screen.getByLabelText(f.copy.sourcePath), { target: { value: '/source.csv' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.preview }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: f.copy.commit }))
    await screen.findByText(f.copy.failed)
    expect(screen.getByRole('button', { name: f.copy.preview }).closest('fieldset')?.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: f.copy.refresh }))
    expect(screen.getByRole('button', { name: f.copy.preview }).closest('fieldset')?.disabled).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
  })
  it.each(['en', 'zh'] as const)('previews a table and imports only explicitly checked rows: %s', async (language) => {
    const f = fixture(language)
    const plan: SeatImportPlan = { planId: 'plan-a' as SeatImportPlanId, sourceFileHash: 'source-a' as SeatDigest,
      mappingHash: 'mapping-a' as SeatDigest, baseRevision: 7,
      rows: [1, 2].map(row => ({ row, seat: definition.seat, definition, rowHash: `row-${row}` as SeatDigest,
        columnHashes: {}, action: 'create', selected: false, diagnostics: [], differences: [] })) }
    const preview = vi.fn(async () => plan), commit = vi.fn(async () => {})
    render(<Profiles {...f.props} preview={preview} commit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.import }))
    fireEvent.change(screen.getByLabelText(f.copy.sourcePath), { target: { value: '/source.csv' } })
    fireEvent.change(screen.getByLabelText(f.copy.format), { target: { value: 'csv' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.preview }))
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(screen.getByRole('button', { name: f.copy.commit }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(boxes[1]!)
    fireEvent.click(screen.getByRole('button', { name: f.copy.commit }))
    expect(commit).toHaveBeenCalledWith(plan, [2])
    expect(await screen.findByText(f.copy.imported)).toBeTruthy()
    expect(preview).toHaveBeenCalledWith({ sourcePath: '/source.csv', format: 'csv', mapping: '{"seat":"seat"}', defaults: '{}', table: '' })
  })

  it.each(['en', 'zh'] as const)('names the catalog authority refusal when a profile save is rejected: %s', async (language) => {
    const f = fixture(language)
    f.save.mockRejectedValueOnce(Object.assign(new Error('import-source-authoritative'), { name: 'SeatWriteRejected' }))
    render(<Profiles {...f.props} />)
    fireEvent.change(screen.getByLabelText(f.copy.model), { target: { value: 'model-b' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    expect((await screen.findByRole('status')).textContent).toBe(f.copy.rejectImportSourceAuthoritative)
    expect(screen.getByRole('button', { name: f.copy.save }).hasAttribute('disabled')).toBe(false)
  })
  it.each(['en', 'zh'] as const)('names the import source refusal when a selected import is rejected: %s', async (language) => {
    const f = fixture(language)
    const plan: SeatImportPlan = { planId: 'plan-a' as SeatImportPlanId, sourceFileHash: 'source-a' as SeatDigest,
      mappingHash: 'mapping-a' as SeatDigest, baseRevision: 7,
      rows: [{ row: 1, seat: definition.seat, definition, rowHash: 'row-a' as SeatDigest, columnHashes: {}, action: 'create', selected: false, diagnostics: [], differences: [] }] }
    const commit = vi.fn(async () => { throw Object.assign(new Error('seat-store-authoritative'), { name: 'SeatWriteRejected' }) })
    render(<Profiles {...f.props} preview={async () => plan} commit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.import }))
    fireEvent.change(screen.getByLabelText(f.copy.sourcePath), { target: { value: '/source.md' } })
    fireEvent.click(screen.getByRole('button', { name: f.copy.preview }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: f.copy.commit }))
    expect((await screen.findByRole('status')).textContent).toBe(f.copy.rejectSeatStoreAuthoritative)
    expect(screen.getByRole('button', { name: f.copy.preview }).closest('fieldset')?.disabled).toBe(false)
  })
  it.each(['en', 'zh'] as const)('keeps an unrecognized refusal code visible instead of the generic failure: %s', async (language) => {
    const f = fixture(language)
    f.save.mockRejectedValueOnce(Object.assign(new Error('not-a-seat-code'), { name: 'SeatWriteRejected' }))
    render(<Profiles {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }))
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(text(f.copy, 'rejectUnknown', { code: 'not-a-seat-code' }))
    expect(status.textContent).not.toBe(f.copy.failed)
  })
})
