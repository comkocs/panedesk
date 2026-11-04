/** Owner admission checks the physical connection before publishing authority. */
import { EventEmitter } from 'node:events'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import { OwnerConnectionSource, type ConnectionSource } from '../src/connection-source.ts'
import type { ConnectionIndexResponse } from '../src/rpc.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const sandboxReason = 'This request comes from a sandbox process and cannot act as owner. / 本请求来自沙箱进程，不能以 owner 身份执行。'
const unknownReason = 'The connection source could not be verified and cannot act as owner. / 本请求的连接来源查不出，不能以 owner 身份执行。'

function response() {
  const state: { status?: number; headers?: Readonly<Record<string, string>>; body?: string } = {}
  const value: ConnectionIndexResponse = {
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(body) { state.body = body },
  }
  return { state, value }
}

async function fixture(source: ConnectionSource) {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const query = vi.fn(() => source)
  const guard = new OwnerConnectionSource(query)
  const auth = await BrowserAuth.create(ctx, ctx.credentials, 30, () => true, guard)
  const connection = new HostConnectionService(ctx, [], auth)
  const cookie = auth.desktopCookie('http://localhost')
  const socket = new EventEmitter()
  return { ctx, query, guard, auth, connection, cookie, socket,
    request: { headers: { host: 'localhost', cookie }, socket, method: 'GET', url: '/' } }
}

describe('owner connection source', () => {
  it.each([
    ['product-sandbox', sandboxReason], ['unknown', unknownReason],
  ] as const)('refuses %s before all owner entry points', async (source, reason) => {
    const f = await fixture(source)
    try {
      for (const endpoint of ['$events/result', 'permissionPresets/authorizeWorkspaceWrite', 'pluginManager/installBundle']) {
        expect(f.connection.admit({ ...f.request, url: `/api/${endpoint}` })).toEqual({ rejection: 403, reason })
      }
      const connect = response()
      f.connection.authorizeConnect({ ...f.request, url: '/connect' }, connect.value)
      expect(connect.state).toEqual({ status: 403, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }, body: `${reason}\n` })
      const target = new URL(f.auth.authenticatedUrl('http://localhost'))
      const launch = response()
      f.connection.authorizeIndex({ ...f.request, headers: { host: 'localhost' }, url: target.pathname + target.search }, launch.value)
      expect(launch.state).toEqual({ status: 403, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }, body: `${reason}\n` })
      expect(f.query).toHaveBeenCalledTimes(1)
      f.query.mockReturnValue('non-product')
      const retry = response()
      f.connection.authorizeIndex({ ...f.request, socket: new EventEmitter(), headers: { host: 'localhost' }, url: target.pathname + target.search }, retry.value)
      expect(retry.state.status).toBe(303)
    } finally { await f.connection.browserPeer.dispose() }
  })

  it('keeps host requests and upgrades on one cached connection decision', async () => {
    const f = await fixture('non-product')
    try {
      expect(f.connection.admit(f.request)).toEqual({ peer: f.connection.browserPeer })
      expect(f.connection.admit({ ...f.request })).toEqual({ peer: f.connection.browserPeer })
      const upgraded = f.connection.admitConnection(f.request)
      if ('rejection' in upgraded) throw new Error('host upgrade rejected')
      expect(upgraded.peer).toBe(f.connection.browserPeer)
      await upgraded.release()
      expect(f.query).toHaveBeenCalledTimes(1)
      f.socket.emit('close')
      expect(f.connection.admit({ ...f.request, socket: new EventEmitter() })).toEqual({ peer: f.connection.browserPeer })
      expect(f.query).toHaveBeenCalledTimes(2)
    } finally { await f.connection.browserPeer.dispose() }
  })

  it('refuses replay of a live API cookie without claiming its socket', async () => {
    const f = await fixture('non-product')
    try {
      const connect = response()
      f.connection.authorizeConnect({ ...f.request, url: '/connect' }, connect.value)
      expect(connect.state.status).toBe(302)
      const cookie = connect.state.headers?.['set-cookie']?.split(';')[0]
      if (cookie === undefined) throw new Error('missing API cookie')
      const request = { headers: { host: 'localhost', cookie }, socket: new EventEmitter() }
      f.query.mockReturnValue('product-sandbox')
      expect(f.connection.admit(request)).toEqual({ rejection: 403, reason: sandboxReason })
      expect(f.connection.admitConnection(request)).toEqual({ rejection: 403, reason: sandboxReason })
      f.query.mockReturnValue('non-product')
      const allowed = f.connection.admitConnection({ ...request, socket: new EventEmitter() })
      if ('rejection' in allowed) throw new Error('host API upgrade rejected')
      await allowed.release()
      expect(f.connection.admit({ ...request, socket: new EventEmitter() })).toEqual({ rejection: 401 })
    } finally { await f.connection.browserPeer.dispose() }
  })

  it('refuses connect before invoking the Peer publisher', async () => {
    const f = await fixture('product-sandbox')
    try {
      const publish = vi.fn((): never => { throw new Error('unexpected Peer publication') })
      const connect = response()
      f.auth.authorizeConnect({ ...f.request, url: '/connect' }, connect.value, false, publish)
      expect(connect.state.status).toBe(403)
      expect(publish).not.toHaveBeenCalled()
    } finally { await f.connection.browserPeer.dispose() }
  })

  it('does not query unauthenticated requests and contains lookup failures', async () => {
    const f = await fixture('non-product')
    try {
      expect(f.connection.admit({ headers: { host: 'localhost' }, socket: f.socket })).toEqual({ rejection: 401 })
      expect(f.query).not.toHaveBeenCalled()
      f.query.mockImplementation(() => { throw new Error('lookup failed') })
      expect(f.connection.admit(f.request)).toEqual({ rejection: 403, reason: unknownReason })
      expect(f.connection.admit(f.request)).toEqual({ rejection: 403, reason: unknownReason })
      expect(f.query).toHaveBeenCalledTimes(1)
    } finally { await f.connection.browserPeer.dispose() }
  })
})
