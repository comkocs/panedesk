/** A copied launch link cannot authorize a browser without a separate owner decision. */
import { Context } from '@panedesk/cordis'
import { LocalCredentialProvider } from '@panedesk/dsh-credentials-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { ConnectionIndexResponse } from '../src/rpc.ts'
import { confirmBrowserLogin, type ConfirmBrowserLogin } from '../src/owner-confirmation.ts'

async function fixture(confirm: ConfirmBrowserLogin = confirmBrowserLogin) {
  const home = await mkdtemp(join(tmpdir(), 'browser-confirm-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  onTestFinished(() => fiber.dispose())
  await fiber
  const auth = await BrowserAuth.create(ctx, ctx.credentials, 30, confirm)
  const connection = new HostConnectionService(ctx, [], auth)
  return { auth, connection }
}

function exchange(auth: BrowserAuth) {
  const target = new URL(auth.authenticatedUrl('http://localhost/'))
  const result = { status: 0, cookie: '', body: '' }
  const response: ConnectionIndexResponse = {
    writeHead(status, headers) {
      result.status = status
      result.cookie = headers?.['set-cookie']?.split(';')[0] ?? ''
    },
    end(body) { result.body = body ?? '' },
  }
  auth.authorizeIndex({ method: 'GET', url: target.pathname + target.search,
    headers: { host: 'localhost', 'user-agent': 'Synthetic Browser' } }, response)
  return result
}

it('refuses the pending cookie at owner admission and connect until the host confirms', async () => {
  let accept!: (allowed: boolean) => void
  const confirm = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve }))
  const { auth, connection } = await fixture(confirm)
  const login = exchange(auth)
  expect(login.cookie).not.toBe('')
  const request = { headers: { host: 'localhost', cookie: login.cookie } }
  expect(connection.requestRejection(request)).toBe(401)
  const publish = vi.fn()
  const status = vi.fn()
  auth.authorizeConnect({ ...request, method: 'GET', url: '/connect' },
    { writeHead: status, end() {} }, false, publish)
  expect(status).toHaveBeenCalledWith(401, expect.any(Object))
  expect(publish).not.toHaveBeenCalled()
  expect(confirm).toHaveBeenCalledOnce()
  accept(true)
  await Promise.resolve()
  expect(connection.admit(request)).toEqual({ peer: connection.browserPeer })
})

it('never admits a declined browser and contains a failed confirmation channel', async () => {
  for (const confirm of [() => Promise.resolve(false), () => Promise.reject(new Error('no terminal'))]) {
    const { auth, connection } = await fixture(confirm)
    const login = exchange(auth)
    await Promise.resolve()
    await Promise.resolve()
    expect(connection.requestRejection({ headers: { host: 'localhost', cookie: login.cookie } })).toBe(401)
  }
})

it('refuses a new browser when no controlling terminal is available', async () => {
  const terminal = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  onTestFinished(() => {
    if (terminal === undefined) Reflect.deleteProperty(process.stdin, 'isTTY')
    else Object.defineProperty(process.stdin, 'isTTY', terminal)
  })
  const { auth, connection } = await fixture()
  const login = exchange(auth)
  expect(login.status).toBe(401)
  expect(login.cookie).toBe('')
  expect(login.body).toContain('requireOwnerConfirmation')
  expect(connection.requestRejection({ headers: { host: 'localhost' } })).toBe(401)
})

it('contains synchronous confirmation failures without issuing a cookie', async () => {
  const { auth } = await fixture(() => { throw new Error('terminal unavailable') })
  expect(exchange(auth)).toMatchObject({ status: 401, cookie: '' })
})

it('allows an accepted host decision without consulting the terminal', async () => {
  const { auth, connection } = await fixture(() => Promise.resolve(true))
  const login = exchange(auth)
  await Promise.resolve()
  expect(connection.admit({ headers: { host: 'localhost', cookie: login.cookie } })).toEqual({ peer: connection.browserPeer })
})
