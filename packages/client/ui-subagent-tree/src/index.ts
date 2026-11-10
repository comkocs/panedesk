/**
 * Host half of the subagent tree plugin: ledger and transcript reads,
 * plus process-tree stops for registered external children. The browser
 * half in `src/client/` owns every contribution.
 *
 * @module @panedesk/dsh-client-ui-subagent-tree
 */

import { readFile } from 'node:fs/promises'
import type { Context, Volatile } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-settings'
import type {} from '@panedesk/dsh-activity-category'
import type {} from '@panedesk/dsh-verification-policy'
import type {} from '@panedesk/dsh-session-ledger'
import type { SessionQueryEngine } from '@panedesk/dsh-session-query'
import type { SessionId } from '@panedesk/dsh-session/types'
import Schema from '@panedesk/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type { SubagentTreeRequest, SubagentTreeView } from './types.ts'
import { assembleSubagentTree, subagentTreeSessions, type SubagentTranscriptFacts } from './tree.ts'
import { foldTranscriptFacts } from './transcript.ts'
import { externalRegistryNodes, stopExternalRegistryNode } from './external-registry.ts'

/** Explicit subagent-tree availability and refresh cadence. */
export interface Config {
  /** Permit authenticated owners to read tree and monitoring projections. */
  enabled: boolean
  /** Client resource refresh interval in milliseconds. */
  refreshIntervalMs: number
  /** Host-readable external JSONL registry; empty disables file reads. */
  externalRegistryFile: Volatile<string>
  /** Enable external registry reads while retaining the configured path. */
  externalRegistryEnabled: Volatile<boolean>
}

declare module '@panedesk/cordis' {
  interface Context { subagentTree: SubagentTreeService }
}

/** Tree monitoring and external dispatch control over the configured registry. */
export default class SubagentTreeService extends TypertRemoteService {
  static inject = ['typert']

  static Config = Schema.object({
    enabled: Schema.boolean().default(true),
    refreshIntervalMs: Schema.number().min(1000).max(2147483647).step(1).default(5000),
    externalRegistryFile: Schema.string().default('').volatile(),
    externalRegistryEnabled: Schema.boolean().default(false).volatile(),
  })

  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying the ledger and session-query services, when deployed.
   * @param config - availability and refresh cadence.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'subagentTree')
    ctx.effect(() => () => { this.lifetime.abort() })
    ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  }

  private cancelled(): boolean {
    return this.lifetime.signal.aborted || this.ctx.invocation?.signal.aborted === true
  }

  /** Read one session's transcript-derived facts without leaking failure detail to the wire.
   * @param sessionId - session whose own log suffix to fold.
   * @param reader - deployed session-query engine, when present.
   * @returns transcript facts, or an unreadable marker that keeps both values unknown.
   */
  private async readTranscript(sessionId: SessionId, reader: SessionQueryEngine | undefined): Promise<SubagentTranscriptFacts> {
    if (reader === undefined) return { model: null, modelSource: 'unavailable', lastToolCall: null }
    try {
      const log = await reader.readSession(sessionId)
      const facts = foldTranscriptFacts(log.events, log.inheritedEventCount)
      return this.cancelled() ? { model: null, modelSource: 'unavailable', lastToolCall: null } : facts
    } catch (_unreadableLog) {
      return { model: null, modelSource: 'unreadable', lastToolCall: null }
    }
  }

  /**
   * Stop the process trees identified by an external child's latest registry record.
   * @param request - external child session id.
   * @returns after the terminal registry row is appended.
   */
  @Remote
  async stopExternal(request: SubagentTreeRequest): Promise<void> {
    await stopExternalRegistryNode(this.config.externalRegistryFile.get(), request.sessionId)
  }

  /** Read one deduplicated ledger snapshot and per-session transcripts after authenticating the invocation owner.
   * @param request - the on-screen session whose descendant tree is requested.
   * @returns nested tree with monitoring columns and the deployment's refresh cadence.
   */
  @Remote
  async read(request: SubagentTreeRequest): Promise<SubagentTreeView> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('subagentTree/unauthorized', 'Authenticated owner required', {})
    }
    if (!this.config.enabled) throw new RemoteError('subagentTree/disabled', 'The subagent tree is disabled', {})
    if (this.cancelled()) throw new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {})
    const ledger = this.ctx.get('sessionLedger')
    const snapshot = ledger === undefined
      ? { asOf: Date.now(), complete: false, watermarks: {}, rows: [] }
      : await ledger.snapshot()
    if (this.cancelled()) throw new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {})
    const asOf = snapshot.asOf
    const facts = subagentTreeSessions(snapshot, request.sessionId, asOf)
    const reader = this.ctx.get('sessionQuery')
    const transcripts = new Map<SessionId, SubagentTranscriptFacts>()
    for (const fact of facts) {
      const transcript = await this.readTranscript(fact.sessionId, reader)
      const categoryActivity = await this.ctx.get('activityCategory')?.read(fact.sessionId, snapshot) ?? null
      transcripts.set(fact.sessionId, { ...transcript, categoryActivity })
      if (this.cancelled()) throw new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {})
    }
    const root = assembleSubagentTree(facts, transcripts, request.sessionId)
    if (root === null) {
      throw new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {})
    }
    const path = this.config.externalRegistryFile.get()
    let text = ''
    let externalRegistryUnreadable = false
    if (this.config.externalRegistryEnabled.get() && path !== '') {
      try {
        text = await readFile(path, 'utf8')
      } catch (_unreadableRegistry) {
        // Preserve native nodes and retry on the next poll without exposing host paths.
        externalRegistryUnreadable = true
      }
    }
    if (this.cancelled()) throw new RemoteError('subagentTree/unavailable', 'The subagent tree is unavailable', {})
    const withExternal = (node: typeof root): typeof root => {
      const session = this.ctx.get('sessions')?.get(node.sessionId)
      const taskId = session === undefined ? node.activity?.taskId : this.ctx.get('activityCategory')?.taskIdentity(session).taskId
      return { ...node,
        ...taskId === undefined ? {} : { verificationTaskId: taskId, testsStopped: this.ctx.get('verificationPolicy')?.testsStopped(taskId) ?? false },
        children: [...node.children.map(withExternal), ...externalRegistryNodes(text, node.sessionId, asOf)],
      }
    }
    return { asOf, complete: snapshot.complete, root: withExternal(root), externalRegistryUnreadable,
      refreshIntervalMs: this.config.refreshIntervalMs }
  }
}
