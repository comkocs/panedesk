/** HTTP transport accepts only authenticated non-browser loopback JSON requests. */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { object, parseJson } from './json.ts'

const loopback = '127.0.0.1'
/** Explicit transport bounds apply to complete frames, sockets and concurrent calls. */
export interface RpcLimits { maxFrameBytes: number; requestTimeoutMs: number; maxPending: number }
/** Credential values remain in memory and private files, never endpoint URLs. */
export interface RpcAuthentication {
  credential: string
  epoch: string
  /** Optional prior epochs accepted only until their explicit overlap deadline. */
  previous?: readonly { credential: string; epoch: string; expiresAt: number }[]
  /** Host-owned alternative credentials share this listener without sharing authority. */
  alternatives?: readonly { credential: string; epoch: string; identity: object }[]
  /** Opaque host-owned identity returned only to the authenticated dispatcher. */
  identity?: object
}
/** Listener lifetime includes all accepted dispatches. */
export interface LoopbackListener { port: number; close(): Promise<void> }

/** Host refusals contain only a fixed category and bounded numeric ports. */
export interface LoopbackHostMismatch {
  code: 'host-mismatch'
  expectedPort: number
  actualPort: number | null
}
/** Node listeners opt into exact forwarding authorities and safe rejection reporting. */
export interface LoopbackHostPolicy {
  forwardedHosts: readonly string[]
  /** Report one Host refusal without request headers or authentication material.
   * @param refusal - Fixed reason and sanitized ports; a malformed port is null.
   */
  rejected(refusal: LoopbackHostMismatch): void
}
/** Accept explicit loopback authorities only; no wildcard, URL or implicit port is valid.
 * @param authority - Exact configured HTTP Host value.
 * @returns Whether the authority names a loopback host and a canonical port from 1 to 65535.
 */
export function isLoopbackAuthority(authority: string): boolean {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(authority)
  return match !== null && Number(match[1]) <= 65535
}

function hostPort(authority: string | undefined): number | null {
  const match = authority === undefined ? null : /^(?:[^\s:/@]+|\[[0-9a-fA-F:]+\]):([1-9][0-9]{0,4})$/.exec(authority)
  return match !== null && Number(match[1]) <= 65535 ? Number(match[1]) : null
}

/** Compare fixed-length random credentials without data-dependent byte comparison.
 * @param actual - Header received from the peer.
 * @param expected - Private-file credential.
 * @returns Whether the credential matches exactly.
 */
export function authenticated(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || !/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

async function body(message: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of message) {
    const value: unknown = chunk
    if (!(value instanceof Uint8Array)) throw new Error('RPC chunk rejected')
    const bytes = Buffer.from(value)
    total += bytes.length
    if (total > maxBytes) throw new Error('RPC frame exceeds limit')
    chunks.push(bytes)
  }
  return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), maxBytes)
}

/** Open only a loopback listener; no browser or ambient cookie authority is accepted.
 * @param port - Configured loopback port; zero requests a fresh OS allocation.
 * @param limits - Complete frame, concurrency and deadline bounds.
 * @param authentication - Current directional credential and epoch, read per call for rotation.
 * @param dispatch - Authenticated JSON dispatcher.
 * @returns Owned listener and awaited teardown.
 */
export function listenLoopback(port: number, limits: RpcLimits, authentication: () => RpcAuthentication,
  dispatch: (value: unknown) => Promise<unknown>): Promise<LoopbackListener> {
  return listenAuthenticatedLoopback(port, limits, authentication, dispatch)
}

/** Open a loopback listener whose dispatcher receives the actual authenticated epoch.
 * @param port - Configured loopback port, or zero for an allocated port.
 * @param limits - Complete frame, concurrency and deadline bounds.
 * @param authentication - Current credentials and explicitly bounded prior epochs.
 * @param dispatch - JSON dispatcher with transport-derived epoch evidence.
 * @param hostPolicy - Optional exact forwarding authorities and rejection reporter; omission keeps strict Host checks and empty refusals.
 * @returns Owned listener and awaited teardown.
 */
