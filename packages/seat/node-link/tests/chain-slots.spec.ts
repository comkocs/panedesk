/** Fixed control methods retain bounded dispatch capacity during business execution. */
import { expect, test } from 'vitest'
import { ChainSlots } from '../src/chain-slots.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('reserves bounded control slots while business execution waits for independent evidence', async () => {
  const slots = new ChainSlots(1, 1), business = deferred(), control = deferred()
  expect(slots.capacity()).toBe(2)
  const executing = slots.run({ method: 'source.prepareOpening' }, () => business.promise)
  await expect(slots.run({ method: 'seat.openFrozen' }, async () => 'unexpected')).rejects.toThrow('capacity')
  await expect(slots.run({ method: 'seat.definitionRevision' }, async () => 'unexpected')).rejects.toThrow('capacity')
  const evidence = slots.run({ type: 'delegation-evidence' }, () => control.promise)
  await expect(slots.run({ method: 'chain.operation' }, async () => 'unexpected')).rejects.toThrow('capacity')
  control.resolve()
  await evidence
  for (const frame of [{ type: 'hello' }, { type: 'receipt' },
    { method: 'chain.operation' }, { method: 'source.checkAdmission' }]) {
    await expect(slots.run(frame, async () => 'control-result')).resolves.toBe('control-result')
  }
  business.resolve()
  await executing
  await slots.close()
})

test('withdraws ingress before draining accepted calls and releases rejected dispatch slots', async () => {
  const slots = new ChainSlots(1, 1), pending = deferred()
  await expect(slots.run({}, async () => { throw new Error('provider rejected') })).rejects.toThrow('provider rejected')
  const executing = slots.run({}, () => pending.promise)
  let drained = false
  const closing = slots.close().then(() => { drained = true })
  await expect(slots.run({ type: 'hello' }, async () => 'unexpected')).rejects.toThrow('capacity')
  expect(drained).toBe(false)
  pending.resolve()
  await executing
  await closing
  expect(drained).toBe(true)
  expect(() => new ChainSlots(0, 1)).toThrow('capacity')
  expect(() => new ChainSlots(1, Number.MAX_SAFE_INTEGER)).toThrow('capacity')
})
