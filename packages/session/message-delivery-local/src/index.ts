/** Local message service: durable sender intents, lease-backed arbitration, and receipt-only subscriptions. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { Context, FiberState, Service } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import { createUserMessage, isAgentLoopRequest, type MessageId } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import MessageDelivery, { type ConfigureMessagesRequest, type ControlResult, type EditMessageRequest,
  type InvalidateMessageRequest, type MessageAddress, type MessageControlRequest, type MessagePage,
  type MessageQuery, type MessageCursor, type MessageSettings, type MessageStateEvent, type MessageStatus,
  type MessageSubscriptionRequest, type NodeId, type OperationId, type OperationStatus,
  type ReprioritizeMessageRequest, type ResolvedRecipient, type SendBatchRequest, type SendBatchResult,
  type SendMessageRequest, type SendMessageResult, type MessageSender, type DeliveryMessage,
} from '@panedesk/dsh-message-delivery'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { messageEventId, type MessageLedgerStore } from '@panedesk/dsh-session-ledger'
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
import { decodeCommand, decodeDecision, decodeSendResult, decodeControlResult } from './codec.ts'
import { component, MailboxUnavailableError, object, privateDirectory, publish, readValue } from './files.ts'
import { RecipientPolicy } from './policy.ts'
import { broadcast } from './broadcast.ts'
import { ReceiptStore } from './receipts.ts'
import { createRoutedMailboxReceiver } from './routed-receiver.ts'
import { createSeatMessageReceiver } from './seat-receiver.ts'
import { observeRemoteSeats } from './seat-observations.ts'
import { sendRoutedMessage, recoverRoutedMessages, type RoutedRecoveryScan } from './routed-sender.ts'
import { inspectWindowsAcl } from './windows-permissions.ts'
import { policyReason, resolveRecipients, resolveSeatRecipient } from './recipients.ts'
import type {} from '@panedesk/dsh-seat'
import type { Config, ControlCommand, RecipientMetadata } from './types.ts'

export type { Config } from './types.ts'

/** Optional message namespace; providers implement the frozen MessageLedgerStore interface. */
declare module '@panedesk/cordis' {
  interface Context {
    messageLedger: MessageLedgerStore
    messageDeliveryUnavailable: { code: 'home-permissions'; path: string }
  }
}

