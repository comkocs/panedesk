/** Local message service: durable sender intents, lease-backed arbitration, and receipt-only subscriptions. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { Context, Service } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { createUserMessage, isAgentLoopRequest, type MessageId } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import MessageDelivery, { type ConfigureMessagesRequest, type ControlResult, type EditMessageRequest,
  type InvalidateMessageRequest, type MessageAddress, type MessageControlRequest, type MessagePage,
  type MessageQuery, type MessageSettings, type MessageStateEvent, type MessageStatus,
  type MessageSubscriptionRequest, type NodeId, type OperationId, type OperationStatus,
  type ReprioritizeMessageRequest, type ResolvedRecipient, type SendBatchRequest, type SendBatchResult,
  type SendMessageRequest, type SendMessageResult, type MessageSender, type DeliveryMessage,
} from '@panedesk/dsh-message-delivery'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { messageEventId, type MessageLedgerStore } from '@panedesk/dsh-session-ledger'
import type {} from '@panedesk/dsh-message-delivery/src/events.ts'
import type {} from '@panedesk/dsh-subprocess'
import type {} from '@panedesk/dsh-session-persistence'
import type {} from '@panedesk/dsh-session-projection'
import type {} from '@panedesk/dsh-session-projection-cache'
import type {} from '@panedesk/dsh-session-title'
import type {} from '@panedesk/dsh-workspace'
import { FileMailbox } from './mailbox.ts'
import { NodeRegistry } from './registry.ts'
import { MailboxArbitrator } from './arbitrator.ts'
import { deliveryDriver } from './driver.ts'
import { decodeCommand, decodeDecision, decodeSendResult, decodeControlResult, decodeReceipt } from './codec.ts'
import { component, MailboxUnavailableError, object, privateDirectory, publish, publishedFiles, readValue } from './files.ts'
import { inspectWindowsAcl } from './windows-permissions.ts'
import { policyReason, resolveRecipients } from './recipients.ts'
import type { Config, ControlCommand, RecipientMetadata } from './types.ts'

export type { Config } from './types.ts'

/** Optional message namespace; providers implement the frozen MessageLedgerStore interface. */
declare module '@panedesk/cordis' {
  interface Context { messageLedger: MessageLedgerStore }
}

