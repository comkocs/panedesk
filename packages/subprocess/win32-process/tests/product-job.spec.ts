import { describe, expect, it, vi } from 'vitest'
import { createProductJob, enterProductJob } from '../src/product-job.ts'
import type { NativePtr } from '../src/ffi.ts'
import { JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET } from '../src/abi.ts'

function fixture() {
  return {
    createJobObjectW: vi.fn(() => 10n as NativePtr),
    openJobObjectW: vi.fn(() => 11n as NativePtr),
    setInformationJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job: NativePtr, _cls: number, buffer: Buffer) => { buffer.writeUInt32LE(0, 40); return 1 }),
    assignProcessToJobObject: vi.fn(() => 1),
    getCurrentProcess: vi.fn(() => -1n as NativePtr),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 0),
  }
}

describe('host-owned product Job', () => {
  it('queries all active members and refuses failed accounting or closed handles', () => {
    const api = fixture()
    const owner = createProductJob(api)
    expect(owner.empty()).toBe(true)
    api.queryInformationJobObject.mockImplementation((_job, _cls, buffer) => { buffer.writeUInt32LE(1, 40); return 1 })
    expect(owner.empty()).toBe(false)
    api.queryInformationJobObject.mockReturnValue(0)
    expect(() => owner.empty()).toThrow('QueryInformationJobObject')
    owner.close()
    expect(() => owner.empty()).toThrow('closed')
  })
  it('keeps the lasting handle at the host without breakaway or UI limits', () => {
    const api = fixture()
    const owner = createProductJob(api)
    expect(api.createJobObjectW).toHaveBeenCalledWith(null, owner.name)
    const calls = vi.mocked(api.setInformationJobObject).mock.calls as readonly (readonly unknown[])[]
    const limits = calls[0]?.[2]
    expect(Buffer.isBuffer(limits)).toBe(true)
    if (!Buffer.isBuffer(limits)) throw new Error('missing limits')
    expect(limits.readUInt32LE(JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)).toBe(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    expect(api.assignProcessToJobObject).not.toHaveBeenCalled()
    owner.close()
    owner.close()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(10n)
  })
  it('enters before untrusted spawn and closes the temporary non-inheritable handle', () => {
    const api = fixture()
    enterProductJob('host-job', api)
    expect(api.openJobObjectW).toHaveBeenCalledWith(1, 0, 'host-job')
    expect(api.assignProcessToJobObject).toHaveBeenCalledWith(11n, -1n)
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(11n)
  })
  it('does not join ordinary standalone processes', () => {
    const api = fixture()
    enterProductJob(undefined, api)
    expect(api.openJobObjectW).not.toHaveBeenCalled()
    expect(api.assignProcessToJobObject).not.toHaveBeenCalled()
  })
  it('fails closed and releases the temporary handle after assignment failure', () => {
    const api = fixture()
    api.assignProcessToJobObject.mockReturnValue(0)
    expect(() => { enterProductJob('host-job', api) }).toThrow('AssignProcessToJobObject')
    expect(api.closeHandle).toHaveBeenCalledWith(11n)
  })
  it('rejects preexisting names and cleans failed limit setup', () => {
    const api = fixture()
    api.getLastError.mockReturnValue(183)
    expect(() => createProductJob(api)).toThrow('already exists')
    expect(api.closeHandle).toHaveBeenCalledWith(10n)
    api.getLastError.mockReturnValue(0)
    api.setInformationJobObject.mockReturnValue(0)
    expect(() => createProductJob(api)).toThrow('SetInformationJobObject')
  })
})
