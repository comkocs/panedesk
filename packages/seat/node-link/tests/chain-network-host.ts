/** Parent owns each test child PID, directional credentials, private directory and teardown. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PosixPrivateFiles, listenLoopback, parseJson, object } from '@panedesk/dsh-host-admin'
import { resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'

/** Start one isolated Loader node using the selected workspace launch mode.
 * @param directory - Private node directory containing only this node's retained state.
 * @returns Bounded IPC commands and awaited process teardown.
 */
export async function networkWorker(directory: string) {
  const script = fileURLToPath(new URL('./chain-network-worker.ts', import.meta.url))
  const launch = resolveExampleLaunch({ srcBin: script, libBin: script, configArgs: [directory],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) })
  const env = Object.fromEntries(Object.entries({ ...process.env, ...launch.env })
    .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  const child = spawn(launch.command, launch.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let diagnostics = ''
  child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const next = async (): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined
    try {
      const line = await Promise.race([lines.next(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`Network worker response timed out: ${diagnostics}`)) }, 10000)
      })])
      if (line.done) throw new Error(`Network worker exited: ${diagnostics}`)
      return parseJson(line.value, 1048576)
    } finally { if (timer) clearTimeout(timer) }
  }
  let stopped = false
  const close = async (crash = false) => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.signalCode === null) {
      if (crash) child.kill('SIGKILL')
      else child.stdin.end(`${JSON.stringify({ kind: 'close' })}\n`)
    }
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10000)
    try { await exited } finally { clearTimeout(timer) }
    return { pid: child.pid, code: child.exitCode, signal: child.signalCode }
  }
  try {
    const ready = await next()
    if (!object(ready) || ready.ready !== true || ready.pid !== child.pid) throw new Error('Network worker readiness rejected')
  } catch (error) { await close(true); throw error }
  return { pid: child.pid, directory, close, call: async (command: unknown) => {
    child.stdin.write(`${JSON.stringify(command)}\n`)
    return next()
  } }
}

/** Provision one group; nodes never share business stores or authorization evidence.
 * @param staleMs - Health probe interval; long intervals let tests observe pre-probe failures.
 * @returns Independent node paths, restart operation, and reverse-order cleanup.
 */
export async function networkPair(staleMs = 100) {
  const root = await mkdtemp(join(tmpdir(), 'chain-network-'))
  const limits = { maxFrameBytes: 4096, requestTimeoutMs: 500, maxPending: 2,
    maxStoreBytes: 1048576, maxOperations: 100, staleMs }
  const auth = () => ({ credential: randomBytes(32).toString('hex'), epoch: randomUUID() })
  const reserved = [await listenLoopback(0, limits, auth, async () => ({})), await listenLoopback(0, limits, auth, async () => ({}))]
  const ports = reserved.map(item => item.port)
  await Promise.all(reserved.map(item => item.close()))
  const credentials = [auth(), auth()]
  const directories = [join(root, 'node-a'), join(root, 'node-b')]
  const children: Awaited<ReturnType<typeof networkWorker>>[] = []
  for (const i of [0, 1]) {
    const nodeId = i === 0 ? 'node-a' : 'node-b', peerNodeId = i === 0 ? 'node-b' : 'node-a'
    const directory = directories[i]!, files = new PosixPrivateFiles(directory, process.getuid!())
    await files.write('inbound.json', JSON.stringify({ ...credentials[i], sourceNodeId: peerNodeId, targetNodeId: nodeId }))
    await files.write('outbound.json', JSON.stringify({ ...credentials[1 - i], sourceNodeId: nodeId, targetNodeId: peerNodeId }))
    await files.write('worker.json', JSON.stringify({ ...limits, directory, nodeId, peerNodeId, peerName: peerNodeId,
      listenPort: ports[i], peerPort: ports[1 - i] }))
  }
  return { directories, start: async (index: number) => {
    const child = await networkWorker(directories[index]!)
    children.push(child)
    return child
  }, close: async () => {
    for (const child of children.reverse()) await child.close()
    await rm(root, { recursive: true, force: true })
  } }
}
