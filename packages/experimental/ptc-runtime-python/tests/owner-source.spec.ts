/** Real Python PTC descendants must not reuse a host's valid owner cookie. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import * as Connection from '@panedesk/dsh-client-connection'
import Sandbox from '@panedesk/dsh-sandbox-local'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import SessionProjections from '@panedesk/dsh-session-projection'
import Subprocess from '@panedesk/dsh-subprocess-local'
import { expect, it } from 'vitest'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import { PythonPtcRuntime } from '../src/index.ts'

it('denies an owner cookie replayed by a confined Python descendant but permits the host', async () => {
  const root = await mkdtemp(join(homedir(), 'python-owner-source-'))
  const ctx = new Context()
  const server = createServer((request, response) => {
    const admission = ctx.connection.admit(request)
    response.writeHead('rejection' in admission ? admission.rejection : 200)
    response.end('rejection' in admission ? 'denied' : admission.peer.principal.kind)
  })
  try {
    provideBrowserCredentials(ctx)
    Object.defineProperty(ctx.credentials, 'protectedStoragePaths', { value: [join(root, 'private')] })
    await ctx.plugin(Connection, { requireOwnerConfirmation: false }).await()
    await ctx.plugin(Subprocess).await()
    await ctx.plugin(Sandbox).await()
    ;(ctx.sandbox as Sandbox).internals = { chain: ['landlock'] }
    await ctx.plugin(SessionProjections).await()
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root }).await()
    await ctx.plugin(PythonPtcRuntime).await()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a local TCP listener')
    const endpoint = `http://127.0.0.1:${String(address.port)}`
    const cookie = ctx.connection.desktopCookie(endpoint)
    const descendant = [
      'import json, sys, urllib.request, urllib.error',
      'p = json.load(sys.stdin)',
      'try:',
      ' r = urllib.request.urlopen(urllib.request.Request(p["endpoint"], headers={"Cookie": p["cookie"]}))',
      ' print(json.dumps({"status": r.status, "principal": r.read().decode()}))',
      'except urllib.error.HTTPError as e:',
      ' print(json.dumps({"status": e.code, "principal": e.read().decode()}))',
    ].join('\n')
    const program = [
      'import json, subprocess, sys',
      'payload = await fixture.request({})',
      `child = subprocess.run([sys.executable, "-I", "-c", ${JSON.stringify(descendant)}], input=json.dumps(payload), text=True, capture_output=True, check=True)`,
      'return json.loads(child.stdout)',
    ].join('\n')
    const bindings = [{ global: 'fixture', functions: { request: async () => ({ endpoint, cookie }) } }]
    const host = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      program, bindings, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root },
    }))
    expect(host.error).toBeUndefined()
    expect(host.value).toEqual({ status: 200, principal: 'owner' })
    const product = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings }))
    expect(product.error).toBeUndefined()
    expect(product.sandbox?.enforcement).toBe('full')
    expect(product.value).toEqual({ status: 403, principal: 'denied' })
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
