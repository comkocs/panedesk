import { describe, expect, it } from 'vitest'
import { readProcessIdentity, sameProcessIdentity } from '../src/process-identity.ts'

describe('process creation identity', () => {
  it('rejects PID reuse, reboot, and missing creation evidence', () => {
    const identity = { pid: 123, processGroupId: 123, startIdentity: '100', bootIdentity: 'boot' }
    expect(sameProcessIdentity(identity, { ...identity })).toBe(true)
    expect(sameProcessIdentity(identity, { ...identity, startIdentity: '101' })).toBe(false)
    expect(sameProcessIdentity(identity, { ...identity, bootIdentity: 'next-boot' })).toBe(false)
    expect(sameProcessIdentity(identity, { pid: 123 })).toBe(false)
    expect(sameProcessIdentity({ pid: 123 }, { pid: 123 })).toBe(false)
  })

  it('compares exact Windows creation ticks and refuses missing evidence or a different PID', () => {
    const identity = { pid: 123, startIdentity: '31000000:100', startedAt: 123456 }
    expect(sameProcessIdentity(identity, { ...identity })).toBe(true)
    expect(sameProcessIdentity(identity, { ...identity, startIdentity: '31000000:101' })).toBe(false)
    expect(sameProcessIdentity(identity, { ...identity, pid: 124 })).toBe(false)
    expect(sameProcessIdentity(identity, { pid: 123, startedAt: 123456 })).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')('reads Linux start ticks and boot identity', () => {
    const identity = readProcessIdentity(process.pid)
    expect(identity.pid).toBe(process.pid)
    expect(identity.startIdentity).toMatch(/^\d+$/)
    expect(identity.bootIdentity).toBeTruthy()
    expect(identity.processGroupId).toBeGreaterThan(0)
    expect(sameProcessIdentity(identity)).toBe(true)
    expect(Object.isFrozen(identity)).toBe(true)
  })
})
