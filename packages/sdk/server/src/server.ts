/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @panedesk/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@panedesk/cordis'
import { executionPolicyDigest, validateHandshake } from './handshake.ts'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brandString } from '@panedesk/dsh-brand'
import type { Agent, AgentHandle, AgentSetup } from '@panedesk/dsh-agent'
import type { AgentPreset } from '@panedesk/dsh-agent-preset-registry'
import type { LedgerSessionContext, LedgerRunId, LedgerNodeId, LedgerEventId } from '@panedesk/dsh-session-ledger'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@panedesk/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@panedesk/dsh-llm'
import { carrierKeyOf, type Scoped } from '@panedesk/dsh-scope'
import type { SessionId, SessionLogOffset } from '@panedesk/dsh-session'
import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-tools'
import type SubagentRuntime from '@panedesk/dsh-subagent'
import type { SubagentRunEndInfo } from '@panedesk/dsh-subagent'
import * as LlmDeepSeek from '@panedesk/dsh-llm-deepseek-api-key'
import { decodeMessagesRequest, isMessagesMethod, JsonRpcResponseError, MESSAGES_VERSION } from '@panedesk/dsh-sdk-protocol'
import type {
  MessageStateEvent, MessageSubscriptionRequest, MessagesRequestMap,
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@panedesk/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  /** Latest live failure not superseded by a subsequently committed terminal. */
  failure: { readonly error: unknown; readonly atOffset: SessionLogOffset } | undefined
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private messagesEnabled = false
  private readonly messageStreams = new Map<string, { stop: () => Promise<void> }>()
  private initialized = false
  private initializing = false
  private handshake: Pick<InitializeParams, 'agentPreset' | 'executionPolicy' | 'ledgerContext' | 'cachePolicy'> = {}

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const record = this.sessions.get(session.id)
      if (event.type === 'turn/end' && record?.handle.agent.session === session
        && record.failure !== undefined && event.seq >= record.failure.atOffset) {
        record.failure = undefined
      }
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const record = this.sessions.get(agent.session.id)
      if (record?.handle.agent !== agent) return
      record.failure = { error, atOffset: agent.session.seq }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.initialized || this.initializing || this.shuttingDown) throw new Error('SDK server cannot reinitialize')
    validateHandshake(params)
    this.initializing = true
    try {
      return await this.initializeOnce(structuredClone(params))
    } finally {
      this.initializing = false
    }
  }

  private async initializeOnce(params: InitializeParams): Promise<InitializeResult> {
    await this.resolvePreset(params)
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.handshake = params
    this.initialized = true
    this.messagesEnabled = params.messagesVersion === MESSAGES_VERSION && this.ctx.get('messageDelivery') !== undefined
    return { serverInfo: { name: 'panedesk-sdk-runtime', version: '0.0.1' },
      ...this.messagesEnabled ? { messagesVersion: MESSAGES_VERSION } : {} }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user' },
    })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Restore a persisted session and repair its interrupted final turn without sending input.
   * Uses the initialized model route while preserving the stored session identity and directory.
   * Rejects missing, unreadable, or already owned sessions; never creates a replacement.
   * @param params - persisted session identity in the configured persistence store.
   * @returns an empty result after the Agent is ready for prompts.
   */
  async resume(params: SessionResumeParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const sessionId = params.sessionId
    if (this.sessions.has(sessionId) || this.sessionCreations.has(sessionId)) {
      throw new Error(`SDK session is already open or opening: ${sessionId}`)
    }
    await this.openSession(sessionId, true)
    return {}
  }

  /**
   * Wait for an existing owned Agent and its managed descendants to finish.
   * The response follows all Session notifications emitted during the wait.
   * Rejects a live Agent failure that has no subsequent durable terminal.
   * @param params - the SDK-owned session to observe without creating one.
   * @returns an empty result after the root stays idle across the descendant check.
   */
  async wait(params: SessionWaitParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error(`unknown SDK session: ${params.sessionId}`)
    const agent = rec.handle.agent
    const subagents = this.ctx.get('subagents')
    while (true) {
      this.assertLiveAgent(rec, params.sessionId)
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const children = await subagents?.waitForChildren(agent)
      this.assertLiveAgent(rec, params.sessionId)
      if (!children && agent.status === 'idle' && agent.session.seq === idleSeq) {
        if (rec.failure !== undefined) throw rec.failure.error
        return {}
      }
    }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Read a Session's effective directory, recovering a missing directory to its origin.
   * @param params - target Session; an unknown id creates it.
   * @returns the absolute effective directory.
   */
  async getWorkingDirectory(params: SessionWorkingDirectoryParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.ensure(agent) }
  }

  /**
   * Change a Session's directory and queue its model-visible transition.
   * @param params - target Session and absolute or current-directory-relative path.
   * @returns the validated absolute directory; origin and permissions are unchanged.
   */
  async setWorkingDirectory(params: SessionWorkingDirectorySetParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.set(agent, params.path) }
  }

  private async workingDirectoryAgent(sessionId: string): Promise<Agent> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(sessionId)
    this.assertLiveAgent(rec, sessionId)
    return rec.handle.agent
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * Managed descendants drain before the root Agent handles and adapter are released.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    const streams = await Promise.allSettled([...this.messageStreams.values()].map(stream => stream.stop()))
    for (const result of streams) if (result.status === 'rejected') failures.push(result.reason)
    this.messageStreams.clear()
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.ctx.get('subagents')?.drainDescendants(records.map(rec => rec.handle.agent))
    } catch (error: unknown) {
      failures.push(error)
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (isMessagesMethod(method)) return this.messageRequest(method, params)
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/resume': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new TypeError('session/resume requires a non-empty sessionId string')
        }
        return this.resume({ sessionId })
      }
      case 'session/wait': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string') throw new TypeError('session/wait requires a sessionId string')
        return this.wait({ sessionId })
      }
      case 'session/working-directory/get':
      case 'session/working-directory/set': {
        if (typeof params?.sessionId !== 'string' || params.sessionId.length === 0) {
          throw new TypeError('working-directory requests require a non-empty sessionId')
        }
        if (method === 'session/working-directory/get') {
          return this.getWorkingDirectory({ sessionId: params.sessionId })
        }
        if (typeof params.path !== 'string') throw new TypeError('working-directory set requires a path string')
        return this.setWorkingDirectory({ sessionId: params.sessionId, path: params.path })
      }
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown Panedesk SDK runtime method: ${method}`)
    }
  }

  private async messageRequest(method: keyof MessagesRequestMap, params: unknown): Promise<unknown> {
    const delivery = this.ctx.get('messageDelivery')
    if (!this.initialized || this.shuttingDown || !this.messagesEnabled || delivery === undefined) {
      throw new JsonRpcResponseError(-32601, 'Message delivery is unsupported on this connection', { reason: 'unsupported' })
    }
    const linkedId = this.handshake.ledgerContext?.childSessionId
    const initiator = linkedId === undefined ? this.ctx.agents.currentInitiator() : this.sessions.get(linkedId)?.handle.agent
    if (linkedId !== undefined && initiator === undefined) {
      throw new JsonRpcResponseError(-32603, 'The bound SDK session is not open', { reason: 'unauthorized' })
    }
    if (initiator !== undefined) this.authorizeMessageSession(initiator.session.id)
    const invoke = async (): Promise<unknown> => {
      switch (method) {
        case 'messages/send': return delivery.send(decodeMessagesRequest(method, params))
        case 'messages/withdraw': return delivery.withdraw(decodeMessagesRequest(method, params))
        case 'messages/edit': return delivery.edit(decodeMessagesRequest(method, params))
        case 'messages/reprioritize': return delivery.reprioritize(decodeMessagesRequest(method, params))
        case 'messages/invalidate': return delivery.invalidate(decodeMessagesRequest(method, params))
        case 'messages/status': return delivery.status(decodeMessagesRequest(method, params).messageId)
        case 'messages/operationStatus': return delivery.operationStatus(decodeMessagesRequest(method, params).operationId)
        case 'messages/list': return delivery.list(decodeMessagesRequest(method, params))
        case 'messages/resolve': return delivery.resolve(decodeMessagesRequest(method, params).addresses)
        case 'messages/sendBatch': return delivery.sendBatch(decodeMessagesRequest(method, params))
        case 'messages/configure': {
          const request = decodeMessagesRequest(method, params)
          this.authorizeMessageSession(request.sessionId)
          return delivery.configure(request)
        }
        case 'messages/subscribe': {
          const request = decodeMessagesRequest(method, params)
          this.authorizeMessageSession(request.sessionId)
          await this.messageStreams.get(request.sessionId)?.stop()
          if (this.shuttingDown) throw new Error('SDK server is shutting down')
          return this.watchMessages(request, delivery.subscribe(request))
        }
      }
    }
    return initiator === undefined ? this.ctx.agents.withoutInitiator(invoke) : this.ctx.agents.withInitiator(initiator, invoke)
  }

  private authorizeMessageSession(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    const linkedId = this.handshake.ledgerContext?.childSessionId
    if (record === undefined || (linkedId !== undefined && sessionId !== linkedId)) {
      throw new JsonRpcResponseError(-32603, 'Message operation requires an owned SDK session', { reason: 'unauthorized' })
    }
    this.assertLiveAgent(record, sessionId)
  }

  private watchMessages(request: MessageSubscriptionRequest, events: AsyncIterable<MessageStateEvent>): object {
    const iterator = events[Symbol.asyncIterator]()
    let stopped = false
    const isStopped = (): boolean => stopped
    let stopping: Promise<void> | undefined
    const stream = {
      stop: (): Promise<void> => stopping ??= (async () => {
        stopped = true
        await iterator.return?.()
      })(),
    }
    this.messageStreams.set(request.sessionId, stream)
    const pump = async (): Promise<void> => {
      try {
        while (!isStopped()) {
          const item = await iterator.next()
          if (item.done || isStopped()) break
          this.transport.notify('messages.state', item.value)
        }
      } catch (error) {
        // Receipt storage errors are observable without leaking provider diagnostics to the wire.
        if (!isStopped()) {
          this.ctx.logger.warn('Message receipt subscription failed', error)
          this.transport.notify('messages.error', { sessionId: request.sessionId, reason: 'unavailable' })
        }
      } finally {
        await stream.stop()
        if (this.messageStreams.get(request.sessionId) === stream) this.messageStreams.delete(request.sessionId)
      }
    }
    void pump().catch((error: unknown) => { this.ctx.logger.warn('Message receipt cleanup failed', error) })
    return request.cursor === undefined ? {} : { cursor: request.cursor }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    return this.openSession(sessionId, false)
  }

  private openSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    const creation = this.createSession(sessionId, resume)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    const linkage = this.handshake.ledgerContext
    if (linkage !== undefined && sessionId !== linkage.childSessionId) {
      throw new Error('SDK session does not match the reserved child identity')
    }
    const preset = this.handshake.agentPreset === undefined ? undefined : await this.resolvePreset({
      ...this.handshake, cwd: this.cwd, provider: this.provider, model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
    })
    const setup: AgentSetup = async (agentCtx, agent) => {
      if (preset !== undefined) {
        const mounted = await agentCtx.get('agentPresets')?.mount(agentCtx, preset.id)
        if (mounted === undefined || mounted.id !== preset.id
          || (preset.executionPolicy !== undefined && (mounted.executionPolicy === undefined
            || executionPolicyDigest(mounted.executionPolicy) !== preset.executionPolicyDigest))) {
          throw new Error('Mounted SDK preset does not match the validated execution policy')
        }
      }
      const ledger = agentCtx.get('sessionLedger')
      if (linkage !== undefined && ledger !== undefined) {
        const context: LedgerSessionContext = {
          seat: linkage.seat, window: linkage.window,
          ...linkage.taskId === undefined ? {} : { taskId: linkage.taskId },
          nodeId: brandString<LedgerNodeId>(linkage.nodeId), identitySource: linkage.identitySource,
          sessionId: agent.session.id,
          parentSessionId: brandString<SessionId>(linkage.parentSessionId),
          rootSessionId: brandString<SessionId>(linkage.rootSessionId),
          subagentRunId: brandString<NonNullable<LedgerSessionContext['subagentRunId']>>(linkage.subagentRunId),
          remoteSessionId: agent.session.id,
          accountLabel: linkage.accountLabel ?? 'unknown',
          runId: brandString<LedgerRunId>(linkage.subagentRunId),
          parentRunId: brandString<LedgerRunId>(linkage.parentRunId),
        }
        agentCtx.effect(() => ledger.bindContext(context), 'sdk.ledger-context')
      }
      const policy = preset?.executionPolicy
      const deniedWrites = new Set<Promise<void>>()
      let deniedFailure: unknown
      const deny = (operation: 'model' | 'effort' | 'tool', requested: string): string => {
        const reason = 'Denied by the installed execution policy'
        if (ledger !== undefined && policy !== undefined) {
          const write = (async () => {
            const attribution = await ledger.resolveCallContext({ sessionId: agent.id, provider: policy.provider, model: policy.model })
            const result = await ledger.appendEvent({ schemaVersion: 1, eventId: brandString<LedgerEventId>(randomUUID()),
              nodeId: attribution.context.nodeId, observedAt: Date.now(), runId: attribution.runId, sessionId: agent.id,
              kind: 'policy/denied', operation, requested, definition: `${policy.rulesId}@${policy.version}`, reason })
            if (result.kind === 'conflict') throw new Error('SDK policy denial ledger conflict')
          })()
          deniedWrites.add(write)
          void write.catch((error: unknown) => { deniedFailure = error }).finally(() => deniedWrites.delete(write))
        }
        return reason
      }
      const flushDenied = async (): Promise<void> => {
        await Promise.allSettled([...deniedWrites])
        if (deniedFailure !== undefined) throw new Error('SDK policy denial accounting failed', { cause: deniedFailure })
      }
      if (policy !== undefined) {
        agentCtx.on('tools/post-execute', async (_exec, _result, next) => { await flushDenied(); return next() })
        agentCtx.on('agent/ending', flushDenied)
        const tools = agentCtx.get('tools')
        if (tools === undefined) throw new Error('SDK execution policy requires the tools service')
        tools.restrict({ allow: [...policy.allowedTools] })
        tools.guard(exec => exec.name === 'run_code' || policy.allowedTools.includes(exec.name)
          ? undefined : deny('tool', exec.name))
      }
      if (policy !== undefined || this.handshake.cachePolicy !== undefined) {
        agentCtx.on('agent/request', async (_payload, next) => {
          const config = await next()
          if (policy !== undefined && (config.provider !== policy.provider || config.model !== policy.model
            || config.reasoningEffort !== policy.reasoningEffort)) {
            const reason = config.provider !== policy.provider || config.model !== policy.model
              ? deny('model', `${config.provider}/${config.model}`) : deny('effort', config.reasoningEffort ?? 'unspecified')
            await flushDenied()
            throw new Error(reason)
          }
          return this.handshake.cachePolicy === undefined ? config : { ...config, cache: this.handshake.cachePolicy }
        })
      }
    }
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    const handle = await (resume ? this.ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(sessionId),
      agentOptions,
      setup,
    }) : this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd: this.cwd, ...preset === undefined ? {} : { agentPreset: preset.id } },
      agentOptions,
      setup,
    }))
    const rec: SessionRecord = { handle, failure: undefined }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private async resolvePreset(params: InitializeParams): Promise<AgentPreset | undefined> {
    if (params.agentPreset === undefined) return undefined
    const registry = this.ctx.get('agentPresets')
    if (registry === undefined) throw new Error('SDK preset requires the agent-presets service')
    const preset = await registry.resolve(params.agentPreset)
    if (preset.broken !== undefined) throw new Error('SDK preset is unavailable')
    const expected = params.executionPolicy
    const policy = preset.executionPolicy
    if (expected === undefined && policy === undefined) return preset
    if (expected === undefined || policy === undefined || preset.executionPolicyDigest !== expected.digest
      || executionPolicyDigest(policy) !== expected.digest
      || policy.version !== expected.version || preset.id !== expected.presetId) {
      throw new Error('SDK execution policy version or digest mismatch')
    }
    if (params.provider !== policy.provider || params.model !== policy.model
      || params.reasoningEffort !== policy.reasoningEffort) {
      throw new Error('SDK route does not match the installed execution policy')
    }
    return structuredClone(preset)
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
