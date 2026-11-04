/** Host-owned named product Job and trusted runner membership handoff. */
import { randomUUID } from 'node:crypto'
import * as abi from './abi.ts'
import { isNullPtr } from './ffi.ts'
import type { NativePtr } from './ffi.ts'
import { requireKoffi } from './koffi.ts'

/** Private host-to-runner locator; never an authentication credential. */
export const PRODUCT_JOB_ENV = 'DSH_WINDOWS_PRODUCT_JOB'

interface ProductJobBindings {
  createJobObjectW(attributes: null, name: string): NativePtr | null
  openJobObjectW(access: number, inherit: number, name: string): NativePtr | null
  setInformationJobObject(job: NativePtr, cls: number, buffer: Buffer, length: number): number
  queryInformationJobObject(job: NativePtr, cls: number, buffer: Buffer, length: number, returned: null): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  getCurrentProcess(): NativePtr
  closeHandle(handle: NativePtr): number
  getLastError(): number
}

function bindings(): ProductJobBindings {
  const koffi = requireKoffi()
  const kernel = koffi.load('kernel32.dll')
  const pointer = koffi.pointer('void')
  return {
    createJobObjectW: kernel.func('__stdcall', 'CreateJobObjectW', pointer, [pointer, 'str16']),
    openJobObjectW: kernel.func('__stdcall', 'OpenJobObjectW', pointer, ['uint32', 'int', 'str16']),
    setInformationJobObject: kernel.func('__stdcall', 'SetInformationJobObject', 'int', [pointer, 'int', pointer, 'uint32']),
    queryInformationJobObject: kernel.func('__stdcall', 'QueryInformationJobObject', 'int', [pointer, 'int', pointer, 'uint32', pointer]),
    assignProcessToJobObject: kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', [pointer, pointer]),
    getCurrentProcess: kernel.func('__stdcall', 'GetCurrentProcess', pointer, []),
    closeHandle: kernel.func('__stdcall', 'CloseHandle', 'int', [pointer]),
    getLastError: kernel.func('__stdcall', 'GetLastError', 'uint32', []),
  }
}

/**
 * Create a fresh non-inheritable parent Job with the host token's default security.
 * @param api - Native operations; omitted for production bindings.
 * @returns Identity and idempotent closure; the last handle closure terminates remaining members.
 */
export function createProductJob(api: ProductJobBindings = bindings()): {
  name: string
  handle: NativePtr
  empty(): boolean
  close(): void
} {
  const name = `Local\\Panedesk-product-${randomUUID()}`
  const handle = api.createJobObjectW(null, name)
  if (isNullPtr(handle)) throw new Error('CreateJobObjectW failed for product identity')
  try {
    if (api.getLastError() === 183) throw new Error('Product Job name already exists')
    const limits = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE)
    limits.writeUInt32LE(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
    if (api.setInformationJobObject(handle, abi.JobObjectExtendedLimitInformation, limits, limits.length) === 0) {
      throw new Error('SetInformationJobObject failed for product identity')
    }
  } catch (error) {
    api.closeHandle(handle)
    throw error
  }
  let closed = false
  return {
    name, handle,
    empty() {
      if (closed) throw new Error('Product Job identity is closed')
      const information = Buffer.alloc(abi.JOBOBJECT_BASIC_ACCOUNTING_SIZE)
      if (api.queryInformationJobObject(handle, abi.JobObjectBasicAccountingInformation,
        information, information.length, null) === 0) {
        throw new Error('QueryInformationJobObject failed for product identity')
      }
      return information.readUInt32LE(abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET) === 0
    },
    close() {
      if (closed) return
      if (api.closeHandle(handle) === 0) throw new Error('CloseHandle failed for product identity')
      closed = true
    },
  }
}

/**
 * Enter the host's product Job before the trusted ACL runner creates untrusted children.
 * @param name - Host-supplied Job locator; absent for standalone library use.
 * @param api - Native operations; omitted for production bindings.
 */
export function enterProductJob(name: string | undefined, api?: ProductJobBindings): void {
  if (name === undefined) return
  const native = api ?? bindings()
  const job = native.openJobObjectW(1, 0, name)
  if (isNullPtr(job)) throw new Error('OpenJobObjectW failed for product identity')
  try {
    if (native.assignProcessToJobObject(job, native.getCurrentProcess()) === 0) {
      throw new Error('AssignProcessToJobObject failed for product identity')
    }
  } finally {
    if (native.closeHandle(job) === 0) throw new Error('CloseHandle failed for product identity handoff')
  }
}
