/** Inventory security operations inspect the link object with explicit handle ownership. */
import { expect, it, vi } from 'vitest'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { withSecurityHandle } from '../src/file-handle.ts'

it.each([false, true])('opens the object without following reparses, writable=%s', (writable) => {
  const handle = 42n as NativePtr
  const open = vi.fn<Win32Bindings['createFileW']>(() => handle)
  const close = vi.fn<Win32Bindings['closeHandle']>(() => 1)
  const api = { createFileW: open, closeHandle: close } as Partial<Win32Bindings> as Win32Bindings
  expect(withSecurityHandle(api, 'C:\\workspace\\link', writable, value => value)).toBe(handle)
  expect(open).toHaveBeenCalledWith('C:\\workspace\\link', writable ? 0x60000 : 0x20000, 7, null, 3, 0x02200000, null)
  expect(close).toHaveBeenCalledExactlyOnceWith(handle)
})

it('closes the object when its security operation fails', () => {
  const handle = 42n as NativePtr
  const close = vi.fn<Win32Bindings['closeHandle']>(() => 1)
  const api = { createFileW: () => handle, closeHandle: close } as Partial<Win32Bindings> as Win32Bindings
  expect(() => withSecurityHandle(api, 'C:\\workspace', true, () => { throw new Error('descriptor failed') }))
    .toThrow('descriptor failed')
  expect(close).toHaveBeenCalledExactlyOnceWith(handle)
})
