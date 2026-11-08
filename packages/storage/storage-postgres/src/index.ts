/** Startup-selected PostgreSQL storage, local fallback, and password-free configuration. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import { z } from 'zod'
import { credentialRef } from '@panedesk/dsh-credentials'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { storageBackendServiceKey, type KvUnitDescriptor, type StorageBackend } from '@panedesk/dsh-storage'
import { foldLedger, validateLedgerEvent, type LedgerEvent, type LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { PostgresStorageBackend } from './backend.ts'
import { migrateLocal } from './migrate.ts'
import type { ConnectionResult, StorageSettings, StorageSettingsInput, StorageStatus } from './types.ts'
export { PostgresStorageBackend } from './backend.ts'
export type * from './types.ts'

const passwordRef = credentialRef('PANEDESK_POSTGRES_PASSWORD')
const settingsSchema = z.object({
  backend: z.enum(['local', 'postgres']), host: z.string(), port: z.number().int().min(1).max(65535),
  database: z.string(), user: z.string(), ssl: z.boolean(),
}).strict()
const defaults: StorageSettings = { backend: 'local', host: '', port: 5432, database: '', user: '', ssl: false }

export interface Config { configPath: string; localRoot: string }

declare module '@panedesk/cordis' {
  interface Context { postgresStorage: PostgresStorage }
}

/** Configuration changes are persisted now and selected only on the next process startup. */
export default class PostgresStorage extends Service {
  static inject = ['storage', 'storage.backend.json', 'credentials']
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

  private async connect(settings: StorageSettings, password?: string): Promise<PostgresStorageBackend> {
    if (!settings.host.trim() || !settings.database.trim() || !settings.user.trim()) throw new Error('Host, database and username are required')
    const secret = password ?? (await this.ctx.credentials.resolve(passwordRef))?.value ?? ''
    const backend = new PostgresStorageBackend({
      host: settings.host, port: settings.port, database: settings.database, user: settings.user,
      password: secret, ssl: settings.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000,
    }, error => { this.error = this.message(error, secret) })
    try { await backend.initialize(); return backend }
    catch (error) { await backend.close(); throw new Error(this.message(error, secret)) }
  }

  private message(error: unknown, password?: string): string {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
    return password ? message.replaceAll(password, '[redacted]') : message
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
      hasPassword: (await this.ctx.credentials.describe(passwordRef)).configured, restartRequired: this.restartRequired }
  }

  /** Persist validated non-secret fields and use the existing credential provider for the password. */
  async save(input: StorageSettingsInput): Promise<StorageStatus> {
    await this.ready
    const settings = settingsSchema.parse(input.settings)
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 })
    await withFileLock(this.configPath, async () => {
      if (input.password !== undefined) {
        if (input.password) await this.ctx.credentials.set(passwordRef, input.password)
        else await this.ctx.credentials.unset(passwordRef)
      }
      await writeFileAtomic(this.configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      this.restartRequired = true
    })
    return this.status()
  }

  /** Check the unsaved form with a short-lived connection, including table creation permissions. */
  async testConnection(input: StorageSettingsInput): Promise<ConnectionResult> {
    try {
      const backend = await this.connect(settingsSchema.parse(input.settings), input.password)
      await backend.close()
      return { connected: true, error: null }
    } catch (error) { return { connected: false, error: this.message(error, input.password) } }
  }

  /** Copy local storage units without replacing existing remote keys; restart to reload imported data. */
  async migrate(): Promise<number> {
    await this.ready
    const backend = await this.connect(await this.readSettings())
    try {
      const count = await migrateLocal(backend.pool, this.config.localRoot, this.descriptors)
      this.restartRequired = true
      return count
    } finally { await backend.close() }
  }

  private async writeLedger(events: readonly LedgerEvent[]): Promise<void> {
    const pool = this.backend!.pool
    for (const event of events) {
      const id = JSON.stringify([event.nodeId, event.eventId])
      const value = JSON.stringify(event)
      const result = await pool.query<{ value: string }>(`INSERT INTO panedesk_ledger (id, value) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET value = panedesk_ledger.value RETURNING value`, [id, value])
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
    const rows = await this.backend.pool.query<{ value: string }>('SELECT value FROM panedesk_ledger ORDER BY id')
    return foldLedger(rows.rows.map(row => validateLedgerEvent(JSON.parse(row.value))), {
      asOf: Date.now(), observationMaxAgeMs: 10000, complete: facts?.complete ?? false,
      ...local ? { localNodeId: await local.nodeId() } : {},
    })
  }
}
