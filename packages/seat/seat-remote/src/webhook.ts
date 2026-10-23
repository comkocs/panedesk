/** Raw-byte external source authentication; only registered targets reach durable ingress. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@panedesk/cordis'
import { credentialRef } from '@panedesk/dsh-credentials'
import type {} from '@panedesk/dsh-host-webserver'
import type { SeatDigest, SeatName, SeatProjectId, SeatSourceId, TriggerEnvelope, SeatFailure, SeatCallbackPayload } from '@panedesk/dsh-seat'
import { EngineError, SeatEngine } from '@panedesk/dsh-seat-engine'

/** Trusted source configuration never contains credential values. */
export interface WebhookSource {
  /** Registered ingress identity matched against the request source header. */
  sourceId: SeatSourceId
  /** Exact destination seat allowed for this source. */
  seat: SeatName
  /** Project attached to accepted source events. */
  projectId: SeatProjectId
  /** Signing key versions mapped to credential references, never secret values. */
  credentialRefs: Readonly<Record<string, string>>
  /** Optional receipt destination; only HTTP(S) and a registered signing key version are accepted. */
  callback?: {
    /** Trusted destination resolved from this registration, never from event data. */
    url: string
    /** Signing version present in this source's credentialRefs. */
    keyVersion: string
  }
}
/** Explicit deployment bounds; no network address or secret enters audit records. */
export interface WebhookOptions {
  /** Exact HTTP route; must start with a slash and have no trailing slash. */
  path: string
  /** Maximum raw request bytes retained before rejecting the body. */
  maxBodyBytes: number
  /** Maximum absolute timestamp difference from the local clock in milliseconds. */
  maxClockSkewMs: number
  /** Milliseconds allowed to receive the complete request body. */
  bodyTimeoutMs: number
  /** Unique source identities and their authorized destinations and key references. */
  sources: readonly WebhookSource[]
  /** Durable rejection sink; completion precedes the rejection response. */
  audit: (fact: {
    /** Registered source identity, or the unregistered-source sentinel. */
    sourceId: SeatSourceId
    /** Digest of the bounded raw body prefix without retaining source text. */
    digest: SeatDigest
    /** Local ISO timestamp when rejection was observed. */
    observedAt: string
    /** Structured refusal without credential values or network addresses. */
    error: SeatFailure
  }) => Promise<void>
}

/** Handle one bounded signed request and acknowledge only durable acceptance.
 * @param ctx - service context with optional credentials and engine.
 * @param options - trusted source allowlist and limits.
 * @param req - untouched HTTP body stream.
 * @param res - owned HTTP response.
 * @param signal - unload cancellation for requests not yet admitted.
 * @returns after response completion; private provider errors never escape to HTTP logging.
 */
export async function handleWebhook(
  ctx: Context, options: WebhookOptions, req: IncomingMessage, res: ServerResponse, signal?: AbortSignal,
): Promise<void> {
  const reply = (status: number, code: string): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code })) }
  const source = options.sources.find(item => item.sourceId === req.headers['x-seat-source'])
  const chunks: Buffer[] = []
  const hash = createHash('sha256')
  let bytes = 0
  const reject = async (code: SeatFailure['code'], status = 401): Promise<void> => {
    await options.audit({ sourceId: source?.sourceId ?? 'unregistered-source' as SeatSourceId, digest: hash.copy().digest('hex') as SeatDigest,
      observedAt: new Date().toISOString(), error: { code, message: 'External source request was rejected.',
        alternative: 'Check source registration, request bounds and signing configuration.', retryable: false, effectState: 'none' } })
    reply(status, code)
  }
  try {
    if (req.method !== 'POST') { await reject('invalid-request', 405); return }
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { await reject('invalid-request', 415); return }
    const read = await new Promise<'complete' | 'large' | 'timeout' | 'cancelled'>((resolve) => {
      const finish = (outcome: 'complete' | 'large' | 'timeout' | 'cancelled'): void => { cleanup(); resolve(outcome) }
      const data = (chunk: Buffer): void => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const retained = part.subarray(0, Math.max(0, options.maxBodyBytes - bytes))
        hash.update(retained)
        bytes += part.byteLength
        if (bytes > options.maxBodyBytes) { finish('large'); return }
        chunks.push(retained)
      }
      const end = (): void => { finish('complete') }
      const abort = (): void => { finish('cancelled') }
      const error = (): void => { finish('cancelled') }
      const timer = setTimeout(() => { finish('timeout') }, options.bodyTimeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer); req.pause()
        req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', abort)
        signal?.removeEventListener('abort', abort)
      }
      req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', abort)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || req.destroyed) abort()
    })
    if (read === 'large') { await reject('source-payload-too-large', 413); return }
    if (read === 'timeout') { await reject('invalid-request', 408); return }
    if (read === 'cancelled' || signal?.aborted) { await reject('unavailable', 503); return }
    if (!source) { await reject('source-authentication-failed'); return }
    const body = Buffer.concat(chunks)
    const digest = hash.copy().digest('hex') as SeatDigest
    const now = new Date()
    const timestamp = req.headers['x-seat-timestamp'], signature = req.headers['x-seat-signature'], version = req.headers['x-seat-key-version']
    if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
      || Math.abs(now.getTime() - Number(timestamp)) > options.maxClockSkewMs) { await reject('source-timestamp-invalid'); return }
    if (typeof version !== 'string' || !Object.hasOwn(source.credentialRefs, version)
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) { await reject('source-authentication-failed'); return }
    const credentials = ctx.get('credentials'), engine = ctx.get('seatEngine')
    if (!credentials || !engine) { reply(503, 'unavailable'); return }
    const ref = source.credentialRefs[version]
    if (!ref) { reply(503, 'unavailable'); return }
    const credential = await credentials.resolve(credentialRef(ref))
    if (!credential) { reply(503, 'unavailable'); return }
    const expected = createHmac('sha256', credential.value).update(`${timestamp}.`).update(body).digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) { await reject('source-authentication-failed'); return }
    let data: unknown
    try {
      data = JSON.parse(body.toString('utf8'), (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite source data')
        return value
      })
    } catch (error) { void error; await reject('invalid-request', 400); return }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('eventType' in data) || typeof data.eventType !== 'string' || !data.eventType
      || ('eventId' in data && (typeof data.eventId !== 'string' || !data.eventId))
      || Object.keys(data).some(key => !['eventId', 'eventType', 'data'].includes(key))) { await reject('invalid-request', 400); return }
    if (signal?.aborted) { await reject('unavailable', 503); return }
    const envelope: TriggerEnvelope = { triggerId: randomUUID() as TriggerEnvelope['triggerId'], sourceId: source.sourceId,
      ...('eventId' in data ? { eventId: data.eventId as NonNullable<TriggerEnvelope['eventId']> } : {}), kind: 'external', evidence: { kind: 'external', eventType: data.eventType },
      seat: source.seat, projectId: source.projectId, receivedAt: now.toISOString(), dataDigest: digest,
      data: ('data' in data ? data.data : null) as TriggerEnvelope['data'], callbackRef: source.sourceId }
    const result = await engine.accept(envelope)
    if (result.status === 'rejected') { reply(result.error.retryable ? 503 : 400, result.error.code); return }
    res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
  } catch (error) {
    void error
    if (!res.headersSent) reply(503, 'unavailable')
    else res.end()
  }
}

