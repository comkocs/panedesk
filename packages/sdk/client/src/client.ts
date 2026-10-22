/**
 * Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
 * {@link HarnessClient} owns the child process: it spawns the runtime, speaks
 * the `@panedesk/dsh-sdk-protocol` wire over the child's stdio, fans
 * server notifications out to subscriptions, and tears the child down to
 * quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
 * twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
 * same runtime protocol. This client runs OUTSIDE any harness context, so it
 * spawns directly rather than through the `dsh-subprocess` service — the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @panedesk/dsh-sdk-client/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  MESSAGES_VERSION,
  decodeMessagesResult,
  decodeMessageState,
  type MessagesRequestMap,
  type MessageStateEvent,
  type MessageSubscriptionRequest,
  type SendMessageRequest,
  type SendBatchRequest,
  type InitializeParams,
  type InitializeResult,
  type SessionPromptParams,
  type SdkPromptContentBlock,
} from '@panedesk/dsh-sdk-protocol'
import { readProcessIdentity, type SubprocessIdentity, type SubprocessOutcome } from '@panedesk/dsh-subprocess'
import { disposeRuntimeProcess } from './dispose.ts'
import { resolveDshLaunch, type RuntimeProcessOptions } from './launch.ts'
import type { HarnessClientOptions, HarnessNotification, NotificationFilter } from './types.ts'

/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 400

/** Grace for the runtime's stdio streams to settle after its exit edge. */
const STREAM_SETTLE_MS = 100

/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export class TransportClosedError extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
export class RequestTimeoutError extends Error {
  /** @param message - which method timed out. */
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * The runtime answered outside its documented protocol (for example a
 * `session/prompt` response without `accepted: true`).
 */
export class SdkProtocolError extends Error {
  /** @param message - the protocol violation description. */
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

interface SubscriptionState {
  readonly queue: HarnessNotification[]
  readonly waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  readonly filter: NotificationFilter | undefined
  failure: Error | undefined
}

/** One client-side notification stream returned by {@link HarnessClient.subscribe}. */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification>

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void
}

/** Internal producer side of a public notification subscription. */
class NotificationSubscriptionImpl implements NotificationSubscription {
  constructor(
    private readonly state: SubscriptionState,
    private readonly unsubscribe: () => void,
  ) {}

  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification> {
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    return new Promise((resolve, reject) => {
      this.state.waiters.push({ resolve, reject })
    })
  }

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined {
    return this.state.queue.shift()
  }

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void {
    this.unsubscribe()
    // The drop is part of this method's contract; a runtime-death fail() keeps
    // the queue so already-delivered notifications remain drainable.
    this.state.queue.length = 0
    this.fail(new TransportClosedError('notification subscription closed'))
  }

  /**
   * Reject pending and future waits (delivery stops; the first failure wins).
   * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
   * @param error - the terminal failure delivered to waiters.
   */
  fail(error: Error): void {
    this.state.failure ??= error
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure)
  }

  /**
   * Deliver one notification to a waiter or the queue when the filter
   * matches. A throwing filter fails only THIS subscription (detached, the
   * throw becomes its terminal error) — it never disturbs sibling
   * subscriptions or the transport's read loop.
   * @param notification - the wire notification to deliver.
   */
  push(notification: HarnessNotification): void {
    let matches: boolean
    try {
      matches = this.state.filter === undefined || this.state.filter(notification)
    } catch (error) {
      this.unsubscribe()
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!matches) return
    const waiter = this.state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(notification)
    else this.state.queue.push(notification)
  }

