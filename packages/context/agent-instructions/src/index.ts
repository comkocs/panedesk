/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches project nested, changed, and removed instructions into the inbox.
 * Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products
 * mount it as a no-op.
 *
 * @module @panedesk/dsh-agent-instructions
 */

import type {} from '@panedesk/dsh-working-directory'
import type {} from '@panedesk/dsh-seat'
import { resolve } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { isDeepStrictEqual } from 'node:util'
import { agentEvents, type Agent, type PreStepDecision } from '@panedesk/dsh-agent'
import { installInstructionWriteObservations, observeInstructionBytes } from './observations.ts'
import type { LoadedInstructionFile } from './files.ts'
import type { InstructionObservation } from './events.ts'
import { createUserMessage } from '@panedesk/dsh-llm'
import type { Session, UserMessage } from '@panedesk/dsh-session'
import type {} from '@panedesk/dsh-session-projection'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@panedesk/dsh-tools'
import { Config, resolveConfig, workspaceBaselineIdentity, type ResolvedConfig } from './config.ts'
import { findProjectRoot, loadBaselineInstructionSet } from './files.ts'
import { trimmedInstructionDigest } from './digest.ts'
import { loadClaudeMemoryFile } from './memory.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  agentInstructionsMessage,
  type InstructionVersionCache,
  type AgentInstructionSource,
} from './state.ts'
import {
  instructionCandidateGroup,
  instructionScopeKey,
  renderClaudeMemory,
  scopeForDisplayPath,
  type AgentInstructionChange,
} from './render.ts'

export { Config, name }
/** Services required by workspace instruction projection. */
export const inject = ['sessionProjections', 'workingDirectory']
export { collectCompactInstructions, extractCompactInstructions } from './compact.ts'
export {
  CLAUDE_MEMORY_FILE, claudeMemoryPaths, encodeClaudeProjectsDirectory, loadClaudeMemoryFile,
} from './memory.ts'
export type { LoadedClaudeMemory } from './memory.ts'
export {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
} from './files.ts'
export type {
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderAgentInstructions } from './render.ts'
export type { RenderedAgentInstructions, TruncatedInstruction } from './render.ts'

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) {
      return message.source
    }
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline === true) return event.data.source
  }
  return undefined
}

