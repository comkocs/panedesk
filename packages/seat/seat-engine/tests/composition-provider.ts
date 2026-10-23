/** Only the absent seat provider and external model transport are substituted. */
import { SeatService, type SeatName, type ListSeatWindowsResult } from '@panedesk/dsh-seat'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import { definition } from './fixtures.ts'

export class CompositionSeats extends SeatService {
  resolve(_seat: SeatName) { return Promise.resolve(definition()) }
  list(): Promise<ListSeatWindowsResult> {
    return Promise.resolve({ status: 'listed', sessions: [], unopenedSeats: [], complete: true, snapshotAt: new Date().toISOString() })
  }
  withAuthority(): never { throw new Error('Unused seat operation') }
  definitions(): never { throw new Error('Unused seat operation') }
  save(): never { throw new Error('Unused seat operation') }
  previewImport(): never { throw new Error('Unused seat operation') }
  commitImport(): never { throw new Error('Unused seat operation') }
  setAuthority(): never { throw new Error('Unused seat operation') }
  open(): never { throw new Error('Unused seat operation') }
  openBatch(): never { throw new Error('Unused seat operation') }
  renew(): never { throw new Error('Unused seat operation') }
  close(): never { throw new Error('Unused seat operation') }
  replace(): never { throw new Error('Unused seat operation') }
  rename(): never { throw new Error('Unused seat operation') }
  wake(): never { throw new Error('Unused seat operation') }
  binding(): never { throw new Error('Unused seat operation') }
  resolveDirectoryChoice(): never { throw new Error('Unused seat operation') }
  submitReport(): never { throw new Error('Unused seat operation') }
  revokeReport(): never { throw new Error('Unused seat operation') }
  registerWait(): never { throw new Error('Unused seat operation') }
  cancelWait(): never { throw new Error('Unused seat operation') }
  wait(): never { throw new Error('Unused seat operation') }
  operation(): never { throw new Error('Unused seat operation') }
  contextUsage(): never { throw new Error('Unused seat operation') }
}

/** A model stream barrier lets the test exhaust budget during an admitted turn. */
export class BarrierAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private release!: () => void
  private entered!: () => void
  readonly started = new Promise<void>((resolve) => { this.entered = resolve })
  private readonly barrier = new Promise<void>((resolve) => { this.release = resolve })
  private released = false
  finish(): void { this.released = true; this.release() }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 2 && !this.released) { this.entered(); await this.barrier }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Budget warning acknowledged.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Budget warning acknowledged.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' }, responseModel: 'model-a', responseModelReported: 'same',
      cacheRetention: '1h', cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, accountLabel: 'route-a' }
  }
}
