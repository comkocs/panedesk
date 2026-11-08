/** Startup-selected PostgreSQL storage, local fallback, and password-free configuration. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import { z } from 'zod'
import type {} from '@panedesk/dsh-db-connections'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { storageBackendServiceKey, type KvUnitDescriptor, type StorageBackend } from '@panedesk/dsh-storage'
import { foldLedger, validateLedgerEvent, type LedgerEvent, type LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { PostgresStorageBackend } from './backend.ts'
import { migrateLocal } from './migrate.ts'
import type { ConnectionResult, StorageSettings, StorageSettingsInput, StorageStatus } from './types.ts'
export { PostgresStorageBackend } from './backend.ts'
export type * from './types.ts'

const settingsSchema = z.object({
  backend: z.enum(['local', 'postgres']), connectionId: z.string(),
}).strict()
const defaults: StorageSettings = { backend: 'local', connectionId: '' }

export interface Config { configPath: string; localRoot: string }

declare module '@panedesk/cordis' {
  interface Context { postgresStorage: PostgresStorage }
}

/** Configuration changes are persisted now and selected only on the next process startup. */
export default class PostgresStorage extends Service {
  static inject = ['storage', 'storage.backend.json', 'databaseConnections']
  static Config = Schema.object({
    configPath: Schema.string().default(join(resolveDshHome(), 'storage.json')),
    localRoot: Schema.string().default(join(resolveDshHome(), 'storages')),
  })
  private readonly configPath: string
  private settings: StorageSettings = { ...defaults }
  private active: 'local' | 'postgres' = 'local'
  private error: string | null = null
  private restartRequired = false
  private backend: PostgresStorageBackend | undefined
  private readonly descriptors = new Map<string, KvUnitDescriptor>()
  private mirrorTail: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'postgresStorage')
    this.configPath = resolve(config.configPath)
    this.ready = this.initialize()
    ctx.effect(() => this.ready.then(() => async () => {
      await this.mirrorTail
      await this.backend?.close()
    }))
  }

  private async readSettings(): Promise<StorageSettings> {
    try { return settingsSchema.parse(JSON.parse(await readFile(this.configPath, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }
      throw error
    }
  }

  private async connect(settings: StorageSettings): Promise<PostgresStorageBackend> {
    if (settings.backend !== 'postgres') throw new Error('Select a saved database connection first')
    const connection = await this.ctx.databaseConnections.open(settings.connectionId)
    const backend = new PostgresStorageBackend(connection, error => { this.error = this.message(error) })
    try { await backend.initialize(); return backend }
    catch (error) { await backend.close(); throw error }
  }

  private message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
  }

  private async initialize(): Promise<void> {
    try {
      this.settings = await this.readSettings()
      if (this.settings.backend === 'postgres') {
        this.backend = await this.connect(this.settings)
        this.active = 'postgres'
      }
    } catch (error) { this.error = this.message(error) }
    const selected = this.backend ?? this.ctx.storage.backend.get('json')
    const routed: StorageBackend = {
      kv: { open: descriptor => {
        this.descriptors.set(descriptor.name, descriptor)
        return selected.kv!.open(descriptor)
      } },
      close: () => this.backend?.close() ?? Promise.resolve(),
    }
    this.ctx.effect(() => this.ctx.storage.backend.register('postgres', routed))
    this.ctx.provide(storageBackendServiceKey('postgres'), routed)
    this.ctx.provide('ledgerMirror', { append: event => this.appendLedger(event), snapshot: () => this.ledgerSnapshot() })
  }

  /** Return settings and connection status without returning the stored credential. */
  async status(): Promise<StorageStatus> {
    await this.ready
    let settings = this.settings
    try { settings = await this.readSettings() }
    catch (error) { this.error = this.message(error) }
    return { settings, active: this.active, error: this.error, configPath: this.configPath,
      connections: (await this.ctx.databaseConnections.listConnections()).map(({ id, name }) => ({ id, name })),
      restartRequired: this.restartRequired }
  }

  /** Persist the selected saved connection without copying configuration or credentials. */
  async save(input: StorageSettingsInput): Promise<StorageStatus> {
    await this.ready
    const settings = settingsSchema.parse(input.settings)
    if (settings.backend === 'postgres') await this.ctx.databaseConnections.getConfig(settings.connectionId)
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 })
    await withFileLock(this.configPath, async () => {
      await writeFileAtomic(this.configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      this.restartRequired = true
    })
    return this.status()
  }

  /** Probe the selected connection with SELECT 1 only, without creating storage tables. */
  async testConnection(input: StorageSettingsInput): Promise<ConnectionResult> {
    try {
      const settings = settingsSchema.parse(input.settings)
      if (settings.backend !== 'postgres') throw new Error('Select a saved database connection first')
      const connection = await this.ctx.databaseConnections.open(settings.connectionId)
      try { await connection.client.query('SELECT 1') } finally { await connection.close() }
      return { connected: true, error: null }
    } catch (error) { return { connected: false, error: this.message(error) } }
  }

  /** Copy local storage units without replacing existing remote keys; restart to reload imported data. */
  async migrate(): Promise<number> {
    await this.ready
    const backend = await this.connect(await this.readSettings())
    try {
      const count = await migrateLocal(backend.client, this.config.localRoot, this.descriptors)
      this.restartRequired = true
      return count
    } finally { await backend.close() }
  }

  private async writeLedger(events: readonly LedgerEvent[]): Promise<void> {
    const pool = this.backend!.client
    for (const event of events) {
      const id = JSON.stringify([event.nodeId, event.eventId])
      const value = JSON.stringify(event)
      const result = await pool.query<{ value: string }>(`INSERT INTO panedesk.ledger (id, value) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET value = ledger.value RETURNING value`, [id, value])
      if (result.rows[0]?.value !== value) throw new Error('Conflicting PostgreSQL ledger event')
    }
  }

  private appendLedger(event: LedgerEvent): void {
    if (!this.backend) return
    this.mirrorTail = this.mirrorTail.then(() => this.writeLedger([event])).catch(error => { this.error = this.message(error) })
  }

  private async ledgerSnapshot(): Promise<LedgerSnapshot | undefined> {
    await this.ready
    if (!this.backend) return undefined
    await this.mirrorTail
    const local = this.ctx.get('sessionLedger')
    const facts = await local?.facts()
    // Reconcile retained local facts before reading, covering restarts and interrupted mirror writes.
    if (facts) await this.writeLedger(facts.events)
    const rows = await this.backend.client.query<{ value: string }>('SELECT value FROM panedesk.ledger ORDER BY id')
    return foldLedger(rows.rows.map(row => validateLedgerEvent(JSON.parse(row.value))), {
      asOf: Date.now(), observationMaxAgeMs: 10000, complete: facts?.complete ?? false,
      ...local ? { localNodeId: await local.nodeId() } : {},
    })
  }
}
