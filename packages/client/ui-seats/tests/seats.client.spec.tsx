// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeatDefinition } from '@panedesk/dsh-seat/types'
import type { SeatOverview } from '../src/types.ts'
import { SeatHeader, SeatPicker, SeatsSection, type SeatHeaderProps, type SeatPickerProps, type SeatsSectionProps } from '../src/client/Seats.tsx'
import { en, zh } from '../src/client/locales.ts'

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
    wide: true, expandSidebar: vi.fn(), currentDirectory: cwd,
    sessionId: cwd === undefined ? undefined : 'session-a' as never,
    useSession: unused, useProjection: unused, useAccess: unused, useConversation: unused, useInput: unused,
    useRemoteAccess: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useSessionAccess: unused,
    usePanelInfo: unused, useWorkspaces: unused, useWorkspaceAccess: unused,
    inputActions: undefined,
    useResource: (() => ({ status: 'live' as const, value, failure: undefined })) as SeatPickerProps['useResource'],
    useSessions: ((select: (snapshot: object) => unknown) => select({ ids: ['session-a'], byId: { 'session-a': { cwd, retainedBy: { mainView: 1 } } } })) as SeatPickerProps['useSessions'],
    useSeatNotice: ((select: (value: typeof notice) => unknown) => select(notice)) as SeatHeaderProps['useSeatNotice'],
    openSeat, openWindow: vi.fn(), dismiss: vi.fn(),
    loadModels: vi.fn(async () => []), prepareAdd: vi.fn(async () => { throw new Error('Unused source preparation') }),
    previewAdd: vi.fn(async () => { throw new Error('Unused import preview') }), commitAdd: vi.fn(async () => {}),
    t: (key: keyof typeof en, params?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match)),
  }
  return { props, openSeat }
}
afterEach(cleanup)