  /**
   * Iterate notifications until the subscription or runtime closes (the
   * terminating rejection propagates).
   * @returns an async iterator over {@link next} results.
   */
  async * [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> {
    for (;;) yield await this.next()
  }
}

/**
 * JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
 *
 * The subprocess starts lazily on {@link start} and is owned by this instance
 * until {@link close}, which requests protocol `shutdown` and then walks the
 * shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
 * wire-level cancel: a timed-out request stays running server-side until the
 * runtime is closed.
 */
export class HarnessClient {
  /** Original public dsh launch and timeout options for this client. */
  readonly options: HarnessClientOptions
  private messagesVersion: number | undefined
  /** Message operations require a successful version negotiation; prompt remains queued. */
  readonly messages = {
    send: (request: SendMessageRequest) => this.messageRequest('messages/send', resolveMessageSend(request)),
    withdraw: (request: MessagesRequestMap['messages/withdraw']['params']) => this.messageRequest('messages/withdraw', request),
    edit: (request: MessagesRequestMap['messages/edit']['params']) => this.messageRequest('messages/edit', request),
    reprioritize: (request: MessagesRequestMap['messages/reprioritize']['params']) => this.messageRequest('messages/reprioritize', request),
    invalidate: (request: MessagesRequestMap['messages/invalidate']['params']) => this.messageRequest('messages/invalidate', request),
    status: (messageId: MessagesRequestMap['messages/status']['params']['messageId']) => this.messageRequest('messages/status', { messageId }),
    operationStatus: (operationId: MessagesRequestMap['messages/operationStatus']['params']['operationId']) => this.messageRequest('messages/operationStatus', { operationId }),
    list: (query: MessagesRequestMap['messages/list']['params']) => this.messageRequest('messages/list', query),
    resolve: (addresses: MessagesRequestMap['messages/resolve']['params']['addresses']) => this.messageRequest('messages/resolve', { addresses }),
    sendBatch: (request: SendBatchRequest) => this.messageRequest('messages/sendBatch', resolveMessageSend(request)),
    configure: (request: MessagesRequestMap['messages/configure']['params']) => this.messageRequest('messages/configure', request),
    subscribe: (request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> => this.messageEvents(request),
  }
  private readonly runtime: RuntimeProcessOptions
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private readonly stderrTail: string[] = []
  private readonly subscriptions = new Map<string, NotificationSubscriptionImpl>()
  private readonly sessionParents = new Map<string, string>()
  private subscriptionSerial = 0
  private exitCode: number | null | undefined
  private spawnError: Error | undefined
  private streamsSettled: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined
  private identity: SubprocessIdentity | undefined
  private spawnReady: Promise<void> = Promise.resolve()
  private exitObserved: Promise<void> = Promise.resolve()
  private spawnObserver: ((identity: SubprocessIdentity) => Promise<void>) | undefined
  private exitObserver: ((outcome: SubprocessOutcome) => Promise<void>) | undefined

  /** Immutable OS observation; absent until the direct child reports spawn. */
  get processIdentity(): SubprocessIdentity | undefined { return this.identity }

  /** Install durable lifecycle observers before spawning. Requests await the spawn observer.
   * @param spawned - durable identity registration, whose rejection blocks initialization.
   * @param exited - direct exit observer; close awaits its durable acknowledgement.
   */
  observeProcess(
    spawned: (identity: SubprocessIdentity) => Promise<void>,
    exited: (outcome: SubprocessOutcome) => Promise<void>,
  ): void {
    if (this.child !== undefined) throw new Error('Process observers must be installed before spawn')
    this.spawnObserver = spawned
    this.exitObserver = exited
  }

  /** Await OS spawn and durable identity registration without sending a frame.
   * @returns acknowledgement, or the spawn/registration failure.
   */
  async waitForSpawn(): Promise<void> {
    this.start()
    await this.spawnReady
  }

  /** @param options - dsh profile, patch, home, process, environment, and timeout options. */
  constructor(options?: HarnessClientOptions)
  constructor(options: HarnessClientOptions = {}, runtime?: RuntimeProcessOptions) {
    this.options = options
    this.runtime = runtime ?? resolveDshLaunch(options)
  }

  /**
   * Spawn the runtime subprocess and start reading frames. Idempotent while
   * the process is live; rejects reuse after {@link close}.
   */
  start(): void {
    if (this.closeTask !== undefined) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    if (this.child !== undefined) return
    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.runtime.cwd,
      env: this.runtime.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.spawnReady = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => {
        if (child.pid === undefined) { reject(new Error('Spawn did not publish a PID')); return }
        const identity = readProcessIdentity(child.pid)
        this.identity = identity
        Promise.resolve().then(() => this.spawnObserver?.(identity)).then(resolve, reject)
      })
    })
    // Keep the original rejection for waiters without an unhandled rejection on start-only use.
    void this.spawnReady.catch(() => {})
    child.once('error', (error) => {
      this.spawnError = error
      // A spawn failure destroys the pipes without an input 'end' edge, so the
      // transport's pending requests must be failed here.
      this.transport?.close()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime failed to start'))
    })
    // Writes racing the runtime's death EPIPE on stdin; the exit edge below is
    // the real signal, so the stream-level error only needs to be non-fatal.
    // The timing of that race is not deterministically reproducible.
    /* v8 ignore next */
    child.stdin.on('error', () => {})
    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const newline = stderrBuffer.lastIndexOf('\n')
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split('\n'))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    })
    let signalStreamsSettled!: () => void
    this.streamsSettled = new Promise((resolve) => { signalStreamsSettled = resolve })
    const settled = { stderr: false, exited: false }
    const maybeSettle = (): void => {
      if (settled.stderr && settled.exited) signalStreamsSettled()
    }
    child.stderr.once('close', () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer])
      settled.stderr = true
      maybeSettle()
    })
    child.once('exit', (code, signal) => {
      this.exitObserved = Promise.resolve().then(() => this.exitObserver?.({ exitCode: code, signal }))
      void this.exitObserved.catch(() => {})
      this.exitCode = code
      settled.exited = true
      maybeSettle()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime exited'))
    })
    child.once('close', (exitCode, signal) => {
      if (this.exitCode === undefined) {
        this.exitObserved = Promise.resolve().then(() => this.exitObserver?.({ exitCode, signal }))
        void this.exitObserved.catch(() => {})
      }
      // All stdio has settled: stdout 'end' already drained every tail frame,
      // so closing now cannot drop responses — it only fails requests that
      // will never be answered.
      this.transport?.close()
    })
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onNotification((method, params) => { this.dispatchNotification({ method, params }) })
    transport.start()
    this.transport = transport
  }

  /**
   * Perform the process-wide handshake.
   * @param params - workspace cwd plus the provider/model route.
   * @returns the runtime's wire identity.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.messagesVersion = undefined
    const result = await this.request('initialize', { messagesVersion: MESSAGES_VERSION, ...params }, this.runtime.initializeTimeoutMs)
    if (!isRecord(result) || !isRecord(result.serverInfo)
      || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`)
    }
    if (result.messagesVersion !== undefined && (!Number.isSafeInteger(result.messagesVersion) || Number(result.messagesVersion) <= 0)) {
      throw new SdkProtocolError('initialize returned an invalid messagesVersion')
    }
    this.messagesVersion = result.messagesVersion === MESSAGES_VERSION ? MESSAGES_VERSION : undefined
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version },
      ...this.messagesVersion === undefined ? {} : { messagesVersion: this.messagesVersion } }
  }

  /**
   * Queue one prompt and return its durable inbox identity.
   * @param sessionId - target session; an unknown id creates it.
   * @param contentBlocks - the user message, sent verbatim.
   * @returns the queued message id.
   */
  async prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]): Promise<string> {
    const params: SessionPromptParams = { sessionId, contentBlocks }
    const result = await this.request('session/prompt', { ...params })
    if (!isRecord(result) || typeof result.messageId !== 'string') {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return result.messageId
  }

  /**
   * Restore persisted history without sending a prompt; failures propagate without creating a session.
   * @param sessionId - persisted identity in this runtime's configured persistence store.
   * @returns after the session is ready for prompts.
   */
  async resumeSession(sessionId: string): Promise<void> {
    await this.request('session/resume', { sessionId })
  }

  /**
   * Read a Session's effective working directory, recovering it if missing.
   * @param sessionId - target Session; an unknown id creates it.
   * @returns the absolute effective directory.
   */
  getWorkingDirectory(sessionId: string): Promise<string> {
    return this.workingDirectoryRequest('session/working-directory/get', { sessionId })
  }

  /**
   * Change a Session's effective directory without changing origin or permissions.
   * @param sessionId - target Session; an unknown id creates it.
   * @param path - absolute or Session-current-directory-relative path.
   * @returns the validated absolute directory.
   */
  setWorkingDirectory(sessionId: string, path: string): Promise<string> {
    return this.workingDirectoryRequest('session/working-directory/set', { sessionId, path })
  }

  private async messageRequest<M extends keyof MessagesRequestMap>(method: M, params: MessagesRequestMap[M]['params']): Promise<MessagesRequestMap[M]['result']> {
    if (this.messagesVersion !== MESSAGES_VERSION) {
      throw new JsonRpcResponseError(-32601, 'Message delivery is unsupported by the runtime', { reason: 'unsupported' })
    }
    const result = await this.request(method, params)
    try {
      return decodeMessagesResult(method, result)
    } catch (error) {
      throw new SdkProtocolError(errorMessage(error))
    }
  }

  private async * messageEvents(request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> {
    const subscription = this.subscribe((notification) => {
      if (notification.method === 'messages.error') return notification.params.sessionId === request.sessionId
      if (notification.method !== 'messages.state') return false
      const event = decodeMessageState(notification.params)
      return event.data.senderSessionId === request.sessionId || event.data.targetSessionId === request.sessionId
    })
    let cursor = request.cursor
    try {
      await this.messageRequest('messages/subscribe', request)
      for (;;) {
        const notification = await subscription.next()
        if (notification.method === 'messages.error') {
          throw new JsonRpcResponseError(-32603, 'Message receipt stream is unavailable', { reason: 'unavailable', cursor })
        }
        const event = decodeMessageState(notification.params)
        if (event.cursor === cursor) continue
        cursor = event.cursor
        yield event
      }
    } finally {
      subscription.close()
    }
  }

  private async workingDirectoryRequest(method: string, params: object): Promise<string> {
    const result = await this.request(method, params)
    if (!isRecord(result) || typeof result.cwd !== 'string') {
      throw new SdkProtocolError(`${method} returned no working directory: ${JSON.stringify(result)}`)
    }
    return result.cwd
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the wire method name.
   * @param params - the params object; omitted params send `{}`.
   * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
   * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
   * protocol error response, {@link RequestTimeoutError} on timeout, and
   * {@link TransportClosedError} when the runtime is gone.
   */
  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    if (method !== 'shutdown') {
      try { await this.spawnReady } catch (error) {
        if (this.spawnError === undefined) throw error
        await this.settleStreams()
        throw this.closedError('DeepSeek Harness runtime failed to start')
      }
    }
    // A dead runtime cannot answer; fail with process context instead of
    // writing into a destroyed pipe and hanging until the timeout.
    if (this.exitCode !== undefined || this.spawnError !== undefined) {
      await this.settleStreams()
      throw this.closedError('DeepSeek Harness runtime is not running')
    }
    const transport = this.transport
    /* v8 ignore next -- start() either sets the transport or throws */
    if (transport === undefined) throw new TransportClosedError('DeepSeek Harness runtime is not running')
    const timeout = timeoutMs ?? this.runtime.requestTimeoutMs
    try {
      if (timeout === undefined) return await transport.request(method, params ?? {})
      // The abort signal makes the timeout an abandonment: the transport drops
      // its pending entry, so repeated bounded requests against a hung method
      // retain no per-call state (the server-side work still runs to close).
      const abandon = new AbortController()
      const timer = setTimeout(() => {
        const stderr = this.stderrTail.length === 0 ? '' : `; stderr tail:\n${this.stderrTail.join('\n')}`
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for ${this.runtime.description}${stderr}`))
      }, timeout)
      try {
        return await transport.request(method, params ?? {}, abandon.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error
      // Transport-level failures gain process context: exit code + stderr tail.
      await this.settleStreams()
      throw this.closedError(errorMessage(error))
    }
  }

  /**
   * Subscribe to server notifications.
   * @param filter - optional predicate; omitted means every notification.
   * @returns the subscription handle; close it to stop delivery. After
   * {@link close} or runtime death the handle is born failed — there is no
   * producer left, so `next()` rejects instead of waiting forever.
   */
  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const id = String(this.subscriptionSerial++)
    const state: SubscriptionState = { queue: [], waiters: [], filter, failure: undefined }
    const subscription = new NotificationSubscriptionImpl(state, () => { this.subscriptions.delete(id) })
    if (this.closeTask !== undefined || this.exitCode !== undefined || this.spawnError !== undefined) {
      subscription.fail(this.closedError('DeepSeek Harness runtime closed'))
      return subscription
    }
    this.subscriptions.set(id, subscription)
    return subscription
  }

  /**
   * Subscribe to one session and the descendants discovered from
   * `subagent.started` lineage edges. The runtime notifies for every session
   * in its context, so this client applies the scope.
   * @param sessionId - the root session id.
   * @returns the filtered subscription handle.
   */
  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        const parentId = params.parentSessionId
        if (typeof parentId === 'string' && this.isDescendantOf(parentId, sessionId)) return true
        return params.childSessionId === sessionId
      }
      const relatedId = params.sessionId
      return typeof relatedId === 'string' && this.isDescendantOf(relatedId, sessionId)
    })
  }

  /**
   * Shut the runtime down and reap it: a best-effort protocol `shutdown`
   * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
   * SIGKILL ladder until the process actually exited. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, this.runtime.shutdownTimeoutMs ?? 1_000)
    } catch (error) {
      // Diagnostic only: the dispose ladder below is the authoritative teardown
      // for a runtime that cannot answer shutdown anymore.
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`])
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.runtime.disposeEofGraceMs ?? 6_000,
      disposeGraceMs: this.runtime.disposeGraceMs ?? 3_000,
      ...this.identity === undefined ? {} : { processIdentity: this.identity },
    })
    this.transport?.close()
    this.failSubscriptions(this.closedError('DeepSeek Harness runtime closed'))
    await this.exitObserved
  }

  private dispatchNotification(notification: HarnessNotification): void {
    this.recordSessionRelationship(notification)
    for (const subscription of this.subscriptions.values()) subscription.push(notification)
  }

  private recordSessionRelationship(notification: HarnessNotification): void {
    if (notification.method !== 'subagent.started') return
    const parentId = notification.params.parentSessionId
    const childId = notification.params.childSessionId
    if (typeof parentId === 'string' && parentId !== '' && typeof childId === 'string' && childId !== '' && parentId !== childId) {
      this.sessionParents.set(childId, parentId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.sessionParents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    // The parent map only ever extends chains upward, so a cycle cannot form.
    /* v8 ignore next */
    return false
  }

  private failSubscriptions(error: Error): void {
    for (const subscription of this.subscriptions.values()) subscription.fail(error)
  }

  private appendStderr(lines: string[]): void {
    const kept = lines.filter(line => line.length > 0)
    this.stderrTail.push(...kept)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private settleStreams(): Promise<void> {
    return Promise.race([
      this.streamsSettled,
      new Promise<void>((resolve) => { setTimeout(resolve, STREAM_SETTLE_MS) }),
    ])
  }

  private closedError(reason: string): TransportClosedError {
    const parts = [`${this.runtime.description}: ${reason}`]
    if (this.spawnError !== undefined) parts.push(`spawn error: ${this.spawnError.message}`)
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return new TransportClosedError(parts.join('\n'))
  }
}

/** Resolve the new send default without changing explicit priorities or legacy prompts. */
function resolveMessageSend<T extends SendMessageRequest | SendBatchRequest>(request: T): T {
  return { ...request, priority: request.priority ?? (request.messageClass === 'notice' ? 'queue' : 'steer') }
}

/** Construct the transport against a generic process for package-local fake-runtime tests. */
export function createProcessHarnessClient(options: RuntimeProcessOptions): HarnessClient {
  const Constructor = HarnessClient as new (
    publicOptions: HarnessClientOptions,
    runtime: RuntimeProcessOptions,
  ) => HarnessClient
  return new Constructor({}, options)
}

/**
 * Whether `value` is a plain JSON object (the wire-boundary shape probe).
 * @param value - the wire value to probe.
 * @returns `true` iff `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of a thrown value (the transport only throws `Error`s; `String` covers the rest). */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- the transport and dispose ladder reject only with Errors */
  return error instanceof Error ? error.message : String(error)
}
