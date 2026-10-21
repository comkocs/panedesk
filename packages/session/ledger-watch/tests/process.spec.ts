import { describe, expect, it } from 'vitest'
import type { LedgerProcessIdentity } from '@panedesk/dsh-session-ledger'
import { inspectProcessIdentity } from '../src/process.ts'
import type { ProcessProbe } from '../src/process.ts'

const identity: LedgerProcessIdentity = { nodeId: 'node-a' as LedgerProcessIdentity['nodeId'], pid: 123, startIdentity: '456', bootIdentity: 'boot-a', registeredAt: 1, verification: 'verified' }
function probe(state = 'S', start = '456', boot = 'boot-a'): ProcessProbe {
  return { platform: 'linux', read: async path => path.endsWith('boot_id') ? boot : `123 (worker ) with spaces) ${[state, ...Array.from({ length: 18 }, () => '0'), start].join(' ')}` }
}
describe('registered Linux process identities', () => {
  it('compares start ticks and boot identity even when comm contains closing parentheses', async () => {
    expect(await inspectProcessIdentity(identity, 'node-a', probe())).toMatchObject({ liveness: 'confirmed', verification: 'verified' })
    expect(await inspectProcessIdentity(identity, 'node-a', probe('S', '457'))).toMatchObject({ liveness: 'dead', reason: 'reused' })
    expect(await inspectProcessIdentity(identity, 'node-a', probe('S', '456', 'boot-b'))).toMatchObject({ liveness: 'dead', reason: 'rebooted' })
  })
  it('treats zombies and missing registered processes as dead without sending signals', async () => {
    expect(await inspectProcessIdentity(identity, 'node-a', probe('Z'))).toMatchObject({ liveness: 'dead', reason: 'zombie' })
    const reader: ProcessProbe = { platform: 'linux', read: async (path) => {
      if (path.endsWith('boot_id')) return 'boot-a'
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    } }
    expect(await inspectProcessIdentity(identity, 'node-a', reader)).toMatchObject({ liveness: 'dead', reason: 'missing' })
  })
  it('keeps permissions, malformed proc data, foreign nodes and unavailable identities unknown', async () => {
    const denied: ProcessProbe = { platform: 'linux', read: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
    expect(await inspectProcessIdentity(identity, 'node-a', denied)).toMatchObject({ liveness: 'unknown', verification: 'unverified' })
    expect(await inspectProcessIdentity(identity, 'node-b', probe())).toMatchObject({ liveness: 'unknown', reason: 'foreign-node' })
    expect(await inspectProcessIdentity({ ...identity, startIdentity: undefined }, 'node-a', probe())).toMatchObject({ liveness: 'unknown' })
    expect(await inspectProcessIdentity(identity, 'node-a', { ...probe(), platform: 'darwin' })).toMatchObject({ liveness: 'unknown' })
    expect(await inspectProcessIdentity(identity, 'node-a', { platform: 'linux', read: async path => path.endsWith('boot_id') ? 'boot-a' : 'bad' })).toMatchObject({ liveness: 'unknown' })
  })
})
