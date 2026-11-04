/** Bounded client-side TCP ownership lookup against a host-owned product Job. */
import { isIP } from 'node:net'
import { isNullPtr } from './ffi.ts'
import type { NativePtr } from './ffi.ts'
import { requireKoffi } from './koffi.ts'

/** Native operations needed to classify a physical TCP connection. */
export interface TcpOwnerBindings {
  getExtendedTcpTable(table: Buffer | null, size: Buffer, order: number, family: number, tableClass: number, reserved: number): number
  openProcess(this: void, access: number, inherit: number, pid: number): NativePtr | null
  isProcessInJob(this: void, process: NativePtr, job: NativePtr, result: Buffer): number
  closeHandle(this: void, handle: NativePtr): number
}

/** Server-observed endpoints; the remote endpoint owns the client process. */
export interface TcpConnectionEndpoints {
  readonly remoteAddress?: string | undefined
  readonly remotePort?: number | undefined
  readonly localAddress?: string | undefined
  readonly localPort?: number | undefined
}

function addressBytes(address: string): Buffer | undefined {
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isIP(normalized) === 4) return Buffer.from(normalized.split('.').map(Number))
  if (isIP(normalized) !== 6 || normalized.includes('%')) return undefined
  const [left = '', right] = normalized.split('::')
  const prefix = left === '' ? [] : left.split(':')
  const suffix = right === undefined || right === '' ? [] : right.split(':')
  const groups = right === undefined ? prefix : [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix]
  if (groups.length !== 8) return undefined
  const bytes = Buffer.alloc(16)
  for (const [index, group] of groups.entries()) bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2)
  return bytes
}

function readTable(api: TcpOwnerBindings, family: number): Buffer | undefined {
  const size = Buffer.alloc(4)
  const first = api.getExtendedTcpTable(null, size, 0, family, 5, 0)
  if (first !== 122) return undefined
  const length = size.readUInt32LE()
  // A fixed ceiling bounds synchronous work and allocation on an authentication path.
  if (length < 4 || length > 16 * 1024 * 1024) return undefined
  const table = Buffer.alloc(length)
  if (api.getExtendedTcpTable(table, size, 0, family, 5, 0) !== 0) return undefined
  if (size.readUInt32LE() > length) return undefined
  return table
}

function ownerPid(api: TcpOwnerBindings, socket: TcpConnectionEndpoints): number | undefined {
  if (socket.remoteAddress === undefined || socket.localAddress === undefined
    || socket.remotePort === undefined || socket.localPort === undefined) return undefined
  const client = addressBytes(socket.remoteAddress)
  const server = addressBytes(socket.localAddress)
  if (client === undefined || server === undefined || client.length !== server.length) return undefined
  let matched: number | undefined
  for (const family of [2, 23]) {
    const table = readTable(api, family)
    if (table === undefined) return undefined
    const rowSize = family === 2 ? 24 : 56
    const count = table.readUInt32LE()
    if (count > Math.floor((table.length - 4) / rowSize)) return undefined
    if (client.length !== (family === 2 ? 4 : 16)) continue
    for (let index = 0; index < count; index++) {
      const offset = 4 + index * rowSize
      const local = family === 2 ? 4 : 0
      const remote = family === 2 ? 12 : 24
      const localPort = family === 2 ? 8 : 20
      const remotePort = family === 2 ? 16 : 44
      const state = family === 2 ? 0 : 48
      if (table.readUInt32LE(offset + state) !== 5
        || !table.subarray(offset + local, offset + local + client.length).equals(client)
        || !table.subarray(offset + remote, offset + remote + server.length).equals(server)
        || table.readUInt16BE(offset + localPort) !== socket.remotePort
        || table.readUInt16BE(offset + remotePort) !== socket.localPort) continue
      if (matched !== undefined) return undefined
      matched = table.readUInt32LE(offset + rowSize - 4)
    }
  }
  return matched === 0 ? undefined : matched
}

/**
 * Classify the client process without inspecting integrity or token restrictions.
 * @param api - Native bindings, replaceable by deterministic platform fixtures.
 * @param job - Host-owned product identity; never a foreign process's handle value.
 * @param socket - Physical server endpoints; missing facts refuse owner admission.
 * @returns Product membership, explicit nonmembership, or unknown on any missing fact or failure.
 */
export function lookupTcpOwner(api: TcpOwnerBindings, job: NativePtr | readonly NativePtr[], socket: TcpConnectionEndpoints | undefined): 'product-sandbox' | 'non-product' | 'unknown' {
  try {
    if (socket === undefined) return 'unknown'
    const pid = ownerPid(api, socket)
    if (pid === undefined) return 'unknown'
    const process = api.openProcess(0x1000, 0, pid)
    if (isNullPtr(process)) return 'unknown'
    try {
      const member = Buffer.alloc(4)
      const jobs = typeof job === 'bigint' ? [job] : job
      let belongs = false
      for (const identity of jobs) {
        if (api.isProcessInJob(process, identity, member) === 0) return 'unknown'
        if (member.readUInt32LE() !== 0) { belongs = true; break }
      }
      // Retain the open process object while confirming the tuple still names it.
      if (ownerPid(api, socket) !== pid) return 'unknown'
      return belongs ? 'product-sandbox' : 'non-product'
    } finally {
      if (api.closeHandle(process) === 0) throw new Error('CloseHandle failed for TCP owner')
    }
  } catch (_nativeLookupFailed) {
    return 'unknown'
  }
}

/**
 * Load Windows TCP and process-membership APIs without module-global identity state.
 * @returns A binding table owned by the caller's platform provider.
 */
export function loadTcpOwnerBindings(): TcpOwnerBindings {
  const koffi = requireKoffi()
  const kernel = koffi.load('kernel32.dll')
  const ip = koffi.load('iphlpapi.dll')
  const pointer = koffi.pointer('void')
  return {
    getExtendedTcpTable: ip.func('__stdcall', 'GetExtendedTcpTable', 'uint32', [pointer, pointer, 'int', 'uint32', 'int', 'uint32']),
    openProcess: kernel.func('__stdcall', 'OpenProcess', pointer, ['uint32', 'int', 'uint32']),
    isProcessInJob: kernel.func('__stdcall', 'IsProcessInJob', 'int', [pointer, pointer, pointer]),
    closeHandle: kernel.func('__stdcall', 'CloseHandle', 'int', [pointer]),
  }
}
