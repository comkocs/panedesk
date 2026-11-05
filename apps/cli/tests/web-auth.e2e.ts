/** Real `panedesk web` authentication against a temporary Harness home. */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { authAdmissionBody } from '@panedesk/dsh-client-connection'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href

/**
 * Relay one real controlling terminal for the CLI. A new browser is admitted
 * only by an owner answer read from `/dev/tty`, never from redirected input.
 */
const OWNER_TERMINAL = `import os, pty, select, signal, sys

def terminate(_signum, _frame):
    raise SystemExit(0)

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], '--import', sys.argv[2], sys.argv[3], 'web', '--no-open', '--port', sys.argv[4]])
signal.signal(signal.SIGTERM, terminate)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 1024)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(master)
`

interface RunningWeb {
  readonly child: ChildProcess
  readonly launchUrl: string
  readonly output: () => string
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

function redact(output: string): string {
  return output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

/** Reserve one concrete loopback port, then release it for the CLI process. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

function cleanEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    PANEDESK_AGENTS_HOME: join(root, '.agents'),
    PANEDESK_HOME: dshHome,
    PANEDESK_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
  }
}

/** Start the public source CLI behind a real controlling terminal and wait for its readiness URL. */
async function startWeb(root: string, dshHome: string, port: number): Promise<RunningWeb> {
  const child = spawn('python3', [
    '-I', '-c', OWNER_TERMINAL,
    process.execPath,
    TSX_LOADER,
    DSH_SOURCE_BIN,
    String(port),
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`panedesk web did not become ready:\n${redact(output)}`))
    }, 90_000)
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /panedesk web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      fail(error)
    })
    child.once('exit', (code) => {
      fail(new Error(`panedesk web exited before readiness (${String(code)}):\n${redact(output)}`))
    })
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { running.child.once('exit', () => { resolve() }) })
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await exited
  clearTimeout(forced)
}

/** POST one real Remote envelope while controlling the wire Host header. */
function describeSettings(port: number, host: string, cookie?: string): Promise<HttpResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'web-auth-real-cli',
    method: 'settings/describe',
    payload: { args: {} },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/settings/describe',
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...cookie === undefined ? {} : { cookie },
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

describe('panedesk web authentication through the real CLI', () => {
  it('rejects a forged loopback Host and requires fresh owner confirmation after restart', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-real-cli-'))
    const dshHome = join(root, '.panedesk')
    const port = await freePort()
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    try {
      first = await startWeb(root, dshHome, port)
      const firstUrl = new URL(first.launchUrl)
      expect(firstUrl.origin).toBe(`http://127.0.0.1:${String(port)}`)
      expect(firstUrl.pathname).toBe('/')
      expect(firstUrl.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)

      expect(await describeSettings(port, `localhost:${String(port)}`)).toEqual({
        status: 401,
        body: authAdmissionBody(401),
      })

      const exchange = await fetch(first.launchUrl, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      expect(exchange.headers.get('location')).toBe('./')
      const setCookie = exchange.headers.get('set-cookie')
      if (setCookie === null) throw new Error('real CLI token exchange omitted Set-Cookie')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).not.toContain('Secure')
      const cookie = setCookie.split(';', 1)[0]!

      // The launch exchange admits the browser only once the host terminal answers.
      await expect.poll(() => first?.output().includes('[y/N]') ?? false, { timeout: 30_000 }).toBe(true)
      const ownerInput = first?.child.stdin
      if (ownerInput === undefined || ownerInput === null) throw new Error('owner terminal input closed before confirmation')
      ownerInput.write('y\n')
      await expect.poll(async () => (await describeSettings(port, firstUrl.host, cookie)).status, { timeout: 30_000 }).toBe(200)
      const authenticated = await describeSettings(port, firstUrl.host, cookie)
      expect(authenticated.status).toBe(200)
      const authenticatedBody: unknown = JSON.parse(authenticated.body)
      expect(authenticatedBody).toMatchObject({
        type: 'server-response',
        rpcId: 'web-auth-real-cli',
        result: { ok: true, value: { namespaces: expect.any(Array) as unknown } },
      })

      await stopWeb(first)
      first = undefined
      second = await startWeb(root, dshHome, port)
      const secondUrl = new URL(second.launchUrl)
      expect(secondUrl.searchParams.get('token')).not.toBe(firstUrl.searchParams.get('token'))
      expect((await describeSettings(port, secondUrl.host, cookie)).status).toBe(401)

      const secondExchange = await fetch(second.launchUrl, { redirect: 'manual' })
      expect(secondExchange.status).toBe(303)
      expect(secondExchange.headers.get('location')).toBe('./')
      const secondSetCookie = secondExchange.headers.get('set-cookie')
      if (secondSetCookie === null) throw new Error('restarted CLI token exchange omitted Set-Cookie')
      expect(secondSetCookie).toContain('HttpOnly')
      expect(secondSetCookie).toContain('SameSite=Strict')
      expect(secondSetCookie).not.toContain('Secure')
      const secondCookie = secondSetCookie.split(';', 1)[0]!
      expect(secondCookie).not.toBe(cookie)
      expect((await describeSettings(port, secondUrl.host, secondCookie)).status).toBe(401)
      await expect.poll(() => second?.output().includes('[y/N]') ?? false).toBe(true)
      const secondOwnerInput = second.child.stdin
      if (secondOwnerInput === undefined || secondOwnerInput === null) throw new Error('owner terminal input closed before reconfirmation')
      secondOwnerInput.write('y\n')
      await expect.poll(async () => (await describeSettings(port, secondUrl.host, secondCookie)).status).toBe(200)
      expect((await describeSettings(port, secondUrl.host, secondCookie)).status).toBe(200)
      expect((await describeSettings(port, secondUrl.host, cookie)).status).toBe(401)

      const credentialMode = (await stat(join(dshHome, '.credentials.yaml'))).mode & 0o777
      expect(credentialMode).toBe(0o600)
    } catch (error) {
      const evidence = [first?.output(), second?.output()].filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(evidence)}`, { cause: error })
    } finally {
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the browser cookie across restart when protected host configuration disables owner confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-unconfirmed-'))
    const dshHome = join(root, '.panedesk')
    const port = await freePort()
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    try {
      await mkdir(dshHome)
      await writeFile(join(dshHome, 'cordis.patch.yml'),
        '- id: connection\n  config:\n    requireOwnerConfirmation: false\n')
      first = await startWeb(root, dshHome, port)
      const firstUrl = new URL(first.launchUrl)
      const exchange = await fetch(first.launchUrl, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      expect(exchange.headers.get('location')).toBe('./')
      const setCookie = exchange.headers.get('set-cookie')
      if (setCookie === null) throw new Error('unconfirmed CLI token exchange omitted Set-Cookie')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).not.toContain('Secure')
      const cookie = setCookie.split(';', 1)[0]!
      expect((await describeSettings(port, firstUrl.host, cookie)).status).toBe(200)
      expect(first.output()).not.toContain('[y/N]')

      await stopWeb(first)
      expect(first.output()).not.toContain('[y/N]')
      first = undefined
      second = await startWeb(root, dshHome, port)
      const secondUrl = new URL(second.launchUrl)
      expect(secondUrl.searchParams.get('token')).not.toBe(firstUrl.searchParams.get('token'))
      expect((await describeSettings(port, secondUrl.host, cookie)).status).toBe(200)
      expect(second.output()).not.toContain('[y/N]')
    } catch (error) {
      const evidence = [first?.output(), second?.output()].filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(evidence)}`, { cause: error })
    } finally {
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })
})