describe('seat entry presentations', () => {
  it.each(['en', 'zh'] as const)('opens the single diagnostic location from a collapsed warning: %s', (language) => {
    const f = fixture({ ...data, diagnostics: { openings: [{ sessionId: 'absent-a' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'open-create-failed' }] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const expandSidebar = vi.fn()
    const props = { ...f.props, wide: false, expandSidebar, t }
    const view = render(<SeatsSection {...props as SeatsSectionProps} />)
    const label = language === 'en' ? 'Show seat alerts' : '查看工位告警'
    const indicator = screen.getByRole('button', { name: label })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(indicator.title).toBe(label)
    fireEvent.click(indicator)
    expect(expandSidebar).toHaveBeenCalledOnce()
    view.rerender(<SeatsSection {...{ ...props, wide: true } as SeatsSectionProps} />)
    expect(screen.queryByRole('button', { name: label })).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('region', { name: t('seats') }).contains(screen.getByRole('alert'))).toBe(true)
  })
  it('adds nothing to the collapsed sidebar when there are no diagnostics', () => {
    const f = fixture()
    const view = render(<SeatsSection {...f.props as SeatsSectionProps} wide={false} />)
    expect(view.container.childElementCount).toBe(0)
    view.rerender(<SeatsSection {...fixture({ ...data, diagnostics: { openings: [] } }).props as SeatsSectionProps} wide={false} />)
    expect(view.container.childElementCount).toBe(0)
  })
  it.each(['en', 'zh'] as const)('retains long preset and model diagnostics in one scrollable location: %s', (language) => {
    const preset = (language === 'en' ? 'LongPreset' : '超长预设').repeat(200)
    const model = (language === 'en' ? 'LongModel' : '超长模型').repeat(200)
    const f = fixture({ ...data, diagnostics: { openings: [
      { sessionId: 'preset-failure' as never, seat: seat.seat, agentPreset: preset, code: 'open-create-failed' },
      { sessionId: 'model-failure' as never, seat: seat.seat, agentPreset: preset, code: 'UNKNOWN_MODEL',
        stage: 'turn', provider: 'provider-a', model },
    ] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]!.textContent).toContain(preset)
    expect(alerts[1]!.textContent).toContain(model)
    expect(alerts[0]!.parentElement).toBe(alerts[1]!.parentElement)
  })
  it.each(['en', 'zh'] as const)('aggregates diagnostics once across the first-screen entries: %s', (language) => {
    const f = fixture({ ...data, diagnostics: { openings: [{ sessionId: 'absent-a' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'open-create-failed' }] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    render(<>
      <SeatPicker {...{ ...f.props, t } as SeatPickerProps} />
      <SeatHeader {...{ ...f.props, t } as SeatHeaderProps} />
      <SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />
    </>)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('region', { name: t('seats') }).contains(screen.getByRole('alert'))).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('seat-a')
    expect(screen.getByRole('button', { name: t('seat') })).toBeTruthy()
  })
  it.each(['en', 'zh'] as const)('names a live window model failure and its recovery condition: %s', (language) => {
    const f = fixture({ ...data, diagnostics: { openings: [{ sessionId: 'live-a' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'UNKNOWN_MODEL', stage: 'turn',
      provider: 'provider-a', model: 'live-model' }] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const view = render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    if (language === 'en') expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"seat-a: Model "provider-a/live-model" is unavailable [UNKNOWN_MODEL]; this window’s turn failed. Other seats and the engine continue. Restore the model and resend your message here; this alert clears after a completed resend or when this runtime is closed."')
    else expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"seat-a: 模型“provider-a/live-model”不可用 [UNKNOWN_MODEL]，此窗口回合失败，其他工位与引擎继续运行。请恢复模型后在此窗口重发消息；重发回合成功完成或此运行时关闭后，本告警清除。"')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('names an invalid definition and its seat-local recovery: %s', (language) => {
    const value = { ...data, diagnostics: { openings: [{ sessionId: 'invalid-opening' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'invalid-definition' as const }] } }
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const view = render(<SeatsSection {...{ ...fixture(value).props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(language === 'en'
      ? 'seat-a: Seat definition is invalid [invalid-definition]; this seat failed to open. Other seats and the engine continue. Repair the definition and reopen; this alert clears when the definition changes or this seat opens successfully.'
      : 'seat-a: 工位定义无效 [invalid-definition]，该工位开窗失败，其他工位与引擎继续运行。请修好定义后重开；定义修改或该工位成功开窗后，本告警清除。')
    expect(screen.getByRole('region', { name: t('seats') }).contains(screen.getByRole('alert'))).toBe(true)
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('names a parked definition admission without claiming an opening failed: %s', (language) => {
    const value = { ...data, diagnostics: { openings: [{ sessionId: 'parked-turn' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'invalid-definition' as const, stage: 'turn' as const }] } }
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const view = render(<SeatsSection {...{ ...fixture(value).props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(language === 'en'
      ? 'seat-a: Seat definition is invalid [invalid-definition]; turn admission is parked for this window and input remains unclaimed. Other seats and the engine continue. Repair the configuration; retained input can resume after admission confirms repair. This alert clears when admission confirms the repaired definition or this runtime is closed.'
      : 'seat-a: 工位定义无效 [invalid-definition]，此窗口回合准入已停车，输入尚未认领，其他工位与引擎继续运行。请修复配置；准入确认修复后，保留输入可继续处理。准入确认定义已修复或此运行时关闭后，本告警清除。')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('shows a missing preset refusal in the cold picker without a Session header', () => {
    const f = fixture(data, undefined, { seq: 1, message: 'Agent preset agent-a is unavailable. Restore the preset and submit again.' })
    render(<SeatPicker {...f.props as SeatPickerProps} />)
    expect(screen.getByText('Agent preset agent-a is unavailable. Restore the preset and submit again.')).toBeTruthy()
  })
  it.each(['en', 'zh'] as const)('shows the ten-minute engine alert in the existing diagnostic location and clears on recovery: %s', (language) => {
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const engine = { site: 'scheduled-drive', code: 'ETIMEDOUT', since: '2026-01-01T00:00:00Z',
      retryable: true, attempts: 1, unavailableOverTenMinutes: true as const }
    const f = fixture({ ...data, diagnostics: { engine, openings: [] } })
    const view = render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]!.parentElement).toBe(alerts[1]!.parentElement)
    expect(alerts[1]!.textContent).toBe(language === 'en'
      ? 'Seat engine has been unavailable for over ten minutes [ETIMEDOUT]. Check the host log and repair the cause; this alert clears when the engine returns to running.'
      : '工位引擎已持续不可用超过 10 分钟 [ETIMEDOUT]。请查看宿主日志并修复原因；引擎恢复 running 后，本告警清除。')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('shows an issuer-refused callback immediately in the existing alert location: %s', (language) => {
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const value = { ...data, diagnostics: { openings: [], callbacks: [{ callbackId: 'callback-a' as never,
      seat: seat.seat, code: 'unauthorized' as const }] } }
    const props = { ...fixture(value).props, t }
    const view = render(<SeatsSection {...props as SeatsSectionProps} wide={false} />)
    expect(screen.getByRole('button', { name: t('showAlerts') })).toBeTruthy()
    view.rerender(<SeatsSection {...props as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(language === 'en'
      ? 'seat-a: Callback callback-a was refused [unauthorized] and is parked for manual resolution. Other callbacks and the engine continue. Restore the original account, then resume or abandon this callback; this alert clears when it leaves the parked state.'
      : 'seat-a: 回调 callback-a 被拒绝 [unauthorized]，已停车等待人工处理，其他回调与引擎继续运行。请恢复原账号后恢复或放弃此回调；退出停车状态后，本告警清除。')
    expect(screen.getByRole('region', { name: t('seats') }).contains(screen.getByRole('alert'))).toBe(true)
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('shows a callback authentication refusal and clears after abandonment: %s', (language) => {
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const value = { ...data, diagnostics: { openings: [], callbacks: [{ callbackId: 'callback-a' as never,
      seat: seat.seat, code: 'callback-authentication-failed' as const }] } }
    const view = render(<SeatsSection {...{ ...fixture(value).props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(language === 'en'
      ? 'seat-a: Callback callback-a authentication was refused [callback-authentication-failed] before processing; it is parked for manual resolution. Other callbacks and the engine continue. Repair callback authentication, then resume or abandon this callback; this alert clears when it leaves the parked state.'
      : 'seat-a: 回调 callback-a 在处理前认证被拒绝 [callback-authentication-failed]，已停车等待人工处理，其他回调与引擎继续运行。请修复回调认证后恢复或放弃此回调；退出停车状态后，本告警清除。')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
    const stopped = { ...data, diagnostics: { openings: [], engine: { site: 'callback-delivery',
      code: 'callback-authentication-failed', since: '2026-01-01T00:00:00Z', retryable: false, attempts: 1 } } }
    view.rerender(<SeatsSection {...{ ...fixture(stopped).props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(t('engineStopped', { code: 'callback-authentication-failed' }))
  })
  it.each(['en', 'zh'] as const)('shows complete journal frame overflow immediately as a stopped engine: %s', (language) => {
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const value = { ...data, diagnostics: { engine: { site: 'callback-delivery', code: 'source-payload-too-large',
      since: '2026-01-01T00:00:00Z', retryable: false, attempts: 1 }, openings: [] } }
    render(<SeatsSection {...{ ...fixture(value).props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(t('engineStopped', { code: 'source-payload-too-large' }))
  })
  it('shows a stopped engine and its clearance condition in the seat section', () => {
    const f = fixture({ ...data, diagnostics: { engine: { site: 'scheduled-drive', code: 'unclassified-error',
      since: '2026-01-01T00:00:00Z', retryable: false, attempts: 1 }, openings: [] } })
    render(<SeatsSection {...f.props as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toContain('Seat engine stopped')
    expect(screen.getByRole('alert').textContent).toContain('restart')
    expect(screen.getByRole('alert').textContent).toContain('unclassified-error')
  })
  it.each(['en', 'zh'] as const)('keeps localized absent-opening diagnostics until a successful replacement: %s', (language) => {
    const f = fixture({ ...data, diagnostics: { openings: [{ sessionId: 'absent-a' as never,
      seat: seat.seat, agentPreset: seat.agentPreset, code: 'open-create-failed' }] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const view = render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    if (language === 'en') expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"seat-a: Agent preset "agent-a" is unavailable [open-create-failed]; no Session was created. Restore the preset and submit a new opening. This alert clears after that seat opens successfully."')
    else expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"seat-a: 代理预设“agent-a”不可用 [open-create-failed]，未创建会话。请恢复预设后重新提交开窗；该工位成功开窗后，本告警清除。"')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('reports bounded owner-release retries and exhaustion: %s', (language) => {
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const failure = { site: 'owner-release', code: 'owner-release-budget-exceeded',
      since: '2026-01-01T00:00:00Z', retryable: true, attempts: 1 }
    const f = fixture({ ...data, diagnostics: { engine: failure, openings: [] } })
    const view = render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(t('engineRetrying', { code: failure.code }))
    const stopped = fixture({ ...data, diagnostics: { engine: { ...failure, retryable: false, attempts: 3 }, openings: [] } })
    view.rerender(<SeatsSection {...{ ...stopped.props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('alert').textContent).toBe(t('engineStopped', { code: failure.code }))
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('names the unavailable model and confines its failure to the seat: %s', (language) => {
    const failed = { sessionId: 'model-failed' as never, seat: seat.seat, agentPreset: seat.agentPreset,
      model: seat.model, provider: seat.provider, code: 'open-configuration-failed' as const }
    const f = fixture({ ...data, diagnostics: { openings: [failed] } })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const view = render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    const alert = screen.getByRole('alert').textContent
    expect(alert).toContain('seat-a')
    expect(alert).toContain('model-a')
    expect(alert).toContain(language === 'en' ? 'resend' : '重发')
    expect(alert).toContain(language === 'en' ? 'Other seats continue' : '其他工位继续运行')
    expect(alert).toContain(language === 'en' ? 'clears' : '清除')
    view.rerender(<SeatsSection {...{ ...fixture(data).props, t } as SeatsSectionProps} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en', 'zh'] as const)('shows the available empty section and add entry: %s', (language) => {
    const f = fixture({ ...data, definitions: [] })
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en) => dictionary[key]
    render(<SeatsSection {...{ ...f.props, t } as SeatsSectionProps} />)
    expect(screen.getByRole('heading', { name: language === 'en' ? 'Seats' : '工位' })).toBeTruthy()
    expect(screen.getByText(language === 'en' ? 'No seats yet. Add your first seat.' : '还没有工位，添加第一个工位。')).toBeTruthy()
    expect(screen.getByRole('button', { name: language === 'en' ? 'Add seat' : '添加工位' })).toBeTruthy()
  })
  it.each(['en', 'zh'] as const)('offers exactly four fields and previews one new seat before confirmation: %s', async (language) => {
    const f = fixture()
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
    const prepareAdd = vi.fn(async () => ({ format: 'csv' as const, sourcePath: '/host/source.csv', columnMap: {}, defaults: {} }))
    const previewAdd = vi.fn(async () => ({ planId: 'plan-a' as never, baseRevision: 1,
      rows: [{ row: 2, seat: 'new-seat', action: 'create' as const, diagnostics: [] }] }))
    const commitAdd = vi.fn(async () => {})
    const loadModels = vi.fn(async () => [{ provider: 'provider-a', model: 'model-a', label: 'Model A' }])
    render(<SeatsSection {...{ ...f.props, t, prepareAdd, previewAdd, commitAdd, loadModels } as SeatsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'Add seat' : '添加工位' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(3)
    fireEvent.change(within(dialog).getByLabelText(language === 'en' ? 'Seat name' : '工位名'), { target: { value: 'new-seat' } })
    fireEvent.change(within(dialog).getByLabelText(language === 'en' ? 'Working directory' : '工作目录'), { target: { value: '/workspace' } })
    fireEvent.click(within(dialog).getByRole('button', { name: language === 'en' ? 'Select a model' : '选择模型' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Model A' }))
    fireEvent.change(within(dialog).getByLabelText(language === 'en' ? 'Opening sentence' : '开场句'), { target: { value: 'Hello.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: language === 'en' ? 'Preview' : '预览' }))
    expect(await screen.findByText(language === 'en' ? '1 seat will be added.' : '将新增 1 个工位。')).toBeTruthy()
    expect(commitAdd).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: language === 'en' ? 'Confirm add' : '确认添加' }))
    await vi.waitFor(() => { expect(commitAdd).toHaveBeenCalledOnce() })
  })
  it.each(['en', 'zh'] as const)('localizes missing model, directory, duplicate name and import refusals: %s', async (language) => {
    const f = fixture()
    const dictionary = language === 'en' ? en : zh
    const t = (key: keyof typeof en) => dictionary[key]
    const prepareAdd = vi.fn(async () => ({ format: 'csv' as const, sourcePath: '/host/source.csv', columnMap: {}, defaults: {} }))
    const previewAdd = vi.fn(async () => ({ planId: 'plan-a' as never, baseRevision: 1,
      rows: [{ row: 2, action: 'create' as const, diagnostics: [] }] }))
    const commitAdd = vi.fn(async () => {})
    const loadModels = vi.fn(async () => [{ provider: 'provider-a', model: 'model-a', label: 'Model A' }])
    render(<SeatsSection {...{ ...f.props, t, prepareAdd, previewAdd, commitAdd, loadModels } as SeatsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: t('addSeat') }))
    const dialog = await screen.findByRole('dialog')
    const form = within(dialog)
    fireEvent.click(form.getByRole('button', { name: t('preview') }))
    expect((await form.findByRole('alert')).textContent).toBe(t('modelRequired'))
    expect(prepareAdd).not.toHaveBeenCalled()
    fireEvent.change(form.getByLabelText(t('seatName')), { target: { value: 'new-seat' } })
    fireEvent.change(form.getByLabelText(t('workingDirectory')), { target: { value: '/workspace' } })
    fireEvent.change(form.getByLabelText(t('openingSentence')), { target: { value: 'Hello.' } })
    fireEvent.click(form.getByRole('button', { name: t('selectModel') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Model A' }))
    for (const [code, key] of [['seat-ui/directory-invalid', 'directoryInvalid'], ['seat-ui/name-exists', 'nameExists']] as const) {
      prepareAdd.mockRejectedValueOnce(Object.assign(new Error('Refused'), { code }))
      fireEvent.click(form.getByRole('button', { name: t('preview') }))
      await vi.waitFor(() => { expect(form.getByRole('alert').textContent).toBe(t(key)) })
    }
    previewAdd.mockRejectedValueOnce(new Error('Preview refused'))
    fireEvent.click(form.getByRole('button', { name: t('preview') }))
    await vi.waitFor(() => { expect(form.getByRole('alert').textContent).toBe(t('previewRejected')) })
    commitAdd.mockRejectedValueOnce(new Error('Commit outcome unknown'))
    fireEvent.click(form.getByRole('button', { name: t('preview') }))
    await form.findByText(t('oneCreate'))
    fireEvent.click(form.getByRole('button', { name: t('confirmAdd') }))
    await vi.waitFor(() => { expect(form.getByRole('alert').textContent).toBe(t('commitRejected')) })
    expect(form.queryByRole('button', { name: t('confirmAdd') })).toBeNull()
    expect(commitAdd).toHaveBeenCalledOnce()
  })
  it('refuses a preview that would update an existing definition', async () => {
    const f = fixture()
    const prepareAdd = vi.fn(async () => ({ format: 'csv' as const, sourcePath: '/host/source.csv', columnMap: {}, defaults: {} }))
    const previewAdd = vi.fn(async () => ({ planId: 'plan-a' as never, baseRevision: 1,
      rows: [{ row: 2, action: 'create' as const, diagnostics: [] }, { row: 3, action: 'update' as const, diagnostics: [] }] }))
    const commitAdd = vi.fn(async () => {})
    const loadModels = vi.fn(async () => [{ provider: 'provider-a', model: 'model-a', label: 'Model A' }])
    render(<SeatsSection {...{ ...f.props, prepareAdd, previewAdd, commitAdd, loadModels } as SeatsSectionProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add seat' }))
    const form = within(await screen.findByRole('dialog'))
    for (const [label, value] of [['Seat name', 'new-seat'], ['Working directory', '/workspace'], ['Opening sentence', 'Hello.']] as const) {
      fireEvent.change(form.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(form.getByRole('button', { name: 'Select a model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Model A' }))
    fireEvent.click(form.getByRole('button', { name: 'Preview' }))
    expect((await form.findByRole('alert')).textContent).toBe(en.previewRejected)
    expect(form.queryByRole('button', { name: 'Confirm add' })).toBeNull()
    expect(commitAdd).not.toHaveBeenCalled()
  })
  it('shows a cold-start picker and optional sidebar, hiding unavailable and collapsed sections', () => {
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
    for (const value of [{ ...data, available: false }]) {
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
    expect(screen.getByRole('dialog').textContent).toContain('/current')
    expect(screen.getByRole('dialog').textContent).toContain('Current directory: /current')
    expect(screen.getByRole('dialog').textContent).toContain('Profile directory: /profile')
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(f.openSeat).toHaveBeenCalledTimes(choice === 'Cancel' ? 0 : 1)
    if (choice === 'Stay in this directory') expect(f.openSeat).toHaveBeenCalledWith(registered, '/current')
    if (choice === 'Use profile directory') expect(f.openSeat).toHaveBeenCalledWith(registered)
    view.unmount()
    render(<SeatsSection {...f.props as SeatsSectionProps} useSessions={useSessions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open seat' }))
    expect(screen.getByRole('dialog', { name: 'Choose the startup directory' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('/current')
    expect(screen.getByRole('dialog').textContent).toContain('Current directory: /current')
    expect(screen.getByRole('dialog').textContent).toContain('Profile directory: /profile')
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
      expect(screen.getByRole('dialog').textContent).toContain('/current')
      expect(screen.getByRole('dialog').textContent).toContain('Current directory: /current')
      expect(screen.getByRole('dialog').textContent).toContain('Profile directory: /profile')
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