function isAgentInstructionsMessage(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  installInstructionWriteObservations(ctx, resolved.maxSourceBytes)
  const publishLoaded = async (
    agent: Agent, files: readonly LoadedInstructionFile[], baseline: boolean, signal: AbortSignal,
  ): Promise<void> => {
    const fs = ctx.get('fs')
    if (fs === undefined) return
    const observations: InstructionObservation[] = []
    for (const file of files) {
      if (file.version === undefined) continue
      try {
        const target = await fs.resolve(file.absolutePath, { signal })
        const observation = await observeInstructionBytes(fs, target, file.version, resolved.maxSourceBytes, signal)
        if (observation.evidence?.status === 'available') observations.push({ ...observation, baseline })
      } catch (error: unknown) {
        signal.throwIfAborted()
        ctx.logger.warn('Instruction load observation unavailable: %o', error)
      }
    }
    if (observations.length > 0) agentEvents(ctx, agent).emit('instructions/loaded', { files: observations })
  }
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  const projectionLifecycle = new AbortController()
  const observedAgents = new Set<Agent>()
  let polling: Promise<void> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  ctx.effect(
    () => async () => {
      projectionLifecycle.abort(new Error('agent-instructions disposed'))
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      observedAgents.clear()
      executionTouches.clear()
      await polling
    },
    'agent-instructions.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  // Execution ancestry and the enclosing durable step are the two commit
  // boundaries before an asynchronous projection may mutate the agent inbox.
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const sessionRoots = resolved.includeSessionWorkspaceRoots
      ? await ctx.get('seatDirectories')?.roots(agent.session.id) ?? []
      : []
    const effective: ResolvedConfig = {
      ...resolved,
      additionalRoots: [...new Set([
        ...resolved.additionalRoots.map(root => resolve(cwd, root)),
        ...sessionRoots.filter(root => root.kind === 'additional').map(root => root.path),
      ])],
    }
    const identity = workspaceBaselineIdentity(effective, cwd, projectRoot)
    if (touchedPaths.length === 0 && pending.length > 0
      && baselinePreparations.get(agent.session)?.identity === identity) return pending[0]
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet({
        cwd,
        dshHome: resolved.dshHome,
        agentsHome: resolved.agentsHome,
        projectRootMarkers: resolved.projectRootMarkers,
        additionalRoots: effective.additionalRoots,
        maxBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        instructionFileCandidates: resolved.instructionFileCandidates,
        localInstructionFileCandidates: resolved.localInstructionFileCandidates,
        projectRoot,
        replacePreviousBaseline,
        signal,
      }, fileSystem)
      await publishLoaded(agent, instructions?.included ?? [], true, signal)
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const includedDigestsByGroup = new Map<string, Set<string>>()
      for (const file of instructions?.included ?? []) {
        const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
        const digests = includedDigestsByGroup.get(group) ?? new Set<string>()
        digests.add(trimmedInstructionDigest(file.content))
        includedDigestsByGroup.set(group, digests)
      }
      // A duplicate inherits its winner's budget omission. Only duplicates of
      // represented content remain eligible for promotion during reconciliation.
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      for (const file of instructions?.deduped ?? []) {
        const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
        if (includedDigestsByGroup.get(group)?.has(trimmedInstructionDigest(file.content))) {
          excludedScopes.delete(instructionScopeKey(file.displayPath))
        }
      }
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = agentInstructionsMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    // The Claude Code memory file rides the same baseline byte budget as the
    // instruction chain and shares its message; reconciliation does not track it.
    if (!keepVisibleBaseline) {
      let memory: Awaited<ReturnType<typeof loadClaudeMemoryFile>>
      try {
        memory = await loadClaudeMemoryFile(
          { cwd, maxSourceBytes: resolved.maxSourceBytes, signal },
          fileSystem,
        )
      } catch (error: unknown) {
        signal.throwIfAborted()
        ctx.logger.warn('Claude memory load failed: %o', error)
        memory = undefined
      }
      if (memory !== undefined) {
        let baselineBytes = 0
        for (const block of content) baselineBytes += Buffer.byteLength(block.type === 'text' ? block.text : '', 'utf8')
        const text = renderClaudeMemory(memory, resolved.maxBytes - baselineBytes)
        if (text !== undefined) content.push({ type: 'text', text })
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      effective,
      instructionVersions,
      fileSystem,
      {
        cwd,
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        projectRoot,
        signal,
      },
    )
    if (update !== undefined) {
      await publishLoaded(agent, update.loadedFiles, false, signal)
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const event = agent.session.eventAt(seq)
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  const queueProjection = (
    agent: Agent,
    touchedPath: string,
  ): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await projection
  }

  if (resolved.refreshIntervalMs > 0) {
    const schedulePoll = (): void => {
      if (projectionLifecycle.signal.aborted) return
      pollTimer = setTimeout(() => {
        polling = (async () => {
          for (const agent of observedAgents) {
            if (projectionLifecycle.signal.aborted) break
            // A poll discovers changes but only an admitted step commits them to history.
            projectTouch({ agent, path: '.' })
            await waitForProjections(agent)
          }
        })().catch((error: unknown) => {
          if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction polling failed: %o', error)
        }).finally(schedulePoll)
      }, resolved.refreshIntervalMs)
      pollTimer.unref()
    }
    schedulePoll()
    ctx.on('agent/disposed', ({ agent }) => { observedAgents.delete(agent) })
  }

  const stepIsOpen = (session: Session): boolean => {
    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined) {
      throw new Error('agent-instructions requires the turnBoundary session projection')
    }
    return boundary.openTurnStartSeq !== null
      && boundary.lastStepBoundary?.kind === 'start'
      && boundary.lastStepBoundary.seq > boundary.openTurnStartSeq
  }

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path)
      return
    }
    const pending = stepTouches.get(session)
    if (pending === undefined) stepTouches.set(session, [touch])
    else if (!pending.some(item => item.agent === touch.agent && item.path === touch.path)) pending.push(touch)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end') return
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    for (const touch of pending) queueProjection(touch.agent, touch.path)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    if (resolved.refreshIntervalMs > 0) observedAgents.add(agent)
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { ...decision, messages: entered }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec)
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent)
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches)
        else parentTouches.push(...touches)
      }
      return
    }
    for (const touch of touches) projectTouch(touch)
  })
}
