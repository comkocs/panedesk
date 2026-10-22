/** Bounded, per-agent instruction subscriptions checked before input claim. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { agentEvents, type Agent } from '@panedesk/dsh-agent'
import { brandString } from '@panedesk/dsh-brand'
import type { FileSystem } from '@panedesk/dsh-fs'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-agent-instructions/events'

/** Stable plugin identity. */
export const name = 'instruction-subscriptions'

/** Deployment-controlled subscription paths and memory/read limits. */
export interface Config {
  /** Additional paths, relative to each agent's working directory. */
  files?: string[]
  /** Aggregate retained raw bytes per agent and maximum bytes per scan. */
  maxBytes: number
  /** Watch callbacks invalidate hints only; every boundary still scans. */
  watch?: boolean
}

export const Config: z<Config> = z.object({
  files: z.array(z.string()).default([]),
  maxBytes: z.number().step(1).min(1).required(),
  watch: z.boolean().default(false),
})

type Snapshot = { status: 'present'; hash: string; bytes?: Uint8Array }
  | { status: 'deleted' | 'unreadable' | 'over-limit'; hash: null }
interface Subscription {
  path: string
  snapshot: Snapshot
  dirty: boolean
  close?: () => Promise<void>
}
interface AgentState {
  files: Map<string, Subscription>
  selfWrites: Map<string, string>
  lifecycle: AbortController
  tail: Promise<void>
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function scan(fs: FileSystem, path: string, maxBytes: number, signal: AbortSignal): Promise<Snapshot> {
  try {
    const target = await fs.resolve(path, { signal })
    const info = await fs.stat(target, signal)
    if (info === undefined) return { status: 'deleted', hash: null }
    if (info.type !== 'file') return { status: 'unreadable', hash: null }
    if (maxBytes <= 0 || (info.size !== undefined && info.size > maxBytes)) return { status: 'over-limit', hash: null }
    const bytes = await fs.readBytes(target, signal, maxBytes)
    return { status: 'present', hash: hash(bytes), bytes }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'FS_TOO_LARGE') return { status: 'over-limit', hash: null }
    return { status: 'unreadable', hash: null }
  }
}

function lines(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
}

function lineChanges(before: Snapshot, after: Snapshot): { added: number | null; removed: number | null } {
  if ((before.status === 'present' && before.bytes === undefined)
    || (after.status === 'present' && after.bytes === undefined)
    || before.status === 'unreadable' || before.status === 'over-limit'
    || after.status === 'unreadable' || after.status === 'over-limit') return { added: null, removed: null }
  const oldLines = before.status === 'present' && before.bytes !== undefined ? lines(before.bytes) : []
  const newLines = after.status === 'present' && after.bytes !== undefined ? lines(after.bytes) : []
  // Myers' frontier keeps memory linear in the bounded input; no diff text is retained.
  const limit = oldLines.length + newLines.length
  const offset = limit + 1
  const frontier = new Int32Array(2 * limit + 3)
  for (let distance = 0; distance <= limit; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = diagonal === -distance || (diagonal !== distance
        && (frontier[offset + diagonal - 1] ?? 0) < (frontier[offset + diagonal + 1] ?? 0))
        ? (frontier[offset + diagonal + 1] ?? 0)
        : (frontier[offset + diagonal - 1] ?? 0) + 1
      let y = x - diagonal
      while (x < oldLines.length && y < newLines.length && oldLines[x] === newLines[y]) { x++; y++ }
      frontier[offset + diagonal] = x
      if (x >= oldLines.length && y >= newLines.length) {
        return { added: (distance + newLines.length - oldLines.length) / 2,
          removed: (distance + oldLines.length - newLines.length) / 2 }
      }
    }
  }
  return { added: null, removed: null }
}