async function deliverCallback(ctx: Context, source: WebhookSource, engine: SeatEngine, payload: SeatCallbackPayload): Promise<void> {
  const callback = source.callback
  if (!callback) return
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, engine.options.config.callbackTimeoutMs)
  let status: number, oversized = false
  try {
    const credentials = ctx.get('credentials'), ref = source.credentialRefs[callback.keyVersion]
    if (!credentials || !ref) throw new Error('Callback credentials are unavailable')
    const credential = await credentials.resolve(credentialRef(ref))
    if (!credential) throw new Error('Callback credentials are unavailable')
    controller.signal.throwIfAborted()
    const body = JSON.stringify(payload), timestamp = String(Date.now())
    const signature = createHmac('sha256', credential.value).update(`${timestamp}.`).update(body).digest('hex')
    const response = await fetch(callback.url, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-seat-source': source.sourceId, 'x-seat-timestamp': timestamp,
        'x-seat-key-version': callback.keyVersion, 'x-seat-signature': signature, 'idempotency-key': payload.callbackId }, body })
    status = response.status
    const reader = response.body?.getReader()
    if (reader) {
      try {
        let bytes = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > engine.options.config.callbackMaxResponseBytes) { oversized = true; controller.abort(); break }
        }
      } finally { reader.releaseLock() }
    }
  } catch (error) {
    // Provider and transport diagnostics can contain credentials or the registered destination.
    void error
    throw new Error('External source callback could not complete')
  } finally { clearTimeout(timer) }
  if (status === 401 || status === 403) throw new EngineError('callback-authentication-failed', 'External source callback authentication failed')
  if (status >= 500) throw new Error('External source callback is temporarily unavailable')
  if (oversized || status < 200 || status >= 300) throw new EngineError('callback-protocol-error', 'External source callback response violated protocol')
}

/** Register an optional route and drain owned requests during unload.
 * @param ctx - route owner.
 * @param options - explicit route policy and durable audit sink.
 */
export function registerWebhook(ctx: Context, options: WebhookOptions): void {
  if (!options.path.startsWith('/') || options.path.endsWith('/') || !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0
    || !Number.isSafeInteger(options.maxClockSkewMs) || options.maxClockSkewMs < 0
    || !Number.isSafeInteger(options.bodyTimeoutMs) || options.bodyTimeoutMs <= 0) throw new Error('Invalid external source bounds')
  if (new Set(options.sources.map(source => source.sourceId)).size !== options.sources.length) throw new Error('Duplicate external source')
  for (const source of options.sources) {
    if (!source.callback) continue
    let url: URL
    try { url = new URL(source.callback.url) }
    catch (error) { void error; throw new Error('Invalid external source bounds') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !Object.hasOwn(source.credentialRefs, source.callback.keyVersion) || !source.credentialRefs[source.callback.keyVersion]) {
      throw new Error('Invalid external source bounds')
    }
  }
  const install = (owner: Context) => {
    const engine = owner.get('seatEngine'), web = owner.get('webServer')
    if (!engine || !web) return
    for (const source of options.sources) {
      if (source.callback && !(engine instanceof SeatEngine)) throw new Error('External source callback requires engine delivery bounds')
      owner.effect(() => engine.registerSource({
        sourceId: source.sourceId, kinds: ['external'], maxRedeliveryMs: null,
        callback: async (payload) => {
          if (source.callback && engine instanceof SeatEngine) await deliverCallback(owner, source, engine, payload)
        },
      }))
    }
    owner.effect(() => {
      const running = new Set<Promise<void>>()
      const controller = new AbortController()
      const remove = web.register({ kind: 'exact', path: options.path, handler(req, res) {
        const task = handleWebhook(ctx, options, req, res, controller.signal)
        running.add(task)
        return task.finally(() => { running.delete(task) })
      } })
      return async () => { remove(); controller.abort(); await Promise.all(running) }
    })
  }
  if (ctx.get('seatEngine') && ctx.get('webServer')) install(ctx)
  else ctx.inject(['seatEngine', 'webServer'], install)
}