/** Concrete provider; missing optional accounting leaves durable receipts authoritative. */
export default class LocalMessageDelivery extends MessageDelivery {
  static inject = ['agents', 'sessions', 'sessionPersistence']
  private mailbox!: FileMailbox
  private registry!: NodeRegistry
  private readonly owners = new Map<SessionId, {
    arbitrator: MailboxArbitrator
    generation: string
    agent: Agent
    closing: boolean
    released: ReturnType<typeof Promise.withResolvers<void>>
  }>()
  private policy!: RecipientPolicy
  private receipts!: ReceiptStore
  private readonly requestTurns = new Map<SessionId, number>()
  private readonly lifetime = new AbortController()
  private readonly watchers = new Map<SessionId, FSWatcher>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly registrations = new Map<SessionId, Promise<void>>()
  private readonly emitted = new Set<string>()
  private readonly ready: Promise<void> | undefined
  private nodeId!: NodeId
  private stopped = false
  private readonly recoveryScan: RoutedRecoveryScan

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.recoveryScan = { maxEntries: config.maxBatchSize }
    const limits = [config.maxRecordBytes, config.maxContentBytes, config.maxBatchSize,
      config.scanIntervalMs, config.lockTimeoutMs, config.lockRetryMs]
    for (const value of limits) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new MailboxUnavailableError('Mailbox limits must be positive integers')
    }
    if (config.scanIntervalMs > 1000) throw new MailboxUnavailableError('Mailbox scan interval must not exceed one second')
    // A virtual filesystem without local ownership cannot host a private mailbox.
    if (typeof lstat !== 'function' || typeof readdir !== 'function' || typeof homedir !== 'function'
      || (process.platform !== 'win32' && (typeof process.getuid !== 'function' || typeof process.getgid !== 'function'))) {
      ctx.set('messageDelivery', undefined)
      return
    }
    this.ready = this.initialize()
  }

  private canAdopt(agent: Agent): boolean {
    return !this.stopped && this.ctx.agents.lifecycle(agent) === 'live'
  }

  private registerAgent(agent: Agent): Promise<void> {
    const pending = this.registrations.get(agent.id)
    if (pending) return pending.then(() => this.registerAgent(agent))
    if (this.stopped || this.ctx.agents.lifecycle(agent) !== 'live' || this.owners.get(agent.id)?.agent === agent) return Promise.resolve()
    const work = this.adopt(agent).finally(() => {
      if (this.registrations.get(agent.id) === work) this.registrations.delete(agent.id)
    })
    this.registrations.set(agent.id, work)
    return work
  }

  private async adopt(agent: Agent): Promise<void> {
    const ctx = this.ctx
    const previous = this.owners.get(agent.id)
    if (previous) await previous.released.promise
    if (!this.canAdopt(agent)) return
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
    if (!this.canAdopt(agent)) return
    const generation = await this.registry.register(agent.id, agent.status === 'running' ? 'busy' : 'idle')
    if (ctx.agents.lifecycle(agent) === 'missing') {
      await this.registry.unregister(agent.id)
      return
    }
    const arbitrator = new MailboxArbitrator(this.mailbox, driver,
      async () => {
        if (ctx.agents.lifecycle(agent) === 'missing') throw new MailboxUnavailableError('Session residency has been replaced')
        await this.registry.assertOwner(agent.id, generation)
      }, event => this.publishReceipt(event),
      () => this.settingsFor(agent.id).wakeOnHandoff, replay,
      message => policyReason(this.settingsFor(agent.id), message.messageClass))
    const closing = !this.canAdopt(agent)
    this.owners.set(agent.id, { arbitrator, generation, agent, closing, released: Promise.withResolvers<void>() })
    if (closing) {
      await this.registry.update(agent.id, 'closing')
      await arbitrator.close()
      return
    }
    await arbitrator.drain()
    if (this.config.watch && this.canAdopt(agent)) {
      const root = await this.mailbox.target(agent.id)
      if (!this.canAdopt(agent)) return
      const watcher = watch(join(root, 'records'), () => {
        arbitrator.changed()
        this.track(arbitrator.drain())
      })
      watcher.on('error', (error) => { ctx.logger.warn('Mailbox watch unavailable; fallback scanning remains active', error) })
      this.watchers.set(agent.id, watcher)
    }
  }

  private async activate(): Promise<void> {
    const ctx = this.ctx
    ctx.on('agent/created', async ({ agent }) => {
      await this.registerAgent(agent)
      return undefined
    })
    ctx.on('agent/input-preparing', ({ agent }) => {
      const owner = this.owners.get(agent.id)
      if (owner?.agent === agent && !owner.closing) return owner.arbitrator.prepare()
    })
    ctx.on('agent/request', ({ agent, turn }, next) => {
      const owner = this.owners.get(agent.id)
      if (owner?.agent === agent && !owner.closing) this.requestTurns.set(agent.id, turn)
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
    ctx.on('agent/status', ({ agent, status }) => {
      const owner = this.owners.get(agent.id)
      // A closing residency stays closed: a trailing idle status must not republish it as live.
      if (!owner || owner.agent !== agent || owner.closing) return
      this.track(this.registry.update(agent.id, status === 'running' ? 'busy' : 'idle'))
    })
    ctx.on('session/event', (session, event) => {
      const owner = this.owners.get(session.id)
      if (!owner || owner.agent.session !== session) return
      if (event.type === 'agent/input/transition') owner.arbitrator.observe(event.data)
      if (event.type === 'assistant/message' && !event.data.interrupted) owner.arbitrator.assistant(event.data.turn)
      if (event.type === 'turn/end') this.track(owner.arbitrator.finish(event.data.turn, event.data.reason.kind === 'completed'))
    })
    const stopEnding = ctx.on('agent/ending', async ({ agent }) => {
      await this.registrations.get(agent.id)
      const owner = this.owners.get(agent.id)
      if (!owner || owner.agent !== agent || owner.closing) return
      owner.closing = true
      await this.registry.update(agent.id, 'closing')
      this.watchers.get(agent.id)?.close()
      this.watchers.delete(agent.id)
      await owner.arbitrator.close()
    })
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const owner = this.owners.get(agent.id)
      if (!owner || owner.agent !== agent) return
      this.owners.delete(agent.id)
      this.requestTurns.delete(agent.id)
      this.track(this.registry.unregister(agent.id).finally(() => { owner.released.resolve() }))
    })
    const scanning = this.scanLoop()
    void scanning.catch((error: unknown) => { this.ctx.logger.error('Mailbox scanning failed', error) })
    ctx.effect(function* (this: LocalMessageDelivery) {
      // Retain lease-release notifications until registry cleanup has settled.
      yield stopEnding
      yield stopDisposed
      yield async () => {
        this.stopped = true
        this.lifetime.abort()
        for (const watcher of this.watchers.values()) watcher.close()
        this.watchers.clear()
        await scanning
        await this.recoveryScan.directory?.close()
        this.recoveryScan.directory = undefined
        await Promise.all([...this.registrations.values()])
        await Promise.all([...this.tasks])
        const owners = [...this.owners.entries()]
        for (const [sessionId, owner] of owners) {
          owner.closing = true
          await this.registry.update(sessionId, 'closing')
          await owner.arbitrator.close()
        }
        // Root teardown owns the Agent disposers; plugin-only unload must not
        // wait for still-live Agents or claim that their leases were released.
        if (ctx.root.fiber.state === FiberState.UNLOADING || ctx.root.fiber.state === FiberState.DISPOSED) {
          await Promise.all(owners.map(([, owner]) => owner.released.promise))
        }
        await Promise.all([...this.tasks])
        if (this.owners.size === 0) await this.registry.dispose()
      }
    }.bind(this))
    await Promise.all(ctx.agents.list().map(agent => this.registerAgent(agent)))
  }

  protected async [Service.init](): Promise<void> {
    if (!this.ready) return
    try { await this.ready } catch (error) {
      this.ctx.logger.error('Message delivery unavailable: initialization failed', error)
      this.ctx.set('messageDelivery', undefined)
      return
    }
    this.policy = new RecipientPolicy(this.ctx)
    this.ctx.effect(() => this.ctx.provide('routedMessageReceiver', createRoutedMailboxReceiver({ mailbox: this.mailbox,
      maxContentBytes: this.config.maxContentBytes,
      authorize: async (authority, request) => await this.ctx.get('routedDeliveryVerifier')?.verify(authority, request.delivery) ?? false,
      resolve: async (request) => {
        const [resolution] = await this.resolve([request.target])
        if (!resolution) return 'unavailable'
        if (resolution.kind === 'rejected') return resolution.reason
        if (request.messageClass === 'reply' && !await this.findMessage(request.replyTo)) return 'invalid-reply'
        const metadata = (await this.metadata()).find(item => item.sessionId === resolution.recipient.sessionId)
        return metadata ? policyReason(metadata.settings, request.messageClass) ?? resolution.recipient : 'unavailable'
      },
      notify: (recipient) => { const owner = this.owners.get(recipient.sessionId); if (owner) this.track(owner.arbitrator.drain()) },
    })))
    if (this.config.seatAddressing) this.ctx.effect(() => this.ctx.provide('routedSeatMessageReceiver', createSeatMessageReceiver({
      mailbox: this.mailbox, maxContentBytes: this.config.maxContentBytes,
      authorize: async (authority, request) => await this.ctx.get('routedDeliveryVerifier')?.verify(authority, request.delivery) ?? false,
      resolve: async (request) => {
        const seats = this.ctx.get('seatLocalRead')
        if (!seats) return 'unavailable'
        const definitions = await seats.definitions({})
        if ('status' in definitions) return 'unavailable'
        if (!definitions.definitions.some(row => row.seat === request.target.seat)) return definitions.complete ? 'target-not-found' : 'unavailable'
        const resolution = await this.resolveSeat(request.target.seat)
        if (resolution.kind === 'rejected') return resolution.reason === 'target-not-found' ? 'offline' : resolution.reason
        const metadata = (await this.metadata()).find(row => row.sessionId === resolution.recipient.sessionId)
        if (!metadata) return 'unavailable'
        const refusal = policyReason(metadata.settings, request.messageClass)
        if (refusal) return resolution.recipient.status === 'busy' ? 'busy-not-accepting' : refusal
        if (request.messageClass === 'reply' && (!request.replyTo || !await this.findMessage(request.replyTo))) return 'invalid-reply'
        return resolution.recipient
      },
      online: () => this.listOnlineSeats(),
      notify: (recipient) => { const owner = this.owners.get(recipient.sessionId); if (owner) this.track(owner.arbitrator.drain()) },
    })))
    await this.activate()
  }

  private async initialize(): Promise<void> {
    let node: string | undefined
    try {
      const messages = this.ctx.get('messageLedger')
      node = this.config.nodeId ?? (messages
        ? await messages.nodeId?.()
        : await this.ctx.get('sessionLedger')?.nodeId())
    } catch (error) {
      throw new MailboxUnavailableError('Message delivery unavailable: ledger node identity could not be resolved', { cause: error })
    }
    if (node === undefined) {
      throw new MailboxUnavailableError('Message delivery unavailable: ledger node identity could not be resolved')
    }
    this.nodeId = component(node) as NodeId
    this.mailbox = new FileMailbox({ ...this.config, home: resolveDshHome(this.config.dshHome), nodeId: this.nodeId })
    this.receipts = new ReceiptStore(this.mailbox)
    const subprocess = this.ctx.get('subprocess')
    this.registry = new NodeRegistry(this.mailbox, subprocess ? pid => subprocess.readProcessIdentity(pid) : undefined)
    try {
      await privateDirectory(this.mailbox.options.home)
      if (process.platform === 'win32') await inspectWindowsAcl(this.mailbox.options.home)
    } catch (error) {
      if (error instanceof MailboxUnavailableError && [
        'Mailbox directory permissions are not private', 'Product home group is not the primary user group',
        'Product home group is not private to the current user', 'Windows mailbox ACL grants another principal read or write access',
      ].includes(error.message)) {
        const reason = { code: 'home-permissions' as const, path: this.mailbox.options.home }
        this.ctx.provide('messageDeliveryUnavailable', reason)
        this.ctx.logger.error('Message delivery unavailable:', reason.code, reason.path)
      }
      throw error
    }
    if (process.platform !== 'win32' && ((await lstat(this.mailbox.options.home)).mode & 0o020) !== 0) {
      this.ctx.logger.warn('Product home permits private-user-group writes; mailbox directories remain owner-only')
    }
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
        try { await owner.arbitrator.probe() } catch (error) { this.ctx.logger.error('Mailbox scan failed', error) }
      }
      if (this.owners.size > 0) await this.registry.heartbeat()
      try {
        await recoverRoutedMessages(this.ctx, this.mailbox, async (sender, work) => {
          if (sender.kind !== 'session') return false
          const owner = this.owners.get(sender.sessionId)
          if (!owner || owner.closing || !this.canAdopt(owner.agent)) return false
          const live = () => !this.stopped && this.owners.get(sender.sessionId) === owner
            && !owner.closing && this.canAdopt(owner.agent)
          await this.ctx.agents.withInitiator(owner.agent, () => work(live))
          return true
        }, () => !this.stopped, this.recoveryScan)
      } catch (error) { void error; this.ctx.logger.error('Routed message recovery unavailable; uncertain operations remain retained') }
    }
  }

  private sender(): MessageSender {
    const agent = this.ctx.agents.currentInitiator()
    if (agent && this.ctx.agents.get(agent.id) !== agent) throw new MailboxUnavailableError('Sender Agent is not live')
    return agent ? { kind: 'session', sessionId: agent.id } : { kind: 'human', sessionId: null }
  }

  private settingsFor(id: SessionId): MessageSettings {
    return this.policy.live(id)
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
        archived: archived.has(id), settings: await this.policy.read(id) })
    }
    return output
  }

  async resolve(addresses: readonly MessageAddress[]): Promise<ResolvedRecipient[]> {
    await this.ready
    return resolveRecipients(this.nodeId, addresses, await this.metadata(), id => this.registry.status(id))
  }

  private async seatWindows(): Promise<readonly import('@panedesk/dsh-seat').SeatMessageWindow[]> {
    await this.ready
    if (!this.config.seatAddressing) throw new MailboxUnavailableError('Seat addressing is disabled')
    const seats = this.ctx.get('seatLocalRead')
    if (!seats?.messageWindows) throw new MailboxUnavailableError('Local seat window evidence is unavailable')
    return seats.messageWindows()
  }

  override async resolveSeat(seat: string): Promise<import('@panedesk/dsh-message-delivery').SeatRecipientResolution> {
    const windows = await this.seatWindows()
    return resolveSeatRecipient(this.nodeId, seat, windows, await this.metadata(), id => this.registry.status(id))
  }

  override async listOnlineSeats(): Promise<readonly import('@panedesk/dsh-message-delivery').OnlineSeat[]> {
    const windows = (await this.seatWindows()).filter(window => window.nodeId === this.nodeId)
    const metadata = await this.metadata()
    const output: import('@panedesk/dsh-message-delivery').OnlineSeat[] = []
    for (const window of windows) {
      const [result] = await resolveRecipients(this.nodeId, [{ sessionId: window.sessionId }], metadata, id => this.registry.status(id))
      if (result?.kind === 'rejected' && result.reason === 'unavailable') throw new MailboxUnavailableError('Seat runtime liveness is unavailable')
      if (result?.kind === 'resolved' && result.recipient.status !== 'closed') {
        output.push({ seat: window.seat, sessionId: window.sessionId, nodeId: this.nodeId,
          status: result.recipient.status, primary: window.primary })
      }
    }
    return output
  }

  override async sendSeat(request: import('@panedesk/dsh-message-delivery').SendSeatMessageRequest): Promise<SendMessageResult> {
    await this.seatWindows()
    return sendRoutedMessage(this.ctx, this.mailbox, request, this.sender())
  }

  override async listSeatNodes(): Promise<readonly import('@panedesk/dsh-message-delivery').SeatNodeObservation[]> {
    const local: import('@panedesk/dsh-message-delivery').SeatNodeObservation = {
      nodeId: this.nodeId, state: 'observed', seats: await this.listOnlineSeats(),
    }
    return [local, ...await observeRemoteSeats(this.ctx, this.nodeId, this.config.maxBatchSize, this.lifetime.signal)]
  }

  async send(request: SendMessageRequest): Promise<SendMessageResult> {
    await this.ready
    const sender = this.sender()
    if (request.target.nodeId !== undefined && request.target.nodeId !== this.nodeId
      && this.ctx.get('nodeRouter') && this.ctx.get('nodeDelegationIssuer')) {
      return sendRoutedMessage(this.ctx, this.mailbox, request, sender)
    }
    const digest = createHash('sha256').update(JSON.stringify({ sender, request })).digest('hex')
    const key = component(request.operationId)
    return this.mailbox.locked(join(this.mailbox.root, 'operations', `${key}.lock`), async () => {
      const path = join(this.mailbox.root, 'operations', `${key}.json`)
      const previous = await readValue(path, this.config.maxRecordBytes)
      if (previous !== undefined) {
        if (!object(previous) || previous.digest !== digest || !object(previous.result)) throw new MailboxUnavailableError('operation-conflict')
        const result = decodeSendResult(previous.result)
        // Only a resolution refusal has no mailbox effects; accepted and uncertain sends retain their identity.
        if (result.deliveryOutcome !== 'rejected' || result.reason !== 'unavailable') return result
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
        const record = await this.mailbox.append(recipient.sessionId, request.operationId, digest,
          decodeCommand({ kind: 'send', message, result }, 'request'))
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
    decodeCommand(command, 'request')
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
    const ledger = this.ctx.get('messageLedger') ?? await this.ctx.get('sessionLedger')?.messages()
    const events = (await ledger?.read({}))?.events ?? []
    const isolated = events.filter(event => event.kind === 'message/quarantined' && event.nodeId === this.nodeId && event.data.messageId === messageId)
      .sort((a, b) => a.observedAt - b.observedAt || a.eventId.localeCompare(b.eventId)).at(-1)
    if (isolated) {
      const states = events.filter(event => event.kind === 'message/state' && event.nodeId === this.nodeId && event.data.messageId === messageId)
      const transitions = states.flatMap(event => event.kind === 'message/state'
        ? [{ cursor: event.eventId as string as MessageStateEvent['cursor'], nodeId: event.nodeId, data: event.data }] : [])
        .sort((a, b) => a.data.stateVersion - b.data.stateVersion)
      const last = transitions.at(-1)
      if (!last) throw new MailboxUnavailableError('message-not-found')
      const data = { ...last.data, state: 'rejected' as const, transition: 'rejected' as const, reason: 'record-corrupt' as const,
        observedAt: isolated.observedAt, deliveryOutcome: 'rejected' as const, pending: false }
      return { messageId, state: 'rejected', phase: 'settled', revision: data.revision, stateVersion: data.stateVersion,
        transitions: [...transitions, { cursor: isolated.eventId as string as MessageStateEvent['cursor'], nodeId: isolated.nodeId, data }] }
    }
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
    const metadata = new Map<MessageId, NonNullable<MessageStatus['metadata']>>()
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
        if (query.includeMetadata) metadata.set(message.messageId, { senderSessionId: message.senderSessionId,
          targetSessionId: message.target.sessionId, priority: message.priority, createdAt: message.createdAt })
      }
    }
    const limit = query.limit ?? this.config.maxBatchSize
    if (query.pagination && (!Number.isSafeInteger(limit) || limit < 1)) throw new MailboxUnavailableError('Message query limit must be a positive integer')
    const after = !query.pagination || query.cursor === undefined ? undefined : query.cursor.slice('message-list:'.length)
    if (query.pagination && query.cursor !== undefined && (!query.cursor.startsWith('message-list:')
      || ![...ids].some(id => id === after))) throw new MailboxUnavailableError('Message query cursor is unavailable')
    const items: MessageStatus[] = []
    for (const id of [...ids].sort()) {
      if (after !== undefined && id <= after) continue
      const status = await this.status(id)
      if (query.states && !query.states.includes(status.state)) continue
      if (query.unansweredOlderThanMinutes !== undefined && (status.transitions.some(event => event.data.transition === 'responded')
        || (!query.includeTerminal && ['withdrawn', 'invalidated', 'rejected'].includes(status.state)))) continue
      const details = metadata.get(id)
      items.push(details ? { ...status, metadata: details } : status)
    }
    const page = items.slice(0, limit)
    const last = page.at(-1)
    return { items: page, complete: items.length <= limit,
      ...query.pagination && items.length > limit && last !== undefined
        ? { nextCursor: `message-list:${last.messageId}` as MessageCursor } : {} }
  }

  override async quarantined(query: import('@panedesk/dsh-message-delivery').MessageQuarantineQuery): Promise<import('@panedesk/dsh-message-delivery').MessageQuarantinePage> {
    await this.ready
    const ledger = this.ctx.get('messageLedger') ?? await this.ctx.get('sessionLedger')?.messages()
    if (!ledger || query.nodeId !== undefined && query.nodeId !== this.nodeId) return { items: [], complete: false }
    const limit = query.limit ?? this.config.maxBatchSize
    if (!Number.isSafeInteger(limit) || limit < 1) throw new MailboxUnavailableError('Quarantine query limit must be positive')
    const page = await ledger.read({})
    const events = page.events.filter((event) => {
      if (event.kind !== 'message/quarantined' || event.nodeId !== this.nodeId) return false
      if (query.from !== undefined && event.observedAt < query.from || query.to !== undefined && event.observedAt >= query.to) return false
      if (query.targetSessionId === undefined) return true
      const expected = `message/quarantined:${createHash('sha256').update(JSON.stringify([
        event.nodeId, query.targetSessionId, event.data.originalFileName,
      ])).digest('hex')}`
      return event.eventId === expected
    }).sort((a, b) => a.observedAt - b.observedAt || a.eventId.localeCompare(b.eventId))
    const position = query.cursor === undefined ? -1 : events.findIndex(event => String(event.eventId) === query.cursor)
    if (query.cursor !== undefined && position < 0) throw new MailboxUnavailableError('Quarantine cursor is unavailable')
    const selected = events.slice(position + 1, position + 1 + limit)
    const last = selected.at(-1), more = events.length > position + 1 + selected.length
    return { items: selected.flatMap(event => event.kind === 'message/quarantined' ? [{ ...event.data,
      cursor: event.eventId as string as MessageCursor, nodeId: event.nodeId, observedAt: event.observedAt,
      ...(query.targetSessionId === undefined ? {} : { targetSessionId: query.targetSessionId }),
    }] : []), complete: page.complete,
    ...(more && last ? { nextCursor: last.eventId as string as MessageCursor } : {}) }
  }

  async sendBatch(request: SendBatchRequest): Promise<SendBatchResult> {
    return broadcast(request, this.config.maxBatchSize, addresses => this.resolve(addresses),
      id => this.policy.read(id), item => this.send(item))
  }

  async configure(request: ConfigureMessagesRequest): Promise<MessageSettings> {
    await this.ready
    const owner = this.owners.get(request.sessionId)
    if (!owner) throw new MailboxUnavailableError('Settings require the Session lease owner')
    const sender = this.sender()
    if (sender.kind === 'session' && sender.sessionId !== request.sessionId) throw new MailboxUnavailableError('unauthorized')
    owner.agent.session.append('message/settings', request.settings)
    await this.ctx.get('sessionPersistence')?.flush()
    return this.settingsFor(request.sessionId)
  }

  private async publishReceipt(event: MessageStateEvent): Promise<void> {
    const identity = event.cursor
    if (this.emitted.has(identity)) return
    const receipt = await this.receipts.publish(event)
    event = { ...event, cursor: receipt.cursor }
    const ledger = this.ctx.get('messageLedger') ?? await this.ctx.get('sessionLedger')?.messages()
    if (ledger) await ledger.append({ schemaVersion: 1, kind: 'message/state', eventId: messageEventId(event),
      nodeId: this.nodeId, observedAt: event.data.observedAt, data: event.data })
    if (!this.emitted.has(identity)) {
      this.emitted.add(identity)
      this.ctx.emit('message/state', event)
    }
  }

  async *subscribe(request: MessageSubscriptionRequest): AsyncIterable<MessageStateEvent> {
    await this.ready
    yield* this.receipts.subscribe(request, this.config.scanIntervalMs, this.lifetime.signal)
  }
}
