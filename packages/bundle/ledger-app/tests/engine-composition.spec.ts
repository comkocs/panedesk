import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@panedesk/cordis-plugin-include'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import { loadOverlayPatches } from '@panedesk/dsh-app-boot'
import AgentRegistry from '@panedesk/dsh-agent'
import SessionStore from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import SessionLedger from '@panedesk/dsh-session-ledger'
import LocalMessageDelivery from '@panedesk/dsh-message-delivery-local'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import { hit } from './gate-reader-fixtures.ts'
import { EngineJournal } from '@panedesk/dsh-seat-engine'
import type { EngineEffect } from '@panedesk/dsh-seat'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import * as App from '../src/index.ts'

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      result[entry.name + '/'] = ''
      for (const [name, bytes] of Object.entries(await inventory(join(root, entry.name)))) result[entry.name + '/' + name] = bytes
    } else result[entry.name] = (await readFile(join(root, entry.name))).toString('base64')
  }
  return result
}

it('reads engine commands through the shipped Loader composition without changing the home', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.engine-composition-'))
  const home = join(root, 'home'), maxDecisionBytes = 200000
  const writer = new Context()
  await writer.plugin(SessionLedger, { dshHome: home })
  const nodeId = await writer.sessionLedger.nodeId()
  const journal = new EngineJournal(join(home, 'ledger/engine/v1', nodeId), nodeId, maxDecisionBytes)
  try {
    await journal.ready()
    const effect: EngineEffect = { eventId: 'event-a' as EngineEffect['eventId'], kind: 'queue/pending', data: {
      queueItemId: 'queue-a' as never, seat: 'seat-a' as never, projectId: 'project-a' as never,
      triggerKind: 'manual', action: 'open', sequence: 1, effectiveMode: 'remind', reason: 'approval',
      blockedBy: [], sources: [], relatedTaskIds: [], queuedAt: '2026-01-01T00:00:00Z', stateVersion: 1,
    } }
    const gate = hit(2)
    await journal.commit(() => [effect, gate])
    await journal.close()
    const segment = (await readdir(join(journal.root, 'events')))[0]!
    const input = join(journal.root, 'events', segment), output = join(home, 'not-created.jsonl')
    const before = await inventory(home)
    for (const args of [
      ['engine', 'events'], ['engine', 'pending'], ['engine', 'export', '--format', 'jsonl', '--output', output],
      ['engine', 'verify', '--input', input], ['engine', 'gates'],
    ]) {
      const ctx = new Context(), exit = vi.fn<(code: number) => void>()
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      let ready: (() => void) | undefined
      try {
        ctx.baseUrl = pathToFileURL(root).href + '/'
        await ctx.plugin(Loader)
        Object.assign(ctx.loader.builtins, { include: Include, agents: AgentRegistry, sessions: SessionStore,
          projections: SessionProjectionRegistry, persistence: Persistence, ledger: SessionLedger,
          delivery: LocalMessageDelivery, query: LedgerQuery, app: App })
        provideCmdline(ctx, { args, exit, ready: { onReady(callback) { ready = callback; return () => { ready = undefined } } } })
        const patch = loadOverlayPatches('ledger', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
        const entries = applyEntryPatches([], [...patch,
          { id: 'session-ledger', config: { dshHome: home } },
          { id: 'session-persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
          { id: 'message-delivery', config: { dshHome: home, maxRecordBytes: 1048576, maxContentBytes: 65536,
            maxBatchSize: 100, scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 10, watch: false } },
          { id: 'ledger-app', config: { mode: 'query', engineReader: { home, maxDecisionBytes } } },
        ], (message) => { throw new Error(message) })
        const modules: Record<string, string> = {
          '@panedesk/dsh-session-ledger': 'ledger', '@panedesk/dsh-agent': 'agents', '@panedesk/dsh-session': 'sessions',
          '@panedesk/dsh-session-projection': 'projections', '@panedesk/dsh-session-persistence-jsonl': 'persistence',
          '@panedesk/dsh-message-delivery-local': 'delivery', '@panedesk/dsh-ledger-query': 'query',
          '@panedesk/dsh-ledger-app': 'app',
        }
        for (const entry of entries) {
          expect(modules[entry.name]).toBeDefined()
          entry.name = `cordis:${modules[entry.name]}`
        }
        const profile = join(root, 'cordis.yml')
        await writeFile(profile, JSON.stringify(entries))
        await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
        await ctx.loader.await()
        expect(ctx.get('seatEngine')).toBeUndefined()
        expect(ctx.get('seatEngineQuery')).toBeDefined()
        expect(ctx.get('seatGates')).toBeUndefined()
        expect(ctx.get('seatGatesQuery')).toBeDefined()
        expect(exit).not.toHaveBeenCalled()
        ready!()
        await vi.waitFor(() => { expect(exit).toHaveBeenCalledExactlyOnceWith(0) })
        const text = String(stdout.mock.calls[0]![0])
        const result: unknown = JSON.parse(text)
        if (args[1] === 'events') expect(result).toMatchObject({ effects: [effect, gate], complete: true, watermark: 1 })
        if (args[1] === 'pending') expect(result).toMatchObject({ items: [effect.data], complete: true, watermark: 1 })
        if (args[1] === 'export') expect(result).toMatchObject({ count: 2, complete: true, watermark: 1 })
        if (args[1] === 'verify') expect(result).toMatchObject({ status: 'verified' })
        if (args[1] === 'gates') expect(result).toMatchObject({ complete: true, watermark: 1,
          gates: [{ hitCount: 2, expired: false, limit: { status: 'reached', value: 2, observed: 2 } }] })
        stdout.mockRestore()
        process.stderr.write(JSON.stringify({ command: args.slice(0, 2).join(' '), code: exit.mock.calls[0]![0], output: result }) + '\n')
      } finally { stdout.mockRestore(); await ctx.fiber.dispose() }
      expect(ready).toBeUndefined()
      expect(await inventory(home)).toEqual(before)
    }
    process.stderr.write('Home inventory and file bytes unchanged after all five commands.\n')
  } finally { await journal.close(); await writer.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
