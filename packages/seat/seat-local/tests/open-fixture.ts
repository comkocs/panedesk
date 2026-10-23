import { vi } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import type { LedgerSessionContext } from '@panedesk/dsh-session-ledger'
import type { OpenIntentId, OpenSeatResult, SeatBudgetSnapshot, SeatOperationId } from '@panedesk/dsh-seat'
import type { LocalOpenIntent, OpenRuntime } from '../src/open.ts'
import { definition, nodeId, operation, seat } from './fixtures.ts'
import { renderOpening } from '../src/template.ts'

export const sessionId = 'session-a' as SessionId
export function openingFixture() {
  const def = definition(process.cwd())
  const opening = renderOpening('Open {{seat}} {{date}} {{taskId}}', { seat, date: '2026-01-01', taskId: null }, 4096)
  const budget: SeatBudgetSnapshot = { sessionId, seat, currency: 'USD', costState: 'known', windowCost: '0' as SeatBudgetSnapshot['windowCost'],
    dailyCost: '0' as SeatBudgetSnapshot['dailyCost'], limits: {}, dayKey: '2026-01-01', budgetTimeZone: 'UTC', inFlightUnknown: 0, watermark: 0, budgetRevision: 1 }
  const intent: LocalOpenIntent = { definition: def, opening, title: 'seat-a 01-01', openingMode: 'auto', data: {
    intentId: 'intent-a' as OpenIntentId, sessionId, seatRevision: 1, phase: 'intent', completedStages: [],
    binding: { kind: 'seat', sessionId, seat, projectId: def.projectId, nodeId, bindingSource: 'seat-definition', identitySource: 'settings',
      openOperationId: operation('open-a'), seatRevision: 1, relatedTaskIds: [], directories: def.directories, memoryDirectories: [], subscriptions: [], openingDigest: opening.digest },
    openingOperationId: 'opening-a' as SeatOperationId, openingMessageId: null, openingDigest: opening.digest, budget, failure: null,
  } }
  const owners: LedgerSessionContext[] = [], runs: LedgerSessionContext[] = [], steps: string[] = []
  let endRun: () => void = () => {}
  const bindContext = (context: LedgerSessionContext) => {
    owners.push(context)
    return () => { const index = owners.indexOf(context); if (index >= 0) owners.splice(index, 1) }
  }
  const runtime = {
    controller: { create: vi.fn<OpenRuntime['controller']['create']>(async (request) => {
      steps.push('create')
      const context = structuredClone(owners.at(-1)!)
      runs.push(context)
      endRun = bindContext(context)
      request.releasePreparation?.()
      return { agent: { id: request.sessionId }, agentPreset: request.agentPreset }
    }) }, ledger: { bindContext }, now: () => new Date('2026-01-01T00:00:00.000Z'), maxOpeningBytes: 4096,
    resolve: vi.fn<OpenRuntime['resolve']>(async () => def), intent: vi.fn<OpenRuntime['intent']>(async () => intent),
    exists: vi.fn<OpenRuntime['exists']>(async () => false),
    restore: vi.fn<OpenRuntime['restore']>(async () => {
      const context = structuredClone(owners.at(-1)!); runs.push(context); endRun = bindContext(context)
    }),
    created: vi.fn<OpenRuntime['created']>(async () => { steps.push('created-callback'); intent.data.phase = 'created' }),
    configure: vi.fn<OpenRuntime['configure']>(async (stage) => { steps.push(stage) }),
    configured: vi.fn<OpenRuntime['configured']>(async (stage) => {
      intent.data.completedStages = [...intent.data.completedStages, stage]
    }),
    releaseAdmission: vi.fn<OpenRuntime['releaseAdmission']>(async () => { steps.push('release') }),
    sendOpening: vi.fn<OpenRuntime['sendOpening']>(async () => { steps.push('send') }),
    result: vi.fn(async (): Promise<OpenSeatResult> => ({ status: 'opened', sessionId, seat, nodeId, nodeName: 'node-a', title: intent.title,
      budget: {}, phase: 'active', stateVersion: 1, callbackIds: [] })),
    failed: vi.fn<OpenRuntime['failed']>(async (_intent, error) => ({ status: 'rejected', error })),
  } satisfies OpenRuntime
  return { runtime, intent, owners, runs, steps, endRun: () => { endRun() } }
}
