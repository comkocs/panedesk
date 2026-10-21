import { describe, expect, it } from 'vitest'
import { parseLedgerArgs } from '../src/cli.ts'

describe('strict ledger command arguments', () => {
  it('parses all seven commands and the documented group aliases', () => {
    expect(parseLedgerArgs([]).command).toBe('today')
    expect(parseLedgerArgs(['today', '--timezone', 'Asia/Shanghai']).command).toBe('today')
    expect(parseLedgerArgs(['query', '--from', '2026-10-22T00:00:00+08:00', '--to', '2026-10-23T00:00:00+08:00',
      '--seat', 'seat-a', '--window', 'window-a', '--model', 'model-a', '--task', 'task-a', '--group-by', 'seat,model,task', '--node', 'node-a', '--purpose', 'keepalive']).query)
      .toMatchObject({ seat: 'seat-a', window: 'window-a', model: 'model-a', taskId: 'task-a', groupBy: ['seat', 'model', 'taskId'], nodeId: 'node-a', purpose: 'keepalive' })
    expect(parseLedgerArgs(['export', '--format', 'csv', '--output', 'rows.csv']).format).toBe('csv')
    expect(parseLedgerArgs(['merge', '--input', 'a.jsonl', '--input', 'b.jsonl', '--output', 'merged.jsonl']).inputs).toEqual(['a.jsonl', 'b.jsonl'])
    expect(parseLedgerArgs(['live', '--include-children']).query.includeChildren).toBe(true)
    expect(parseLedgerArgs(['cache', '--session', 'session-a', '--include-children']).command).toBe('cache')
    expect(parseLedgerArgs(['verify', '--input', 'merged.jsonl']).command).toBe('verify')
  })
  it.each([
    ['unknown'], ['today', '--unknown'], ['today', '--timezone', 'UTC'], ['query', '--seat'], ['query', '--seat', 'a', '--seat', 'b'],
    ['query', '--from', '2026-10-22'], ['query', '--group-by', 'guess'], ['query', '--purpose', 'guess'],
    ['export', '--format', 'xml', '--output', 'x'], ['export', '--format', 'csv'], ['merge', '--output', 'x'], ['verify'],
    ['verify', '--input', 'a', '--input', 'b'], ['cache'], ['live', '--format', 'csv'],
  ])('rejects malformed or inapplicable arguments %j', (...args) => { expect(() => parseLedgerArgs(args)).toThrow() })
})
