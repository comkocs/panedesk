/** Raw-byte external source authentication; only registered targets reach durable ingress. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@panedesk/cordis'
import { credentialRef } from '@panedesk/dsh-credentials'
import type {} from '@panedesk/dsh-host-webserver'
import type { SeatDigest, SeatName, SeatProjectId, SeatSourceId, TriggerEnvelope, SeatFailure } from '@panedesk/dsh-seat'

/** Trusted source configuration never contains credential values. */
export interface WebhookSource {
  sourceId: SeatSourceId
  seat: SeatName
  projectId: SeatProjectId
  credentialRefs: Readonly<Record<string, string>>
}
/** Explicit deployment bounds; no network address or secret enters audit records. */
export interface WebhookOptions {
  path: string
  maxBodyBytes: number
  maxClockSkewMs: number
  bodyTimeoutMs: number
  sources: readonly WebhookSource[]
  audit: (fact: { sourceId: SeatSourceId; digest: SeatDigest; observedAt: string; error: SeatFailure }) => Promise<void>
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

/** Register an optional route and drain owned requests during unload.
 * @param ctx - route owner.
 * @param options - explicit route policy and durable audit sink.
 */
export function registerWebhook(ctx: Context, options: WebhookOptions): void {
  if (!options.path.startsWith('/') || options.path.endsWith('/') || !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0
    || !Number.isSafeInteger(options.maxClockSkewMs) || options.maxClockSkewMs < 0
    || !Number.isSafeInteger(options.bodyTimeoutMs) || options.bodyTimeoutMs <= 0) throw new Error('Invalid external source bounds')
  if (new Set(options.sources.map(source => source.sourceId)).size !== options.sources.length) throw new Error('Duplicate external source')
  const web = ctx.get('webServer')
  if (!web) return
  ctx.effect(() => {
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