/**
 * Install optional-delivery subscriptions without changing instruction composition.
 * @param ctx - owner of listeners and watcher lifetimes.
 * @param config - validated profile/patch configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) throw new Error('maxBytes must be a positive safe integer')
  const files = config.files ?? []
  const watch = config.watch ?? false
  const states = new Map<Agent, AgentState>()
  const stateFor = (agent: Agent): AgentState => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { files: new Map(), selfWrites: new Map(), lifecycle: new AbortController(), tail: Promise.resolve() }
      states.set(agent, state)
    }
    return state
  }
  const retain = (state: AgentState, subscription: Subscription, snapshot: Snapshot): void => {
    subscription.snapshot = snapshot
    let remaining = config.maxBytes
    for (const entry of state.files.values()) {
      if (entry.snapshot.status !== 'present' || entry.snapshot.bytes === undefined) continue
      if (entry.snapshot.bytes.byteLength <= remaining) remaining -= entry.snapshot.bytes.byteLength
      else entry.snapshot = { status: 'present', hash: entry.snapshot.hash }
    }
  }
  const enqueue = (state: AgentState, job: () => Promise<void>): Promise<void> => {
    const task = state.tail.then(job)
    state.tail = task.catch((error: unknown) => {
      if (!state.lifecycle.signal.aborted) ctx.logger.warn('Instruction subscription observation unavailable: %o', error)
    })
    return task
  }
  const initialize = async (agent: Agent, state: AgentState, path: string, initialHash?: string): Promise<void> => {
    const fs = ctx.get('fs')
    if (fs === undefined) return
    state.lifecycle.signal.throwIfAborted()
    const target = await fs.resolve(path, {
      ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
      signal: state.lifecycle.signal,
    })
    const canonical = fs.processPath(target)
    if (state.files.has(canonical)) return
    const subscription: Subscription = { path: canonical, dirty: false, snapshot: { status: 'unreadable', hash: null } }
    state.files.set(canonical, subscription)
    const snapshot = await scan(fs, canonical, config.maxBytes, state.lifecycle.signal)
    retain(state, subscription, initialHash !== undefined && snapshot.hash !== initialHash
      ? { status: 'present', hash: initialHash } : snapshot)
    if (watch) {
      try {
        const close = await fs.watch(target, () => { subscription.dirty = true }, state.lifecycle.signal)
        if (state.lifecycle.signal.aborted) await close()
        else subscription.close = close
      } catch (error: unknown) {
        if (!state.lifecycle.signal.aborted) ctx.logger.warn('Instruction subscription watcher unavailable; boundary scans remain active: %o', error)
      }
    }
  }
  ctx.on('agent/created', async ({ agent }) => {
    if (ctx.get('messageDelivery') === undefined || ctx.get('fs') === undefined) return
    const state = stateFor(agent)
    await enqueue(state, async () => { for (const path of files) await initialize(agent, state, path) })
  })
  ctx.on('instructions/loaded', ({ agent, files: loaded }) => {
    if (ctx.get('messageDelivery') === undefined || ctx.get('fs') === undefined) return
    const state = stateFor(agent)
    void enqueue(state, async () => {
      for (const file of loaded) {
        if (file.baseline === false || file.evidence?.status === 'unavailable') continue
        await initialize(agent, state, file.path, file.hash)
      }
    }).catch(() => { /* The state tail owns diagnostics; emit listeners cannot be awaited. */ })
  })
  ctx.on('instructions/written', ({ agent, file }) => {
    const state = states.get(agent)
    if (state === undefined) return
    // An unavailable write invalidates earlier evidence, even if bytes later repeat.
    if (file.evidence?.status === 'unavailable' || file.hash.length === 0) state.selfWrites.delete(file.path)
    else state.selfWrites.set(file.path, file.hash)
  })
  ctx.on('agent/input-preparing', async ({ agent, signal }) => {
    const state = states.get(agent)
    const delivery = ctx.get('messageDelivery')
    const fs = ctx.get('fs')
    if (state === undefined || delivery === undefined || fs === undefined || agent.status !== 'running') return
    await agentEvents(ctx, agent).serial('instructions/writes-settling', {})
    await enqueue(state, async () => {
      const scanSignal = AbortSignal.any([signal, state.lifecycle.signal])
      let remaining = config.maxBytes
      for (const subscription of state.files.values()) {
        scanSignal.throwIfAborted()
        const current = await scan(fs, subscription.path, remaining, scanSignal)
        if (current.status === 'present') remaining -= current.bytes?.byteLength ?? 0
        const previous = subscription.snapshot
        subscription.dirty = false
        if (previous.hash === current.hash && previous.status === current.status) continue
        if (current.status !== 'present' || state.selfWrites.get(subscription.path) !== current.hash) {
          const result = await delivery.send({
            target: { sessionId: agent.session.id }, messageClass: 'handoff', priority: 'steer',
            operationId: brandString<OperationId>(randomUUID()),
            content: JSON.stringify({ kind: 'instruction-change', path: subscription.path,
              oldHash: previous.hash, newHash: current.hash, status: current.status,
              ...lineChanges(previous, current) }),
          })
          if (result.deliveryOutcome !== 'accepted') {
            ctx.logger.warn('Instruction reminder delivery rejected: %s', result.reason)
            continue
          }
        }
        retain(state, subscription, current)
        state.selfWrites.delete(subscription.path)
      }
    })
  })
  const disposeState = async (agent: Agent, state: AgentState): Promise<void> => {
    state.lifecycle.abort()
    await state.tail
    await Promise.all([...state.files.values()].map(async (entry) => { await entry.close?.() }))
    state.files.clear()
    state.selfWrites.clear()
    states.delete(agent)
  }
  ctx.on('agent/ending', async ({ agent }) => {
    const state = states.get(agent)
    if (state !== undefined) await disposeState(agent, state)
  })
  ctx.effect(() => async () => {
    await Promise.all([...states].map(([agent, state]) => disposeState(agent, state)))
  }, 'instruction-subscriptions.lifecycle')
}
