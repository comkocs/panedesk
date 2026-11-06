/** Dedicated synchronous native caller; last-error is captured on this thread. */
import { parentPort } from 'node:worker_threads'
import { createNativeHandleApi } from './win32-handle-abi.ts'
import type { HandleRequest } from './win32-handle-types.ts'

const port = parentPort
if (!port) throw new Error('Handle worker requires a private parent channel')
let dispatch: ReturnType<typeof createNativeHandleApi> | undefined
port.on('message', (message: { id: number; request: HandleRequest }) => {
  try {
    dispatch ??= createNativeHandleApi()
    const reply = dispatch(message.request)
    port.postMessage({ id: message.id, reply })
  } catch (error) {
    port.postMessage({ id: message.id, error: {
      message: error instanceof Error ? error.message : 'Native handle operation failed',
      code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'FS_IO_ERROR',
    } })
  } finally {
    if (message.request.kind === 'shutdown') port.close()
  }
})
