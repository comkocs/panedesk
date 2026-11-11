/** Agent activation, composition, and model-selection policy owned by API Session. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NewSessionTiming } from './new-session-timing.ts'
import { Service, type Context } from '@panedesk/cordis'
import { installModelSelection } from '@panedesk/dsh-agent'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-agent-default-model'
import type {} from '@panedesk/dsh-agent-preset-registry'
import { brandString } from '@panedesk/dsh-brand'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import type { Session, SessionId } from '@panedesk/dsh-session'
import type { SessionInspection } from '@panedesk/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@panedesk/dsh-session-query'
import { RemoteError, remoteErrorOf } from '@panedesk/dsh-typert-protocol'
import type {} from '@panedesk/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    sessionCreation: SessionCreationScope
  }
}

/** Trusted creation capability; it is never accepted from a remote request. */
export interface ExactSessionCreation {
  readonly sessionId: SessionId
  /** Composition awaited before publication and before any queued work. */
  readonly setup?: AgentSetup
  /** Validated Session-local selection; never changes the global default. */
  readonly selection?: AgentModelSelection
  /** Idempotent release of temporary attribution on takeover or any failure. */
  readonly releasePreparation?: () => void
}

type ExactCreationRun = { readonly request: ExactSessionCreation; active: boolean; claimed: boolean }

/** Optional process-local scope for callers that own a reserved session identity. */
export class SessionCreationScope extends Service {
  private readonly runs = new AsyncLocalStorage<ExactCreationRun>()

  constructor(ctx: Context, private readonly createSession?: (request: ApiSessionCreateRequest) => Promise<ApiSessionCreated>) {
    super(ctx, 'sessionCreation')
    ctx.effect(() => () => { this.runs.disable() })
  }

  /**
   * Create exactly the reserved identity with unpublished composition and local model selection.
   * @param request - trusted creation capability and explicit placement.
   * @returns the newly published Agent; existing identities are never adopted.
   */
  async create(request: ExactSessionCreation & { readonly cwd: string; readonly agentPreset?: string }): Promise<ApiSessionCreated> {
    try {
      const createSession = this.createSession
      if (createSession === undefined) throw new Error('Controlled session creation is not installed')
      return await this.withExactIdentity(request, () => createSession({
        sessionId: request.sessionId, cwd: request.cwd,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        reusable: () => false,
      }))
    } finally {
      request.releasePreparation?.()
    }
  }

  /**
   * Invoke the existing creation API without permitting identity substitution or reuse.
   * @param request - reserved identity and trusted unpublished setup.
   * @param operation - one awaited invocation of the existing creation API.
   * @returns the operation's result; detached and repeated invocations are rejected.
   */
  async withExactIdentity<T>(request: ExactSessionCreation, operation: () => Promise<T>): Promise<T> {
    const run: ExactCreationRun = { request, active: true, claimed: false }
    return this.runs.run(run, async () => {
      try {
        return await operation()
      } finally {
        run.active = false
      }
    })
  }

  /**
   * Consume this invocation's creation capability, if present.
   * @param sessionId - identity supplied to the ordinary creation API.
   * @returns the trusted setup, or undefined outside a controlled invocation.
   */
  claim(sessionId: SessionId | undefined): ExactSessionCreation | undefined {
    const run = this.runs.getStore()
    if (run === undefined) return undefined
    if (!run.active || run.claimed || sessionId !== run.request.sessionId) {
      throw new ApiSessionExactCreateConflict(run.request.sessionId)
    }
    run.claimed = true
    return run.request
  }
}

