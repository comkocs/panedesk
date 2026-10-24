/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 *
 * @module @panedesk/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { SeatsClient } from './seats.ts'
import { HostClient } from './host.ts'
import { resolve } from 'node:path'
import { SessionId, type SessionEvent, type TurnEndReason } from '@panedesk/dsh-session'
import { createProcessHarnessClient, HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { InitializeParams, MessagesRequestMap, SendMessageRequest, MessageStateEvent, MessageSubscriptionRequest } from '@panedesk/dsh-sdk-protocol'

/** Session sends preserve reply classification while defaulting only the target address. */
export type SessionSendMessageRequest = SendMessageRequest extends infer R
  ? R extends SendMessageRequest ? Omit<R, 'target'> & { target?: R['target'] } : never : never
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  /** Seat operations share the existing runtime and never fall back to prompt. */
  readonly seats = new SeatsClient(async (method, params) => { await this.start(); return this.client.request(method, params) })
  /** Host evidence shares the existing initialized runtime. */
  readonly host = new HostClient(async (method, params) => { await this.start(); return this.client.request(method, params) })
  /** Message operations initialize the owning runtime before use. */
  readonly messages = {
    send: async (request: SendMessageRequest) => { await this.start(); return this.client.messages.send(request) },
    withdraw: async (request: MessagesRequestMap['messages/withdraw']['params']) => { await this.start(); return this.client.messages.withdraw(request) },
    edit: async (request: MessagesRequestMap['messages/edit']['params']) => { await this.start(); return this.client.messages.edit(request) },
    reprioritize: async (request: MessagesRequestMap['messages/reprioritize']['params']) => { await this.start(); return this.client.messages.reprioritize(request) },
    invalidate: async (request: MessagesRequestMap['messages/invalidate']['params']) => { await this.start(); return this.client.messages.invalidate(request) },
    status: async (id: MessagesRequestMap['messages/status']['params']['messageId']) => { await this.start(); return this.client.messages.status(id) },
    operationStatus: async (id: MessagesRequestMap['messages/operationStatus']['params']['operationId']) => { await this.start(); return this.client.messages.operationStatus(id) },
    list: async (query: MessagesRequestMap['messages/list']['params']) => { await this.start(); return this.client.messages.list(query) },
    resolve: async (addresses: MessagesRequestMap['messages/resolve']['params']['addresses']) => { await this.start(); return this.client.messages.resolve(addresses) },
    sendBatch: async (request: MessagesRequestMap['messages/sendBatch']['params']) => { await this.start(); return this.client.messages.sendBatch(request) },
    configure: async (request: MessagesRequestMap['messages/configure']['params']) => { await this.start(); return this.client.messages.configure(request) },
    subscribe: (request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> => this.messageEvents(request),
  }

  private async * messageEvents(request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> {
    await this.start()
    yield * this.client.messages.subscribe(request)
  }

  private clientInstance: HarnessClient
  private readonly createClient: () => HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly reasoningEffort: DeepSeekHarnessOptions['reasoningEffort']
  private readonly maxTokens: number | undefined
  private readonly handshake: Pick<InitializeParams, 'agentPreset' | 'executionPolicy' | 'ledgerContext' | 'cachePolicy'>
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - dsh launch configuration plus the session route, effort, and output cap. */
  constructor(options?: DeepSeekHarnessOptions)
  constructor(options: DeepSeekHarnessOptions = {}, clientFactory?: () => HarnessClient) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options))
    this.clientInstance = this.createClient()
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.reasoningEffort = options.reasoningEffort
    this.maxTokens = options.maxTokens
    this.handshake = structuredClone({
      ...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
      ...options.executionPolicy === undefined ? {} : { executionPolicy: options.executionPolicy },
      ...options.ledgerContext === undefined ? {} : { ledgerContext: options.ledgerContext },
      ...options.cachePolicy === undefined ? {} : { cachePolicy: options.cachePolicy },
    })
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake swaps in a fresh instance only after cleanup proves the runtime
   * exited; cleanup failure retains this client, so do not cache it across a
   * failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure, successful SDK-owned cleanup reaps the runtime and installs a
   * fresh client (`HarnessClient.close` is permanent), so a later call retries
   * with a new subprocess unless {@link close} already ended this harness. If
   * cleanup also fails, rejects with an `AggregateError` whose ordered errors
   * preserve both causes and retains the failed client rather than spawning
   * alongside a process whose exit was not proved.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          ...this.handshake,
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
      } catch (error) {
        this.initialized = undefined
        try {
          await this.clientInstance.close()
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'DeepSeek Harness initialization and cleanup failed',
          )
        }
        if (!this.closed) this.clientInstance = this.createClient()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt or working-directory operation).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Start the runtime and restore a persisted session without sending input.
   * The configured Harness home must contain its history; missing or occupied sessions reject.
   * @param sessionId - exact persisted identity to continue.
   * @returns a handle ready to run new prompts on the restored history.
   */
  async resumeSession(sessionId: string): Promise<HarnessSession> {
    await this.start()
    await this.client.resumeSession(sessionId)
    return new HarnessSession(this, sessionId)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  const Constructor = DeepSeekHarness as new (
    publicOptions: DeepSeekHarnessOptions,
    clientFactory: () => HarnessClient,
  ) => DeepSeekHarness
  return new Constructor({
    ...runtime.cwd === undefined ? {} : { processCwd: runtime.cwd },
    ...options,
  }, () => createProcessHarnessClient(runtime, options))
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  /** Session-local defaults never turn the target into a trusted sender identity. */
  readonly messages = {
    send: (request: SessionSendMessageRequest) => this.harness.messages.send({
      ...request, target: request.target ?? { sessionId: SessionId(this.id) },
    }),
    withdraw: (request: MessagesRequestMap['messages/withdraw']['params']) => this.harness.messages.withdraw(request),
    edit: (request: MessagesRequestMap['messages/edit']['params']) => this.harness.messages.edit(request),
    reprioritize: (request: MessagesRequestMap['messages/reprioritize']['params']) => this.harness.messages.reprioritize(request),
    invalidate: (request: MessagesRequestMap['messages/invalidate']['params']) => this.harness.messages.invalidate(request),
    status: (id: MessagesRequestMap['messages/status']['params']['messageId']) => this.harness.messages.status(id),
    operationStatus: (id: MessagesRequestMap['messages/operationStatus']['params']['operationId']) => this.harness.messages.operationStatus(id),
    list: (query: MessagesRequestMap['messages/list']['params'] = {}) => this.harness.messages.list({ ...query, sessionId: query.sessionId ?? SessionId(this.id) }),
    resolve: (addresses: MessagesRequestMap['messages/resolve']['params']['addresses']) => this.harness.messages.resolve(addresses),
    sendBatch: (request: MessagesRequestMap['messages/sendBatch']['params']) => this.harness.messages.sendBatch(request),
    configure: (request: Omit<MessagesRequestMap['messages/configure']['params'], 'sessionId'> & { sessionId?: SessionId }) =>
      this.harness.messages.configure({ ...request, sessionId: request.sessionId ?? SessionId(this.id) }),
    subscribe: (request: Omit<MessageSubscriptionRequest, 'sessionId'> & { sessionId?: SessionId } = {}) =>
      this.harness.messages.subscribe({ ...request, sessionId: request.sessionId ?? SessionId(this.id) }),
  }
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Read the effective directory and recover a missing directory to the Session origin.
   * @returns the absolute directory used by new independent operations.
   */
  async getWorkingDirectory(): Promise<string> {
    await this.harness.start()
    return this.harness.client.getWorkingDirectory(this.id)
  }

  /**
   * Change the effective directory without moving existing processes or changing permissions.
   * @param path - absolute or Session-current-directory-relative directory.
   * @returns the validated absolute directory.
   */
  async setWorkingDirectory(path: string): Promise<string> {
    await this.harness.start()
    return this.harness.client.setWorkingDirectory(this.id, path)
  }

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the provider-read fields of one wire turn-end reason. */
function validatedTurnEndReason(value: unknown): TurnEndReason {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind === 'aborted') {
    if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
      throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
    }
    switch (value.reason.kind) {
      case 'user':
      case 'parent':
      case 'disposed':
      case 'legacy':
      case 'interjection':
        break
      case 'hook':
        if (typeof value.reason.reason !== 'string') {
          throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
        }
        break
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
    }
  }
  return value as TurnEndReason
}

/**
 * Validate the event envelope and assistant/turn fields consumed by SDK readers.
 * @param value - the raw `session.event` event payload.
 * @returns the event, or throws a protocol error for malformed consumed fields.
 */
export function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const data = isRecord(value.data) ? value.data : undefined
    if (data === undefined) {
      throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`)
    }
    validatedTurnEndReason(data.reason)
  }
  return value as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
