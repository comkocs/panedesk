/** Built-package Loader composition for durable frozen ingress without model execution. */
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import Storage from '@panedesk/dsh-storage'
import { DomainFacility } from '@panedesk/dsh-storage-domain'
import { JsonStorageBackend } from '@panedesk/dsh-storage-json'
import { SeatEngine, digest } from '@panedesk/dsh-seat-engine'
import * as Local from '@panedesk/dsh-seat-local'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'
import type * as T from '@panedesk/dsh-seat'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
export const sender = 'sending-node' as T.SeatNodeId, principalId = 'remote-principal' as T.SeatPrincipalId
/** Start both providers from persisted storage through Loader.
 * @param root - Parent-owned private directory retained across processes.
 * @returns Providers, fresh query authority and awaited teardown.
 */
export async function processFixture(root: string) {
  const ctx = new Context(), registry = new ChainBusinessRegistry()
  const backend = new JsonStorageBackend(join(root, 'storage')), facility = new DomainFacility(ctx, { backend: 'json' })
  const nodeId = 'node-a' as T.SeatNodeId
  const definition: T.SeatDefinition = { schemaVersion: 1, revision: 1, seat: 'seat-a' as T.SeatName,
    platform: 'server', node: 'node-a', projectId: 'project-a' as T.SeatProjectId,
    directories: [{ path: root, startup: true }], memoryDirectories: [], opening: { kind: 'text', text: 'Unused local text' },
    openingInstructionFiles: [], agentPreset: 'agent-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'effort-a',
    permissionPreset: 'permission-a', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, autoKeepAlive: false,
    maxActiveSubagents: 4, subagentContextThresholdTokens: 400000, rules: [],
    worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
    remoteAdmission: { allowOpen: true, sourceNodeIds: [sender], sourceIds: ['remote-source' as T.SeatSourceId],
      principalIds: [principalId], methods: [...methods], policyRevision: 1 } }
  const config: T.SeatEngineConfig = { nodeName: 'node-a', nodeAliases: { 'node-a': nodeId }, dedupWindowMs: 1000,
    maxDecisionBytes: 200000, maxSourceBytes: 65536, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
    callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
    ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000 }
  const installed = Promise.withResolvers<undefined>()
  const register = registry.register.bind(registry)
  registry.register = (provider) => {
    const dispose = register(provider)
    if (methods.every(method => registry.resolve(method))) installed.resolve(undefined)
    return dispose
  }
  let engine: SeatEngine | undefined
  try {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', backend)
    ctx.provide('storageDomain', facility)
    ctx.provide('nodeWorkChainBusiness', registry)
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, local: Local, engine: {
      name: 'frozen-process-engine', apply(child: Context) {
        child.effect(() => {
          engine = new SeatEngine(child, { home: root, nodeId, config }, {
            seats: () => child.get('seats'), ledger: () => undefined })
          const current = engine
          return () => current.shutdown()
        })
      },
    } })
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([{ name: 'cordis:engine' }, { name: 'cordis:local', config: {
      directory: root, nodeId, nodeName: 'node-a', nodeAliases: config.nodeAliases, defaults: definition,
      maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536, maxBatchSeats: 10,
      pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed',
    } }]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    await installed.promise
    if (!engine) throw new Error('Engine did not register')
    const current = engine
    const authority: T.SeatCallContext = { principalId: 'local-user' as T.SeatPrincipalId, origin: 'manual', nodeId }
    const seats = ctx.get('seats')!.withAuthority(authority)
    const catalog = await seats.definitions({})
    if (!catalog.definitions.length) {
      await seats.setAuthority({ authority: 'seat-store', authorizationRef: 'local-user' as T.AuthorizationRef,
        expectedRevision: 0, operationId: 'catalog-authority' as T.SeatOperationId })
      const saved = await seats.save({ definition, expectedRevision: 1, operationId: 'catalog-save' as T.SeatOperationId })
      if (saved.status !== 'saved') throw new Error(JSON.stringify(saved))
    }
    const authorize = async (payload: object, operationId: T.SeatOperationId, batch = false) => {
      const entry = current.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId, nodeId,
        sourceNodeId: sender, origin: 'remote', ...(batch ? {} : { seat: definition.seat }), taskIds: [], policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
      const grant = await entry.issuer.check({ operationId, requestDigest: digest(payload) })
      if ('status' in grant) throw new Error('Expected fresh grant')
      return { principalId, nodeId, origin: 'remote' as const, authorization: grant }
    }
    return { ctx, engine: current, registry, definition, authorize,
      close: async () => { await ctx.fiber.dispose(); await facility.closeAll(); await backend.close() } }
  } catch (error) { await ctx.fiber.dispose(); await facility.closeAll(); await backend.close(); throw error }
}