export async function listenAuthenticatedLoopback(port: number, limits: RpcLimits, authentication: () => RpcAuthentication,
  dispatch: (value: unknown, authenticatedEpoch: string, identity?: object) => Promise<unknown>,
  hostPolicy?: LoopbackHostPolicy): Promise<LoopbackListener> {
  const forwardedHosts = new Set(hostPolicy?.forwardedHosts ?? [])
  if ([...forwardedHosts].some(authority => !isLoopbackAuthority(authority))) throw new Error('Forwarded Host rejected')
  const pending = new Set<Promise<void>>()
  let closing = false
  const server: Server = createServer((req, res) => {
    const current = authentication()
    const accepted: { credential: string; epoch: string; identity?: object } | undefined =
      [current, ...(current.alternatives ?? []), ...(current.previous ?? []).filter(item => item.expiresAt > Date.now())]
        .find(item => req.headers['x-rpc-epoch'] === item.epoch && authenticated(req.headers.authorization, item.credential))
    const hostMatches = req.headers.host === `${loopback}:${actualPort}`
      || req.headers.host !== undefined && forwardedHosts.has(req.headers.host)
    const forbidden = closing || req.method !== 'POST' || req.url !== '/rpc'
      || req.headers['content-type'] !== 'application/json'
      || accepted === undefined
      || pending.size >= limits.maxPending
    res.setHeader('Connection', 'close')
    if (!hostMatches && hostPolicy !== undefined) {
      const refusal: LoopbackHostMismatch = { code: 'host-mismatch', expectedPort: actualPort, actualPort: hostPort(req.headers.host) }
      try { hostPolicy.rejected(refusal) } catch (error) { void error /* Reporting cannot admit a rejected request. */ }
      const text = JSON.stringify(refusal)
      if (!forbidden && Buffer.byteLength(text) <= limits.maxFrameBytes) {
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(text); req.resume(); return
      }
    }
    if (forbidden || !hostMatches) { res.writeHead(403); res.end(); req.resume(); return }
    const work = (async () => {
      try {
        const result = await dispatch(await body(req, limits.maxFrameBytes), accepted.epoch, accepted.identity)
        const text = JSON.stringify(result)
        if (Buffer.byteLength(text) > limits.maxFrameBytes) throw new Error('RPC response exceeds limit')
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(text)
      } catch (error) { void error; if (!res.headersSent) res.writeHead(400); res.end() }
    })()
    pending.add(work)
    void work.finally(() => { pending.delete(work) })
  })
  server.requestTimeout = limits.requestTimeoutMs
  server.headersTimeout = limits.requestTimeoutMs
  server.timeout = limits.requestTimeoutMs
  server.maxConnections = limits.maxPending
  let actualPort = port
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, loopback, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback listener unavailable')
  actualPort = address.port
  return { port: actualPort, close: async () => {
    closing = true
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    server.closeAllConnections()
    await Promise.allSettled([...pending])
    await closed
  } }
}

/** No TCP connection was established, so no request bytes could reach the peer. */
export class LoopbackConnectionError extends Error {}

/** A validated HTTP Host refusal is known non-dispatch, never peer status evidence. */
export class LoopbackHostMismatchError extends Error {
  /** Fixed safe diagnostic for opt-in sender status projection. */
  readonly code = 'host-mismatch'
  constructor(readonly expectedPort: number, readonly actualPort: number | null) { super('host-mismatch') }
}

function hostRefusal(value: unknown): LoopbackHostMismatchError | undefined {
  if (!object(value) || value.code !== 'host-mismatch'
    || !Number.isInteger(value.expectedPort) || Number(value.expectedPort) < 1 || Number(value.expectedPort) > 65535
    || value.actualPort !== null && (!Number.isInteger(value.actualPort) || Number(value.actualPort) < 1
      || Number(value.actualPort) > 65535)) return undefined
  return new LoopbackHostMismatchError(Number(value.expectedPort), value.actualPort === null ? null : Number(value.actualPort))
}

/** Send exactly once; a missing response after dispatch is an unknown outcome.
 * A LoopbackConnectionError identifies failure before TCP connection; all later failures remain ambiguous.
 * @param port - Loopback tunnel or local listener port.
 * @param auth - Private-file authentication kept out of URLs and environments.
 * @param value - Complete JSON request.
 * @param limits - Response and request deadline bounds.
 * @param reportHostMismatch - Decode bounded Host refusals when true; omission keeps generic transport errors.
 * @returns Valid JSON; opt-in Host refusals reject with only a fixed code and sanitized ports.
 */
export function callLoopback(port: number, auth: RpcAuthentication, value: unknown, limits: RpcLimits,
  reportHostMismatch = false): Promise<unknown> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > limits.maxFrameBytes) return Promise.reject(new Error('RPC frame exceeds limit'))
  return new Promise((resolve, reject) => {
    let connected = false
    const req = httpRequest({ host: loopback, port, method: 'POST', path: '/rpc', agent: false,
      headers: { 'content-type': 'application/json', authorization: auth.credential, 'x-rpc-epoch': auth.epoch },
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    }, (res) => {
      if (reportHostMismatch && res.statusCode === 403 && res.headers['content-type'] === 'application/json') {
        void body(res, limits.maxFrameBytes).then((value) => {
          reject(hostRefusal(value) ?? new Error('RPC request refused'))
        }, () => { reject(new Error('RPC request refused')) })
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('RPC request refused')); return }
      void body(res, limits.maxFrameBytes).then(resolve, () => { reject(new Error('RPC response rejected')) })
    })
    req.on('socket', (socket) => {
      socket.once('connect', () => { connected = true })
    })
    req.on('error', () => {
      reject(connected ? new Error('RPC outcome unavailable') : new LoopbackConnectionError('RPC outcome unavailable'))
    })
    req.end(text)
  })
}
