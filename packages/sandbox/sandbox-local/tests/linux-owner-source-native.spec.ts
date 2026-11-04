/** Real Linux owner admission through product confinement and socket attribution. */
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as Connection from '@panedesk/dsh-client-connection'
import { CredentialProvider, type CredentialKey, type CredentialRecord } from '@panedesk/dsh-credentials'
import Subprocess from '@panedesk/dsh-subprocess-local'
import { launcherPath } from '@panedesk/node-addon-system/landlock-run'
import { loadSocketCgroupQuery } from '@panedesk/node-addon-system/socket-cgroup'
import Sandbox from '../src/index.ts'
import { LINUX_SOURCE_LIMITATION } from '../../../subprocess/subprocess-local/src/linux-product-groups.ts'

const replay = `import sys,json,urllib.request,urllib.error,os,time
p=json.load(sys.stdin)
if len(sys.argv)>1:
 first=os.fork()
 if first: os.waitpid(first,0); sys.exit(0)
 os.setsid()
 second=os.fork()
 if second: sys.exit(0)
 deadline=time.monotonic()+3
 while os.getppid()!=1 and time.monotonic()<deadline: time.sleep(0.01)
 print('ppid='+str(os.getppid()),flush=True)
try:
 r=urllib.request.urlopen(urllib.request.Request(p['endpoint'],headers={'Cookie':p['cookie']}),timeout=5)
 print('status='+str(r.status)+' principal='+r.read().decode(),flush=True)
except urllib.error.HTTPError as e:
 print('status='+str(e.code)+' principal=denied',flush=True)
`
const migration = `import os,sys,json
member=next(x[3:] for x in open('/proc/self/cgroup').read().splitlines() if x.startswith('0::/'))
print(member,flush=True)
p=json.load(sys.stdin)
for label,path in [('parent',os.path.dirname('/sys/fs/cgroup'+member)+'/cgroup.procs'),('self','/sys/fs/cgroup'+member+'/cgroup.procs'),('sibling',p['sibling']+'/cgroup.procs')]:
 try:
  with open(path,'w') as f: f.write(str(os.getpid()))
  print(label+': writable',flush=True)
 except OSError as e: print(label+': denied errno='+str(e.errno),flush=True)
`

// The Web workspace owns Playwright; this native test uses its installed browser.
interface BrowserDriver {
  chromium: { launch(options: { headless: boolean }): Promise<{
    newContext(): Promise<{
      addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>
      newPage(): Promise<{ goto(url: string): Promise<{ status(): number } | null>; textContent(selector: string): Promise<string | null> }>
    }>
    close(): Promise<void>
  }> }
}

const cases = ['host-control', 'landlock-product', 'landlock-double-fork', 'landlock-subgroup-migration',
  'nested-user-pid', 'chromium-owner', 'socket-cgroup'] as const

