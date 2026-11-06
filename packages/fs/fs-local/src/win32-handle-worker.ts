/** Dedicated synchronous native caller; last-error is captured on this thread. */
import { parentPort } from 'node:worker_threads'
import { createNativeHandleApi } from './win32-handle-abi.ts'
import { refuseWindowsWrite } from './directory-win32.ts'
import { loadWindowsWriteModule } from './win32-write-loader.ts'
import type { HandleReply, HandleRequest, WindowsWriteHandler } from './win32-handle-types.ts'

const port = parentPort
if (!port) throw new Error('Handle worker requires a private parent channel')
let dispatch: ReturnType<typeof createNativeHandleApi> | undefined
let writes: Promise<WindowsWriteHandler | null> | undefined
let tail = Promise.resolve()

async function execute(request: HandleRequest): Promise<HandleReply> {
  dispatch ??= createNativeHandleApi()
  switch (request.kind) {
    case 'root': case 'open': case 'inspect': case 'read': case 'enumerate': case 'close':
      return dispatch(request)
    case 'shutdown': {
      const errors: unknown[] = []
      try { await (await writes)?.close() } catch (error) { errors.push(error) }
      try { dispatch(request) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Handle owner shutdown failed')
      return { kind: 'closed' }
    }
    default: {
      const context = dispatch.context
      writes ??= loadWindowsWriteModule().then(module => module?.createWindowsWriteHandler(context) ?? null)
      const handler = await writes
      if (!handler) return refuseWindowsWrite()
      return handler.execute(request)
    }
  }
}

port.on('message', (message: { id: number; request: HandleRequest }) => {
  tail = tail.then(async () => {
    try {
      const reply = await execute(message.request)
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
})
