import { describe, expect, it } from 'vitest'
import type { GateContext } from '@panedesk/dsh-seat'
import { checkPolling, recognizeSleeps } from '../src/polling.ts'

const context = (callId: string, command = 'sleep 1'): Extract<GateContext, { hook: 'before-tool-call' }> => ({
  hook: 'before-tool-call', callId: callId as GateContext['callId'], operationId: 'operation-a' as GateContext['operationId'],
  nodeId: 'node-a' as GateContext['nodeId'], seat: null, sessionId: null, observedAt: '2026-01-01T00:00:00Z',
  toolName: 'bash', arguments: { command }, hasPendingWork: true, cwd: '/workspace',
})

describe('literal sleep recognition', () => {
  it.each([
    ['sleep 900', 900], ['timeout 1000 sleep 900', 900], ['printf ready && sleep 900; true', 900],
    ['Start-Sleep -Seconds 900', 900], ['Start-Sleep -Milliseconds 900000', 900],
    ['python3 -c "import time; time.sleep(900)"', 900], ["ruby -e 'sleep 900'", 900],
    ['sleep 15m', 900], ['sleep 600', 600],
  ])('classifies %s without executing source', (source, seconds) => {
    expect(recognizeSleeps(source)).toEqual([{ seconds }])
    const result = checkPolling(context('call-a', source), undefined, 3, 600)
    expect(result.failure?.code ?? null).toBe(seconds > 600 ? 'sleep-limit-exceeded' : null)
    if (result.failure) expect(result.failure.alternative).toBe('Use seat_wait with the pending object IDs, then end the turn.')
  })
  it.each(['sleep "$N"', 'custom_sleep 900', 'python -c "import time; time.sleep(duration)"', 'echo "sleep 900"', 'sleep $(duration)', "sleep '900", 'timeout "$N" sleep 900'])('does not block uncertain syntax: %s', (source) => {
    expect(recognizeSleeps(source)).toEqual([])
    expect(checkPolling(context('call-a', source), undefined, 3, 600).failure).toBeNull()
  })
})

describe('consecutive waiting calls', () => {
  it('denies the third sleep with an actionable alternative and preserves stable-call counts', () => {
    const first = checkPolling(context('call-a'), undefined, 3, 600)
    const second = checkPolling(context('call-b'), first.state, 3, 600)
    const third = checkPolling(context('call-c'), second.state, 3, 600)
    expect(first.failure).toBeNull()
    expect(second.failure).toBeNull()
    expect(third.failure).toMatchObject({ code: 'polling', alternative: 'Use seat_wait with the pending object IDs, then end the turn.' })
    expect(checkPolling(context('call-c'), third.state, 3, 600).state.count).toBe(3)
  })
  it('normalizes read paths and resets on meaningful work or no pending work', () => {
    const read = { ...context('call-a'), toolName: 'read', arguments: { file_path: './a/../report.md' } }
    const first = checkPolling(read, undefined, 3, 600)
    const second = checkPolling({ ...read, callId: 'call-b' as GateContext['callId'], arguments: { file_path: '/workspace/report.md' } }, first.state, 3, 600)
    expect(second.state.count).toBe(2)
    expect(checkPolling({ ...read, callId: 'call-c' as GateContext['callId'] }, second.state, 3, 600).failure?.code).toBe('polling')
    expect(checkPolling(context('call-d', 'git status'), second.state, 3, 600).state.count).toBe(0)
    expect(checkPolling({ ...read, hasPendingWork: false }, second.state, 3, 600).state.count).toBe(0)
  })
})
