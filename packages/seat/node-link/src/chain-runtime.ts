/** One optional chain attachment owns persistence, readiness, ingress and outgoing drain. */
import { join } from 'node:path'
import type { PrivateFiles } from '@panedesk/dsh-host-admin'
import type { ChainServices } from './chain-services.ts'
import type { ChainCapability, ChainRequest, ChainResponse } from './chain-types.ts'
import type { NodeLinkRuntimeConfig } from './index.ts'
import type { ChannelCredential } from './credentials.ts'
import { ChainStore } from './chain-store.ts'
import { ChainRetainedEvidence } from './chain-retained.ts'
import { ChainEvidence } from './chain-evidence.ts'
import { ChainReceiver } from './chain-receiver.ts'
import { ChainRouter } from './chain-router.ts'
import { ChainBusinessRegistry } from './chain-business.ts'
import { ChainSlots } from './chain-slots.ts'
import { chainFailure } from './chain-identity.ts'

/** Withdrawing any captured dependency immediately removes the advertised receiving capability. */
export class ChainRuntime {
  /** Independent admission limits for control and business requests. */
  readonly slots: ChainSlots
  /** Outgoing requests retain authorization evidence before dispatch. */
  readonly router: ChainRouter
  /** Evidence exchange restricted to the authenticated paired node. */
  readonly evidence: ChainEvidence
  private readonly received: ChainStore
  private readonly sent: ChainStore
  private readonly retained: ChainRetainedEvidence
  private readonly receiver: ChainReceiver
  private remote: ChainCapability | undefined
  private recovered = false
  private stopped = false
  private preparing: Promise<void> | undefined
  private readonly loaded: Promise<void>
  private recovery: Promise<void> | undefined
  constructor(private readonly options: NodeLinkRuntimeConfig, private readonly services: ChainServices,
    private readonly business: ChainBusinessRegistry, files: (directory: string) => PrivateFiles,
    credential: () => ChannelCredential, private readonly current: () => boolean, available: () => boolean,
    disconnect?: () => void) {
    this.slots = new ChainSlots(options.maxPending, services.maxControlPending)
    this.received = new ChainStore(files(join(options.directory, 'chain-received')), options.maxStoreBytes, options.maxOperations)
    this.sent = new ChainStore(files(join(options.directory, 'chain-sent')), options.maxStoreBytes, options.maxOperations)
    this.retained = new ChainRetainedEvidence(files(join(options.directory, 'chain-evidence')),
      options.maxStoreBytes, options.maxOperations, options.nodeId, options.peerNodeId)
    const evidence = services.evidence ?? this.retained
    this.loaded = Promise.all([this.received.load(), this.sent.load(), this.retained.ready()]).then(() => {})
    // The activation owner observes this rejection through ready(), even before the first hello.
    void this.loaded.catch((error: unknown) => { void error })
    this.evidence = new ChainEvidence(options, services.maxControlPending, evidence, credential, () => this.remote)
    this.router = new ChainRouter(options, this.sent, credential, () => !this.stopped && current() && available(),
      () => ({ local: this.capability(), remote: this.remote }), this.retained, () => {
        this.observe(undefined)
        disconnect?.()
      })
    this.receiver = new ChainReceiver(() => ({ sourceNodeId: options.peerNodeId as ChainRequest['sourceNodeId'],
      targetNodeId: options.nodeId as ChainRequest['targetNodeId'], authenticatedAt: new Date().toISOString() }),
    services, business, this.evidence, this.received, () => this.capability() !== undefined)
  }

  /** Recover all declared providers before advertising any receiving method.
   * @returns Completion after transport, policy, local admission and business recovery.
   */
  ready(): Promise<void> {
    return this.preparing ??= Promise.all([this.loaded, this.services.evidence?.ready(),
      this.services.local.ready(), this.services.policy.ready(),
      this.business.ready(this.services.local.methods.filter(method => method !== 'seat.definitionRevision')),
      this.services.local.methods.includes('seat.definitionRevision') ? this.services.local.definitionRevisions?.ready() : undefined]).then(() => { this.recovered = !this.stopped }, (error: unknown) => {
      this.preparing = undefined
      throw error
    })
  }

  /** Read current ownership as well as the completed recovery barrier.
   * @returns Live negotiated capability, absent during recovery or withdrawal.
   */
  capability(): ChainCapability | undefined {
    const methods = this.services.local.methods.filter(method => method !== 'seat.definitionRevision')
    if (this.stopped || !this.current() || !this.recovered || !this.business.isReady(methods)) return undefined
    const revision = this.services.local.methods.includes('seat.definitionRevision')
      && this.services.local.definitionRevisions?.available() === true
    return { capability: 'node-work-chain/v1', maxFrameBytes: Math.min(this.options.maxFrameBytes, 1048576),
      methods: [...methods, 'chain.operation', ...(revision ? ['seat.definitionRevision' as const] : [])] }
  }

  /** Observe only a decoded authenticated peer advertisement.
   * @param capability - Peer capability, absent after disconnect or a legacy hello.
   */
  observe(capability: ChainCapability | undefined): void {
    this.remote = capability
    const issuerFor = this.services.outboxIssuer?.bind(this.services)
    if (capability && this.capability() && issuerFor && !this.recovery) {
      this.recovery = this.router.recover(request => issuerFor(request))
        .catch((error: unknown) => { void error })
        .finally(() => { this.recovery = undefined })
    }
  }

  /** Bound ingress and responses by the local and authenticated peer advertisements.
   * @returns The three complete-frame limits, or refusal before negotiation.
   */
  limits(): readonly number[] {
    const local = this.capability()
    if (!local || !this.remote) throw new Error('Node chain capability unavailable')
    return [this.options.maxFrameBytes, local.maxFrameBytes, this.remote.maxFrameBytes]
  }

  /** Dispatch only while both paired capabilities remain present.
   * @param request - Decoded authenticated chain frame.
   * @returns Correlated business response.
   */
  receive(request: ChainRequest): Promise<ChainResponse> {
    if (!this.remote) return Promise.reject(new Error('Node chain peer capability unavailable'))
    if (request.method === 'seat.definitionRevision' && (!this.remote.methods.includes(request.method)
      || !this.capability()?.methods.includes(request.method))) {
      return Promise.resolve(chainFailure(request, 'cross-node-unsupported', 'peer-capability-missing'))
    }
    return this.receiver.receive(request)
  }

  /** Remove capability synchronously, then drain all work before closing durable stores.
   * @returns Completion after accepted work and publications finish.
   */
  async close(): Promise<void> {
    this.stopped = true
    this.remote = undefined
    await this.slots.close()
    await this.router.close()
    await this.recovery
    await this.loaded.catch((error: unknown) => { void error })
    await this.received.close(); await this.sent.close(); await this.retained.close()
  }
}