describe.skipIf(process.platform !== 'linux')('Linux native owner sources', () => {
  it.for(cases)('%s', { timeout: 30000 }, async (name, { skip }) => {
    const root = mkdtempSync(join(tmpdir(), 'linux-owner-native-'))
    const workspace = join(root, 'workspace')
    const privateRoot = join(root, 'private')
    mkdirSync(workspace)
    mkdirSync(privateRoot, { mode: 0o700 })
    const ctx = new Context()
    let count = 0
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => {
      if (message === LINUX_SOURCE_LIMITATION) count++
    })
    const verify = (assertions: () => void) => {
      if (count > 0) {
        writeSync(1, 'unverified: delegation unavailable\n')
        skip('unverified: delegation unavailable')
      }
      assertions()
    }
    let record: CredentialRecord | undefined
    const unused = (): never => { throw new Error('Unexpected credential operation') }
    class TestCredentials extends CredentialProvider {
      resolve = unused
      describe = unused
      set = unused
      unset = unused
      readRecord = unused
      describeRecord = unused
      listRecords = unused
      deleteRecord = unused
      override get protectedStoragePaths() { return [privateRoot] }
      async modifyRecord(_key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      }
    }
    new TestCredentials(ctx)
    const server = createServer((req, res) => {
      const admission = ctx.get('connection')!.admit(req)
      res.writeHead('rejection' in admission ? admission.rejection : 200)
      res.end('rejection' in admission ? 'denied' : admission.peer.principal.kind)
    })
    let sibling: string | undefined
    let requiredLandlockMissing = false
    try {
      await ctx.plugin(Connection, { requireOwnerConfirmation: false })
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox)
      const sandbox = ctx.get('sandbox') as Sandbox
      sandbox.internals = { chain: ['landlock'] }
      const subprocess = ctx.get('subprocess')!
      const confined = name.startsWith('landlock-') || name === 'nested-user-pid'
      if (confined) {
        const probe = spawnSync(launcherPath(), ['--probe'], { encoding: 'utf8', timeout: 5000 })
        if (probe.status !== 0) {
          const reason = `native Landlock unavailable: status=${probe.status}`
          if (process.env.PANEDESK_CI_NATIVE_SANDBOX === 'required') {
            requiredLandlockMissing = true
            throw new Error(reason)
          }
          console.info(reason)
          skip(reason)
        }
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing test listener')
      const endpoint = `http://127.0.0.1:${address.port}`
      const cookie = ctx.get('connection')!.desktopCookie(endpoint)
      if (name === 'chromium-owner') {
        const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
        const { chromium } = require('playwright') as BrowserDriver
        const browser = await chromium.launch({ headless: true })
        try {
          const browserContext = await browser.newContext()
          const separator = cookie.indexOf('=')
          await browserContext.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: endpoint }])
          const page = await browserContext.newPage()
          const response = await page.goto(endpoint)
          const body = await page.textContent('body')
          verify(() => { expect(response?.status()).toBe(200); expect(body).toBe('owner') })
        } finally { await browser.close() }
      } else if (name === 'socket-cgroup') {
        const query = loadSocketCgroupQuery()
        const member = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::/'))
        if (member === undefined) throw new Error('Missing unified cgroup membership')
        const expected = statSync(join('/sys/fs/cgroup', member.slice(3)), { bigint: true }).ino
        for (const host of ['127.0.0.1', '::1']) {
          const listener = createTcpServer()
          await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, host, resolve) })
          const address = listener.address()
          if (address === null || typeof address === 'string') throw new Error('Missing test listener')
          const accepted = new Promise<Socket>((resolve) => { listener.once('connection', resolve) })
          const client = connect(address.port, host)
          await once(client, 'connect')
          const socket = await accepted
          try {
            const actual = query.query({ sourceAddress: client.localAddress!, sourcePort: client.localPort!,
              destinationAddress: client.remoteAddress!, destinationPort: client.remotePort! })
            verify(() => { expect(query.probe()).toBe(true); expect(actual).toBe(expected) })
          } finally {
            client.destroy()
            socket.destroy()
            await new Promise<void>(resolve => listener.close(() => { resolve() }))
          }
        }
      } else {
        if (name === 'nested-user-pid') {
          const probe = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', '/bin/true'], { encoding: 'utf8', timeout: 5000 })
          if (probe.status !== 0) {
            const reason = `unprivileged user/PID namespaces unavailable: status=${probe.status}; ${probe.stderr.trim()}`
            console.info(reason)
            skip(reason)
          }
        }
        const migrating = name === 'landlock-subgroup-migration'
        const argv = ['/usr/bin/python3', '-I', '-c', migrating ? migration : replay,
          ...name === 'landlock-double-fork' ? ['orphan'] : []]
        if (name === 'nested-user-pid') argv.unshift('unshare', '--user', '--map-root-user', '--pid', '--fork')
        const prepared = confined ? await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: workspace }) : { argv, productSandbox: undefined }
        const handle = subprocess.spawn({
          argv: prepared.argv, ...prepared.productSandbox === true ? { productSandbox: true } : {}, cwd: workspace,
          stdio: { stdin: migrating ? 'pipe' : { data: JSON.stringify({ endpoint, cookie }) }, stdout: 'pipe', stderr: { maxBytes: 4096 } }, graceMs: 1000 })
        let output = ''
        const ready = Promise.withResolvers<string>()
        handle.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (output.includes('\n')) ready.resolve(output.split('\n')[0]!)
        })
        void handle.done.then(() => { if (!output.includes('\n')) ready.reject(new Error('No product membership received')) }, ready.reject)
        // Only migration awaits readiness; other cases observe done directly.
        void ready.promise.catch(() => {})
        if (migrating) {
          const member = await ready.promise
          if (count > 0) { handle.stdin!.end('{}'); await handle.done; verify(() => {}) }
          verify(() => { expect(member.endsWith('/panedesk-product')).toBe(true) })
          sibling = mkdtempSync(join('/sys/fs/cgroup', dirname(member), 'owner-source-sibling-'))
          handle.stdin!.end(JSON.stringify({ sibling }))
        }
        const outcome = await handle.done
        const exited = await handle.waitForExit()
        verify(() => {
          expect(outcome.exitCode).toBe(0)
          expect(exited).toBe(true)
          if (confined) expect(prepared.productSandbox).toBe(true)
          if (migrating) {
            expect(output.split('\n').slice(1)).toEqual(['parent: denied errno=13', 'self: denied errno=13', 'sibling: denied errno=13', ''])
          } else {
            expect(output).toBe(`${name === 'landlock-double-fork' ? 'ppid=1\n' : ''}status=${confined ? '403 principal=denied' : '200 principal=owner'}\n`)
          }
        })
      }
    } catch (error) {
      if (count > 0 && !requiredLandlockMissing) {
        writeSync(1, 'unverified: delegation unavailable\n')
        skip('unverified: delegation unavailable')
      }
      throw error
    } finally {
      // Keep per-case evidence visible even when Vitest suppresses passing-test console logs.
      writeSync(1, `LINUX_SOURCE_LIMITATION count=${count} case=${name}\n`)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      await ctx.fiber.dispose()
      warn.mockRestore()
      if (sibling !== undefined) {
        try { rmdirSync(sibling) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