/** Concrete provider; missing optional accounting leaves durable receipts authoritative. */
export default class LocalMessageDelivery extends MessageDelivery {
  static inject = ['agents', 'sessions', 'sessionPersistence']
  private readonly mailbox: FileMailbox
  private readonly registry: NodeRegistry
  private readonly owners = new Map<SessionId, { arbitrator: MailboxArbitrator; generation: string; agent: Agent }>()
  private readonly settings = new Map<SessionId, MessageSettings>()
  private readonly requestTurns = new Map<SessionId, number>()
  private readonly lifetime = new AbortController()
  private readonly watchers = new Map<SessionId, FSWatcher>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly emitted = new Set<string>()
  private readonly ready: Promise<void>
  private readonly nodeId: NodeId
  private stopped = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    const limits = [config.maxRecordBytes, config.maxContentBytes, config.maxBatchSize,
      config.scanIntervalMs, config.lockTimeoutMs, config.lockRetryMs]
    for (const value of limits) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new MailboxUnavailableError('Mailbox limits must be positive integers')
    }
    if (config.scanIntervalMs > 1000) throw new MailboxUnavailableError('Mailbox scan interval must not exceed one second')
    this.nodeId = component(config.nodeId) as NodeId
    this.mailbox = new FileMailbox({ ...config, home: resolveDshHome(config.dshHome), nodeId: this.nodeId })
    const subprocess = ctx.get('subprocess')
    this.registry = new NodeRegistry(this.mailbox, subprocess ? pid => subprocess.readProcessIdentity(pid) : undefined)
    this.ready = this.initialize()
    ctx.on('agent/created', async ({ agent }) => {
      await this.ready
      if (!ctx.get('sessionPersistence')) throw new MailboxUnavailableError('Message delivery requires a Session write lease')
      const driver = deliveryDriver(agent)
      if (!driver) throw new MailboxUnavailableError('Agent does not expose priority-aware input scheduling')
      const handle = await ctx.sessionPersistence.open(agent.id, 'read')
      let replay: readonly import('@panedesk/dsh-agent/types').InputTransition[]
      try {
        replay = (await handle.read()).events.flatMap(event => event.type === 'agent/input/transition' ? [event.data] : [])
      } finally {
        await handle.close()
      }
      const generation = await this.registry.register(agent.id, agent.status === 'running' ? 'busy' : 'idle')
      const arbitrator = new MailboxArbitrator(this.mailbox, driver,
        () => this.registry.assertOwner(agent.id, generation), event => this.publishReceipt(event),
        () => this.settingsFor(agent.id).wakeOnHandoff, replay)
      this.owners.set(agent.id, { arbitrator, generation, agent })
      await arbitrator.drain()
      if (config.watch) {
        const root = await this.mailbox.target(agent.id)
        const watcher = watch(join(root, 'records'), () => { this.track(arbitrator.drain()) })
        watcher.on('error', (error) => { ctx.logger.warn('Mailbox watch unavailable; fallback scanning remains active', error) })
        this.watchers.set(agent.id, watcher)
      }
      return undefined
    })
    ctx.on('agent/input-preparing', async ({ agent }) => { await this.owners.get(agent.id)?.arbitrator.drain() })
    ctx.on('agent/request', ({ agent, turn }, next) => {
      this.requestTurns.set(agent.id, turn)
      return next()
    })
    ctx.on('llm/stream', (options, next) => {
      const id = options.sessionId
      const turn = id === undefined ? undefined : this.requestTurns.get(id)
      const owner = id === undefined ? undefined : this.owners.get(id)
      if (isAgentLoopRequest(options) && owner && turn !== undefined) {
        owner.arbitrator.request(turn, options.messages.flatMap(message => message.id === undefined ? [] : [message.id]))
      }
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => { this.track(this.registry.update(agent.id, status === 'running' ? 'busy' : 'idle')) })
    ctx.on('session/event', (session, event) => {
      const owner = this.owners.get(session.id)
      if (event.type === 'message/settings') this.settings.set(session.id, event.data)
      if (!owner) return
      if (event.type === 'agent/input/transition') owner.arbitrator.observe(event.data)
      if (event.type === 'assistant/message' && !event.data.interrupted) owner.arbitrator.assistant(event.data.turn)
      if (event.type === 'turn/end') this.track(owner.arbitrator.finish(event.data.turn, event.data.reason.kind === 'completed'))
    })
    ctx.on('agent/ending', async ({ agent }) => {
      const owner = this.owners.get(agent.id)
      if (!owner) return
      await this.registry.update(agent.id, 'closing')
      this.watchers.get(agent.id)?.close()
      this.watchers.delete(agent.id)
      await owner.arbitrator.close()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.owners.delete(agent.id)
      this.requestTurns.delete(agent.id)
      this.track(this.registry.unregister(agent.id))
    })
    ctx.effect(() => {
      const scanning = this.scanLoop()
      void scanning.catch((error: unknown) => { this.ctx.logger.error('Mailbox scanning failed', error) })
      return async () => {
        this.stopped = true
        this.lifetime.abort()
        for (const watcher of this.watchers.values()) watcher.close()
        this.watchers.clear()
        await scanning
        await Promise.all([...this.tasks])
        for (const owner of this.owners.values()) await owner.arbitrator.close()
        // Host teardown must release the Agent leases before removing their registration.
        if (this.owners.size === 0) await this.registry.dispose()
      }
    })
  }

  protected async [Service.init](): Promise<void> {
    await this.ready
  }

  private async initialize(): Promise<void> {
    await privateDirectory(this.mailbox.options.home)
    if (process.platform === 'win32') await inspectWindowsAcl(this.mailbox.options.home)
    await this.mailbox.initialize()
  }

  private track(work: Promise<void>): void {
    const observed = work.catch((error: unknown) => { this.ctx.logger.error('Message delivery unavailable', error) })
    this.tasks.add(observed)
    void observed.finally(() => this.tasks.delete(observed))
  }

  private async scanLoop(): Promise<void> {
    await this.ready
    while (!this.stopped) {
      try { await wait(this.config.scanIntervalMs, undefined, { signal: this.lifetime.signal }) } catch (error) {
        if (this.lifetime.signal.aborted) break
        throw error
      }
      for (const owner of this.owners.values()) {
        try { await owner.arbitrator.drain() } catch (error) { this.ctx.logger.error('Mailbox scan failed', error) }
      }
      if (this.owners.size > 0) await this.registry.heartbeat()
    }
  }

  private sender(): MessageSender {
    const agent = this.ctx.agents.currentInitiator()
    if (agent && this.ctx.agents.get(agent.id) !== agent) throw new MailboxUnavailableError('Sender Agent is not live')
    return agent ? { kind: 'session', sessionId: agent.id } : { kind: 'human', sessionId: null }
  }

  private settingsFor(id: SessionId): MessageSettings {
    return this.settings.get(id) ?? { receiveMode: 'all', wakeOnHandoff: true }
  }

  private async metadata(): Promise<RecipientMetadata[]> {
    const persistence = this.ctx.get('sessionPersistence')
    const records = persistence ? await persistence.list() : []
    const ids = new Set<SessionId>(records.map(record => record.header.id))
    for (const id of this.owners.keys()) ids.add(id)
    const projections = this.ctx.get('sessionProjections')
    const cache = this.ctx.get('sessionProjectionCache')
    const workspace = this.ctx.get('workspaceRegistry')
    const archived = new Set(workspace?.archivedSessionIds ?? [])
    const output: RecipientMetadata[] = []
    for (const id of ids) {
      const live = this.ctx.sessions.get(id)
      const header = records.find(record => record.header.id === id)?.header
      const snapshot = live ? projections?.snapshot(live) : header ? cache?.cachedSnapshot(header) : undefined
      const window = workspace?.list().find(item => item.sessionIds.includes(id))?.title ?? null
      output.push({ sessionId: id, title: snapshot?.values.title ?? null, window,
        archived: archived.has(id), settings: this.settingsFor(id) })
    }
    return output
  }

  async resolve(addresses: readonly MessageAddress[]): Promise<ResolvedRecipient[]> {
    await this.ready
    return resolveRecipients(this.nodeId, addresses, await this.metadata(), id => this.registry.status(id))
  }

  async send(request: SendMessageRequest): Promise<SendMessageResult> {
    await this.ready
    const sender = this.sender()
    const digest = createHash('sha256').update(JSON.stringify({ sender, request })).digest('hex')
    const key = component(request.operationId)
    return this.mailbox.locked(join(this.mailbox.root, 'operations', `${key}.lock`), async () => {
      const path = join(this.mailbox.root, 'operations', `${key}.json`)
      const previous = await readValue(path, this.config.maxRecordBytes)
      if (previous !== undefined) {
        if (!object(previous) || previous.digest !== digest || !object(previous.result)) throw new MailboxUnavailableError('operation-conflict')
        return decodeSendResult(previous.result)
      }
      const messageId = createUserMessage({ content: [{ type: 'text', text: request.content }], source: { kind: 'user' } }).id
      const [resolution] = await this.resolve([request.target])
      if (!resolution) throw new MailboxUnavailableError('Recipient resolution is unavailable')
      const metadata = resolution.kind === 'resolved' ? (await this.metadata()).find(item => item.sessionId === resolution.recipient.sessionId) : undefined
      const priority = request.priority ?? (request.messageClass === 'notice' ? 'queue' : 'steer')
      const reply = request.messageClass === 'reply' ? await this.findMessage(request.replyTo) : undefined
      const reason = request.messageClass === 'reply' && !reply ? 'invalid-reply'
        : !request.content.trim() || Buffer.byteLength(request.content) > this.config.maxContentBytes ? 'invalid-content'
          : request.messageClass === 'notice' && priority !== 'queue' ? 'invalid-priority'
            : resolution.kind === 'rejected' ? resolution.reason
              : metadata ? policyReason(metadata.settings, request.messageClass) : 'unavailable'
      let result: SendMessageResult
      if (reason || resolution.kind !== 'resolved') {
        result = { messageId, operationId: request.operationId, deliveryOutcome: 'rejected', messageState: 'rejected', pending: false,
          reason: reason === 'target-closed-pending' ? 'unavailable' : reason ?? 'unavailable', candidates: resolution.kind === 'rejected' ? resolution.candidates : [] }
      } else {
        const recipient = resolution.recipient
        result = recipient.status === 'closed'
          ? { messageId, operationId: request.operationId, deliveryOutcome: 'rejected', reason: 'target-closed-pending', messageState: 'queued', pending: true, recipient }
          : { messageId, operationId: request.operationId, deliveryOutcome: 'accepted', messageState: 'queued', pending: false, recipient }
        const message: DeliveryMessage = {
          messageId, sender, senderSessionId: sender.sessionId, target: { nodeId: this.nodeId, sessionId: recipient.sessionId },
          priority, content: request.content, createdAt: Date.now(), revision: 0,
          operationId: request.operationId, mailboxSequence: 0, stateVersion: 0,
          ...(request.messageClass === 'reply' ? { messageClass: 'reply', replyTo: request.replyTo } : { messageClass: request.messageClass }),
        }
        const record = await this.mailbox.append(recipient.sessionId, request.operationId, digest, { kind: 'send', message, result })
        const original = decodeCommand(record.value)
        if (original.kind !== 'send') throw new MailboxUnavailableError('operation-conflict')
        result = original.result
      }
      await publish(path, { digest, result }, this.config.maxRecordBytes)
      if ('recipient' in result) {
        const owner = this.owners.get(result.recipient.sessionId)
        if (owner) this.track(owner.arbitrator.drain())
      }
      return result
    })
  }

  withdraw(request: MessageControlRequest): Promise<ControlResult> { return this.control({ ...request, kind: 'withdraw', sender: this.sender() }) }
  edit(request: EditMessageRequest): Promise<ControlResult> { return this.control({ ...request, kind: 'edit', sender: this.sender() }) }
  reprioritize(request: ReprioritizeMessageRequest): Promise<ControlResult> { return this.control({ ...request, kind: 'reprioritize', sender: this.sender() }) }
  invalidate(request: InvalidateMessageRequest): Promise<ControlResult> { return this.control({ ...request, kind: 'invalidate', sender: this.sender() }) }

  private async findMessage(id: MessageId): Promise<DeliveryMessage | undefined> {
    for (const target of await readdir(join(this.mailbox.root, 'mailboxes'))) {
      const root = await this.mailbox.target(target)
      const decision = await readValue(join(root, 'decisions', `${component(id)}.json`), this.config.maxRecordBytes)
      if (decision !== undefined) return decodeDecision(decision).message
      for (const record of (await this.mailbox.snapshot(target)).records) {
        const command = decodeCommand(record.value)
        if (command.kind === 'send' && command.message.messageId === id) return command.message
      }
    }
    return undefined
  }

  private async control(command: ControlCommand): Promise<ControlResult> {
    await this.ready
    const message = await this.findMessage(command.messageId)
    const rejected = (reason: 'message-not-found' | 'invalid-content' | 'unauthorized'): ControlResult => ({ kind: 'rejected',
      operationId: command.operationId, messageId: command.messageId, reason, status: null })
    if (!message) return rejected('message-not-found')
    if (message.senderSessionId !== command.sender.sessionId || message.sender.kind !== command.sender.kind) return rejected('unauthorized')
    if (command.kind === 'edit' && (!command.content.trim() || Buffer.byteLength(command.content) > this.config.maxContentBytes)) return rejected('invalid-content')
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    await this.mailbox.append(message.target.sessionId, command.operationId, digest, command)
    const owner = this.owners.get(message.target.sessionId)
    if (owner) await owner.arbitrator.drain()
    const result = await this.operationStatus(command.operationId)
    if (result.kind !== 'not-found') return result
    return { kind: 'accepted-pending-owner', operationId: command.operationId, messageId: message.messageId, state: 'queued', revision: message.revision }
  }

  async status(messageId: MessageId): Promise<MessageStatus> {
    await this.ready
    const message = await this.findMessage(messageId)
    if (!message) throw new MailboxUnavailableError('message-not-found')
    const root = await this.mailbox.target(message.target.sessionId)
    const value = await readValue(join(root, 'decisions', `${component(messageId)}.json`), this.config.maxRecordBytes)
    if (value !== undefined) return decodeDecision(value).status
    return { messageId, state: 'queued', phase: 'pending', revision: message.revision, stateVersion: 0, transitions: [] }
  }

  async operationStatus(operationId: OperationId): Promise<OperationStatus> {
    await this.ready
    for (const target of await readdir(join(this.mailbox.root, 'mailboxes'))) {
      const root = await this.mailbox.target(target)
      const result = await readValue(join(root, 'receipts', `operation-${component(operationId)}.json`), this.config.maxRecordBytes)
      if (result !== undefined) return decodeControlResult(result)
      for (const record of (await this.mailbox.snapshot(target)).records) {
        const command = decodeCommand(record.value)
        if (command.kind !== 'send' && command.operationId === operationId) return { kind: 'accepted-pending-owner', operationId,
          messageId: command.messageId, state: 'queued', revision: command.expectedRevision }
      }
    }
    return { kind: 'not-found', operationId }
  }

  async list(query: MessageQuery): Promise<MessagePage> {
    await this.ready
    if (query.nodeId !== undefined && query.nodeId !== this.nodeId) return { items: [], complete: false }
    const ids = new Set<MessageId>()
    for (const target of await readdir(join(this.mailbox.root, 'mailboxes'))) {
      for (const record of (await this.mailbox.snapshot(target)).records) {
        const command = decodeCommand(record.value)
        if (command.kind !== 'send') continue
        const message = command.message
        if (query.sessionId && message.target.sessionId !== query.sessionId && message.senderSessionId !== query.sessionId) continue
        if (query.senderSessionId && message.senderSessionId !== query.senderSessionId) continue
        if (query.targetSessionId && message.target.sessionId !== query.targetSessionId) continue
        if (query.from !== undefined && message.createdAt < query.from) continue
        if (query.to !== undefined && message.createdAt >= query.to) continue
        if (query.messageClasses && !query.messageClasses.includes(message.messageClass)) continue
        if (query.unansweredOlderThanMinutes !== undefined && (message.messageClass === 'notice'
          || Date.now() - message.createdAt < query.unansweredOlderThanMinutes * 60000)) continue
        ids.add(message.messageId)
      }
    }
    const items: MessageStatus[] = []
    for (const id of [...ids].sort()) {
      const status = await this.status(id)
      if (query.states && !query.states.includes(status.state)) continue
      if (query.unansweredOlderThanMinutes !== undefined && (status.transitions.some(event => event.data.transition === 'responded')
        || (!query.includeTerminal && ['withdrawn', 'invalidated', 'rejected'].includes(status.state)))) continue
      items.push(status)
    }
    const limit = query.limit ?? this.config.maxBatchSize
    return { items: items.slice(0, limit), complete: items.length <= limit }
  }

  async sendBatch(request: SendBatchRequest): Promise<SendBatchResult> {
    if (request.recipients.length > this.config.maxBatchSize) throw new MailboxUnavailableError('Recipient list exceeds limit')
    const resolutions = await this.resolve(request.recipients.map(item => item.target))
    const seen = new Set<SessionId>()
    const retained = resolutions.filter((result) => {
      if (result.kind !== 'resolved') return true
      if (seen.has(result.recipient.sessionId)) return false
      seen.add(result.recipient.sessionId)
      return true
    })
    if (request.dryRun) return { kind: 'resolved', recipients: retained }
    const results: SendMessageResult[] = []
    for (const result of retained) {
      const item = request.recipients.find(recipient => recipient.target === result.address)
      if (!item) throw new MailboxUnavailableError('Resolved recipient lost its operation identity')
      results.push(await this.send({ ...request, target: item.target, operationId: item.operationId }))
    }
    return { kind: 'sent', results }
  }

  async configure(request: ConfigureMessagesRequest): Promise<MessageSettings> {
    await this.ready
    const owner = this.owners.get(request.sessionId)
    if (!owner) throw new MailboxUnavailableError('Settings require the Session lease owner')
    const sender = this.sender()
    if (sender.kind === 'session' && sender.sessionId !== request.sessionId) throw new MailboxUnavailableError('unauthorized')
    owner.agent.session.append('message/settings', request.settings)
    await this.ctx.get('sessionPersistence')?.flush()
    this.settings.set(request.sessionId, request.settings)
    return request.settings
  }

  private async publishReceipt(event: MessageStateEvent): Promise<void> {
    const target = event.data.targetSessionId
    if (!target) throw new MailboxUnavailableError('Receipt has no target')
    const root = await this.mailbox.target(target)
    const name = createHash('sha256').update(event.cursor).digest('hex')
    const path = join(root, 'receipts', `${name}.json`)
    if (await readValue(path, this.config.maxRecordBytes) === undefined) await publish(path, event, this.config.maxRecordBytes)
    const ledger = this.ctx.get('messageLedger') ?? await this.ctx.get('sessionLedger')?.messages()
    if (ledger) await ledger.append({ schemaVersion: 1, kind: 'message/state', eventId: messageEventId(event),
      nodeId: this.nodeId, observedAt: event.data.observedAt, data: event.data })
    if (!this.emitted.has(event.cursor)) {
      this.emitted.add(event.cursor)
      this.ctx.emit('message/state', event)
    }
  }

  async *subscribe(request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> {
    await this.ready
    const seen = new Set<string>()
    let after = request.cursor === undefined
    while (!this.stopped) {
      const events: MessageStateEvent[] = []
      for (const target of await readdir(join(this.mailbox.root, 'mailboxes'))) {
        const root = await this.mailbox.target(target)
        for (const name of await publishedFiles(join(root, 'receipts'))) {
          if (name.startsWith('operation-')) continue
          const value = decodeReceipt(await readValue(join(root, 'receipts', name), this.config.maxRecordBytes))
          if (value.data.senderSessionId === request.sessionId || value.data.targetSessionId === request.sessionId) events.push(value)
        }
      }
      events.sort((left, right) => left.data.observedAt - right.data.observedAt || left.cursor.localeCompare(right.cursor))
      for (const event of events) {
        if (!after) { if (event.cursor === request.cursor) after = true; seen.add(event.cursor); continue }
        if (seen.has(event.cursor)) continue
        seen.add(event.cursor)
        yield event
      }
      try { await wait(this.config.scanIntervalMs, undefined, { signal: this.lifetime.signal }) } catch (error) {
        if (!this.lifetime.signal.aborted) throw error
      }
    }
  }
}