/** A controlled creation cannot adopt an existing identity or mint a replacement. */
export class ApiSessionExactCreateConflict extends Error {
  /** @param sessionId - identity that must remain reserved to its owner. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" cannot be created under its reserved identity`)
    this.name = 'ApiSessionExactCreateConflict'
  }
}

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Reuse of a Session named an Agent preset while the deployment composes no preset roster. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
  ) {
    super(`the deployment composes no agent preset roster, so session "${sessionId}" cannot run preset "${requestedPreset}"`)
  }
}

/** A blank Session chosen for reuse started a turn before this Host acquired its writer. */
class ApiSessionStartedSinceObserved extends Error {}

/** Placement and Agent preset for one Session created for a new conversation. */
export interface ApiSessionCreateRequest {
  /** Blank Session to reuse, or the identity of a new Session when none is stored under it. */
  readonly sessionId?: SessionId
  /** Directory the Session owns. */
  readonly cwd: string
  /** Preset the Session runs; the configured default when omitted. */
  readonly agentPreset?: string
  /**
   * Placement rule the caller owns, such as Workspace membership and archive state.
   * @param sessionId - existing Session named by the request.
   * @returns whether that Session may be reused.
   */
  readonly reusable: (sessionId: SessionId) => boolean
}

/** The Session one creation request created or reused. */
export interface ApiSessionCreated {
  /**
   * Live Agent of the Session. Absent only while a brand-new Session has been
   * minted but not yet published; callers that need the Agent await {@link ready}.
   */
  readonly agent?: Agent
  /** Preset the Session ran when the request finished, before a later request for the same identity; absent without a roster. */
  readonly agentPreset: string | undefined
  /** Identity available before publication finishes. Present for every result. */
  readonly sessionId?: SessionId
  /**
   * Settles with the published Session. Present only when {@link agent} is
   * still absent because publication continues after the identity was handed out.
   */
  readonly ready?: Promise<ApiSessionCreated>
}

/** Resolved preset and pre-publication Agent setup for one create or resume. */
interface ApiSessionComposition {
  readonly agentPreset?: string
  readonly setup: AgentSetup
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly claims = new Map<SessionId, Promise<void>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(private readonly ctx: Context) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Creation or resume still running for one identity.
   * A follow that arrives before a brand-new Session is stored waits on this
   * instead of failing the read.
   * @param sessionId - identity a reader arrived for.
   * @returns the in-flight creation or resume, or undefined when none is running.
   */
  pendingCreation(sessionId: SessionId): Promise<Agent> | undefined {
    return this.resumes.get(sessionId)
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Create a Session for a new conversation, reusing the named blank Session
   * while it is still reusable. A reused Session runs the requested preset, or
   * the configured default when the request names none; the preset it recorded
   * is not resolved, and a change is logged as `agent-preset/selected` before
   * the Agent is published. A named Session that has started a turn, fails the
   * caller's placement rule, or is written by another owner stays unchanged,
   * and a new Session is created instead. Requests naming one identity run in
   * arrival order, including their preset resolution, and check the named
   * Session's directory and ownership before resolving the preset.
   *
   * A brand-new Session answers once its identity is stored. Preset mounting,
   * permission facts, durable publication, and plugin subscriptions continue
   * afterwards on that identity; the result carries them as {@link ApiSessionCreated.ready}
   * and records each step when the caller passes a timing line. Reuse and
   * controlled creation keep the previous order.
   * @param request - optional Session to reuse, directory, preset, and placement rule.
   * @param timing - optional recorder for the brand-new path; absent for reuse and controlled creation.
   * @returns the reused or created Session and the preset it ran when the request finished.
   * @throws ApiSessionCwdConflict when the named Session belongs to another directory.
   * @throws ApiSessionSubagentOwnership when subagent routing owns the named Session.
   * @throws RemoteError `agent-preset/not-found` or `agent-preset/invalid` for the requested or default preset.
   * @throws ApiSessionPresetConflict when no roster is composed and the request names a preset for a reused Session.
   */
  async createSession(request: ApiSessionCreateRequest, timing?: NewSessionTiming): Promise<ApiSessionCreated> {
    return this.createRecorded(request, request.sessionId, timing)
  }

  /** Run one creation, passing its timing line only through the brand-new path. */
  private async createRecorded(
    request: ApiSessionCreateRequest,
    named: SessionId | undefined,
    timing?: NewSessionTiming,
  ): Promise<ApiSessionCreated> {
    const exact = this.ctx.get('sessionCreation')?.claim(named)
    if (exact !== undefined) {
      return this.inOrder(exact.sessionId, async () => {
        if (this.ctx.agents.get(exact.sessionId) !== undefined || this.ctx.sessions.get(exact.sessionId) !== undefined) {
          throw new ApiSessionExactCreateConflict(exact.sessionId)
        }
        try {
          using observation = await this.ctx.sessionQuery.observeSession(exact.sessionId)
          throw new ApiSessionExactCreateConflict(observation.header.id)
        } catch (error: unknown) {
          if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
        }
        const composition = await this.composeAgent(request.agentPreset)
        const setup: AgentSetup = async (agentCtx, agent) => {
          await mkdir(request.cwd, { recursive: true })
          const base = await composition.setup(agentCtx, agent)
          if (exact.selection !== undefined) this.selectForNextRequest(agent, exact.selection)
          const controlled = await exact.setup?.(agentCtx, agent)
          return { commit: () => { base?.commit(); controlled?.commit() } }
        }
        return this.created((await this.ctx.agents.create({
          sessionId: exact.sessionId,
          agentOptions: exact.selection ?? this.agentOptions(),
          meta: { cwd: request.cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
          setup,
          ...(exact.releasePreparation === undefined ? {} : { releasePreparation: exact.releasePreparation }),
        })).agent)
      })
    }
    if (named === undefined) return this.createFresh(request, timing)
    return this.inOrder(named, async () => this.created(await this.claim(named, request)))
  }

  /**
   * Mint one brand-new identity and return it before publication finishes.
   * Publication is registered on {@link resumes} before the identity is
   * returned, so a follow or prompt that arrives first waits for this creation
   * instead of resuming the same identity beside it.
   * @param request - directory, preset, and placement rule; it names no Session.
   * @param timing - optional recorder for the steps of this creation.
   * @returns the minted identity and the publication that continues afterwards.
   */
  private async createFresh(request: ApiSessionCreateRequest, timing?: NewSessionTiming): Promise<ApiSessionCreated> {
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    timing?.identify(sessionId)
    await this.step(timing, 'directory', () => mkdir(request.cwd, { recursive: true }))
    const composition = await this.step(timing, 'preset', () => this.composeAgent(request.agentPreset, timing))
    // Started, not awaited: the caller returns the identity while this settles.
    const publication = this.step(timing, 'publish', () => this.publishAgent(sessionId, request.cwd, composition))
    this.resumes.set(sessionId, publication.finally(() => { this.resumes.delete(sessionId) }))
    return { sessionId, agentPreset: undefined, ready: publication.then(agent => this.created(agent)) }
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @param timing - optional recorder for the mount step of a brand-new creation.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined, timing?: NewSessionTiming): Promise<ApiSessionComposition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await this.step(timing, 'preset-mount', () => presets.mount(agentCtx, resolvedId))
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  private async inOrder<Value>(sessionId: SessionId, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.claims.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.claims.set(sessionId, settled)
    try {
      return await result
    } finally {
      if (this.claims.get(sessionId) === settled) this.claims.delete(sessionId)
    }
  }

  /** @returns the reused Session, a new Session under `sessionId` when none is stored, or a new Session under a minted identity. */
  private async claim(sessionId: SessionId, request: ApiSessionCreateRequest): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) {
      if (live.session.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd)
      }
      const composition = await this.composeAgent(request.agentPreset)
      return await this.reuseLive(live, request, composition) ?? this.createMinted(request.cwd, composition)
    }
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      return this.createAgent(sessionId, request.cwd, await this.composeAgent(request.agentPreset))
    }
    let reusable: boolean
    {
      using observed = observation
      if (hasApiSessionSubagentOwner(this.ctx, { header: observed.header }, undefined)) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      if (observed.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd)
      }
      reusable = request.reusable(sessionId) && !observed.events.some(event => event.type === 'turn/start')
    }
    const composition = await this.composeAgent(request.agentPreset)
    if (!reusable) return this.createMinted(request.cwd, composition)
    this.assertPresetApplicable(sessionId, request.agentPreset)
    try {
      return (await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: this.reuseSetup(composition),
      })).agent
    } catch (error: unknown) {
      if (error instanceof ApiSessionStartedSinceObserved) return this.createMinted(request.cwd, composition)
      if (!(error instanceof Error) || error.name !== 'SessionAlreadyOwnedError') throw error
      // Another resume in this process may hold the writer for the Agent it published.
      return this.ctx.agents.get(sessionId) === undefined
        ? this.createMinted(request.cwd, composition)
        : this.claim(sessionId, request)
    }
  }

  /** @returns the live blank Session under the requested preset, or undefined when it cannot be reused. */
  private async reuseLive(
    live: Agent,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent | undefined> {
    if (!request.reusable(live.id) || !this.isBlank(live.session)) return undefined
    this.assertPresetApplicable(live.id, request.agentPreset)
    const current = this.presetForSession(live.session)
    const presets = this.ctx.get('agentPresets')
    const target = composition.agentPreset
    if (presets === undefined || target === undefined || target === current) return live
    try {
      await presets.select(live, target)
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code !== 'agent-preset/locked') throw error
      return undefined
    }
    return live
  }

  /** Setup that re-checks blankness under the acquired writer, then records a preset change before publication. */
  private reuseSetup(composition: ApiSessionComposition): AgentSetup {
    return async (agentCtx, agent) => {
      if (!this.isBlank(agent.session)) throw new ApiSessionStartedSinceObserved()
      const commit = await composition.setup(agentCtx, agent)
      const target = composition.agentPreset
      if (target !== undefined && this.presetForSession(agent.session) !== target) {
        agent.session.append('agent-preset/selected', { agentPreset: target })
      }
      return commit
    }
  }

  /** Whether no turn has started, by the predicate the preset registry's `select` enforces. */
  private isBlank(session: Session): boolean {
    const boundary = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
  }

  /** Without a roster, reuse cannot apply a named preset. */
  private assertPresetApplicable(sessionId: SessionId, requested: string | undefined): void {
    if (requested === undefined || this.ctx.get('agentPresets') !== undefined) return
    throw new ApiSessionPresetConflict(sessionId, requested)
  }

  private created(agent: Agent): ApiSessionCreated {
    return { agent, agentPreset: this.presetForSession(agent.session) }
  }

  private createMinted(cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    return this.createAgent(brandString<SessionId>(`session-${randomUUID()}`), cwd, composition)
  }

  private async createAgent(sessionId: SessionId, cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    return this.publishAgent(sessionId, cwd, composition)
  }

  /** Publish one Agent whose directory already exists. */
  private async publishAgent(sessionId: SessionId, cwd: string, composition: ApiSessionComposition): Promise<Agent> {
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })).agent
  }

  /** Record one step when a brand-new creation carries a timing line, otherwise just run it. */
  private step<T>(timing: NewSessionTiming | undefined, name: string, run: () => Promise<T> | T): Promise<T> {
    return timing === undefined ? Promise.resolve().then(run) : timing.measure(name, run)
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
