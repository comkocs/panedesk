/** Real title events and local receipts remain stable across retries and provider recovery. */
import { expect, it, vi } from 'vitest'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { LocalRenamer } from '../src/rename.ts'

it('replays the original pinned title after later changes and reads it without a live Agent', async () => {
  const f = await engineFixture(true)
  const first = new LocalRenamer(f.ctx)
  let restored: LocalRenamer | undefined
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Window did not open')
    const request = { sessionId: opened.sessionId, title: 'Pinned first', operationId: operation('rename-first') }
    expect(await first.rename({ ...request, title: String.fromCodePoint(0x200b) + '  ', operationId: operation('rename-empty') }))
      .toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
    const result = await first.rename(request)
    expect(result).toMatchObject({ status: 'renamed', title: { title: 'Pinned first', source: { kind: 'user' } } })
    expect(await first.rename({ ...request, title: 'Changed request' })).toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    expect(await first.rename({ ...request, title: 'Pinned second', operationId: operation('rename-second') })).toMatchObject({ status: 'renamed' })
    await first.close()
    restored = new LocalRenamer(f.ctx)
    expect(await restored.rename(request)).toEqual(result)
    expect(f.ctx.agents.get(opened.sessionId)).toBeUndefined()
    expect(await f.runtime.title(opened.sessionId)).toBe('Pinned second')
    const events = (await f.ctx.sessionQuery.readSession(opened.sessionId))?.events ?? []
    expect(events.filter(event => event.type === 'session/title' && event.data.title === 'Pinned first')).toHaveLength(1)
  } finally { await first.close(); await restored?.close(); await f.close() }
})

it('retains the staged title after a flush failure and settles the original operation without another title event', async () => {
  const f = await engineFixture(true)
  const renamer = new LocalRenamer(f.ctx)
  try {
    const opened = await f.open()
    if (opened.status !== 'opened') throw new Error('Window did not open')
    const request = { sessionId: opened.sessionId, title: 'Recover title', operationId: operation('rename-recover') }
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Title flush interrupted'))
    await expect(renamer.rename(request)).rejects.toThrow('Title flush interrupted')
    expect(await renamer.rename({ ...request, operationId: operation('rename-other') })).toMatchObject({ status: 'rejected', error: { code: 'state-conflict' } })
    expect(await renamer.rename(request)).toMatchObject({ status: 'renamed', title: { title: 'Recover title' } })
    expect(flush).toHaveBeenCalledTimes(2)
    const events = (await f.ctx.sessionQuery.readSession(opened.sessionId))?.events ?? []
    expect(events.filter(event => event.type === 'session/title' && event.data.title === request.title)).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await renamer.close(); await f.close() }
})
