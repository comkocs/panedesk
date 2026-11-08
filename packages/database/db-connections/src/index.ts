/** Host-owned PostgreSQL connections, credential references, and owner-only settings operations. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { Context, Service } from '@panedesk/cordis'
import schema from '@panedesk/schemastery'
import { z } from 'zod'
import pg from 'pg'
import { credentialKey } from '@panedesk/dsh-credentials'
import { dshHomePath, expandHomePath } from '@panedesk/dsh-home-paths'
import { withFileLock, writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import { openTunnel } from './tunnel.ts'
import type { ConnectionInput, ConnectionTest, DatabaseConnection } from './types.ts'
export type * from './types.ts'

declare module '@panedesk/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'database-connections/unauthorized': Record<string, never> }
}

const port = z.number().int().min(1).max(65535)
const connectionSchema = z.object({
  id: z.string().regex(/^db-[a-z0-9-]+$/), name: z.string().trim().min(1),
  host: z.string().trim().min(1), port: port.default(5432), user: z.string().min(1).default('postgres'),
  database: z.string().min(1).default('postgres'), ssl: z.boolean().default(false), modelEnabled: z.boolean().default(false),
  ssh: z.object({ enabled: z.boolean().default(false), host: z.string(), port: port.default(22),
    user: z.string(), privateKeyPath: z.string() }).strict(),
}).strict().refine(value => !value.ssh.enabled || Boolean(value.ssh.host && value.ssh.user && value.ssh.privateKeyPath),
  'SSH server, user and private key path are required')
const catalogSchema = z.array(connectionSchema).refine(rows => new Set(rows.map(row => row.id)).size === rows.length
  && new Set(rows.map(row => row.name)).size === rows.length, 'Connection ids and names must be unique')

/** An open handle belongs to its caller; always close it in a finally block. */
export interface OpenDatabaseConnection {
  client: pg.Client
  close(): Promise<void>
}

/** Location of the non-secret connection catalog. */
export interface Config {
  /** Path to the non-secret saved connection catalog. */
  filename: string
}

declare module '@panedesk/cordis' {
  interface Context { databaseConnections: DatabaseConnections }
  interface Events {
    /**
     * Published after a catalog mutation commits.
     * @mode emit
     */
    'database-connections/changed'(): void
  }
}

/** Shared Host interface for storage adapters and model tools; Remote methods require the owner. */
export default class DatabaseConnections extends TypertRemoteService {
  static inject = ['credentials']
  static Config: schema<Config> = schema.object({ filename: schema.string().default(dshHomePath('database-connections.json')) })
  readonly filename: string
  private readonly lifetime = new AbortController()
  private readonly handles = new Map<string, Set<OpenDatabaseConnection>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'databaseConnections')
    this.filename = resolve(expandHomePath(config.filename))
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.all([...this.handles.keys()].map(id => this.close(id)))
    })
  }

  async [Service.init](): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      try { await readFile(this.filename, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.write([])
      }
      await this.listConnections()
    })
  }

  /** List non-secret configurations for Host consumers. */
  async listConnections(): Promise<DatabaseConnection[]> {
    return catalogSchema.parse(JSON.parse(await readFile(this.filename, 'utf8')))
  }

  /** Resolve non-secret configuration by stable id; missing ids fail explicitly. */
  async getConfig(id: string): Promise<DatabaseConnection> {
    const row = (await this.listConnections()).find(value => value.id === id)
    if (!row) throw new Error('Database connection no longer exists')
    return row
  }

  /** Open a dedicated client and optional SSH forward by id. No connection is opened at boot. */
  async open(id: string, signal?: AbortSignal): Promise<OpenDatabaseConnection> {
    const config = await this.getConfig(id)
    const secrets = await this.secrets(id)
    return this.connect(config, secrets.password, secrets.passphrase, signal)
  }

  /** Close every currently open handle for an id, including its SSH forwards. */
  async close(id: string): Promise<void> {
    await Promise.all([...(this.handles.get(id) ?? [])].map(handle => handle.close()))
  }

  /** Owner settings read, with no password or key content in the response. */
  @Remote
  async inspect(): Promise<{ filename: string; connections: DatabaseConnection[] }> {
    this.owner()
    return { filename: this.filename, connections: await this.listConnections() }
  }

  /** Save one connection; omitted secrets retain stored values and empty strings clear them. */
  @Remote
  async save(input: ConnectionInput): Promise<DatabaseConnection> {
    this.owner()
    const { password, passphrase, ...fields } = input
    const row = connectionSchema.parse({ ...fields, id: input.id ?? `db-${randomUUID()}` })
    await withFileLock(this.filename, async () => {
      const rows = await this.listConnections()
      if (input.id && !rows.some(value => value.id === input.id)) throw new Error('Database connection no longer exists')
      const next = catalogSchema.parse([...rows.filter(value => value.id !== row.id), row])
      const key = credentialKey('db-connections', row.id)
      const previous = await this.ctx.credentials.readRecord(key)
      const old = await this.secrets(row.id)
      const nextPassword = password ?? old.password, nextPassphrase = passphrase ?? old.passphrase
      await this.ctx.credentials.modifyRecord(key, async () => ({ kind: 'api-key',
        ...(nextPassword ? { key: nextPassword } : {}), ...(nextPassphrase ? { env: { SSH_PASSPHRASE: nextPassphrase } } : {}) }))
      try { await this.write(next) }
      catch (error) {
        if (previous) await this.ctx.credentials.modifyRecord(key, async () => previous)
        else await this.ctx.credentials.deleteRecord(key)
        throw error
      }
    })
    this.ctx.emit('database-connections/changed')
    return row
  }

  /** Delete metadata first, then remove the credential and release open connections. */
  @Remote
  async remove(id: string): Promise<void> {
    this.owner()
    await withFileLock(this.filename, async () => {
      await this.getConfig(id)
      const rows = await this.listConnections()
      await this.write(rows.filter(row => row.id !== id))
      try { await this.ctx.credentials.deleteRecord(credentialKey('db-connections', id)) }
      catch (error) { await this.write(rows); throw error }
    })
    this.ctx.emit('database-connections/changed')
    await this.close(id)
  }

  /** Probe an unsaved form without persisting its secrets; the short-lived client is always closed. */
  @Remote
  async test(input: ConnectionInput): Promise<ConnectionTest> {
    this.owner()
    try {
      const { password, passphrase, ...fields } = input
      const row = connectionSchema.parse({ ...fields, id: input.id ?? `db-${randomUUID()}` })
      const old = input.id ? await this.secrets(input.id) : { password: '', passphrase: '' }
      const handle = await this.connect(row, password ?? old.password, passphrase ?? old.passphrase, this.ctx.invocation?.signal)
      try { await handle.client.query('SELECT 1') } finally { await handle.close() }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ') }
    }
  }

  /** Browse Host filenames for private-key selection; no file contents are returned or copied. */
  @Remote
  async browseKeys(path: string): Promise<{ path: string; parent: string; entries: { name: string; path: string; directory: boolean }[] }> {
    this.owner()
    const directory = path ? expandHomePath(path) : homedir()
    if (!isAbsolute(directory)) throw new Error('Choose an absolute Host directory')
    const entries = await readdir(directory, { withFileTypes: true })
    const rows = await Promise.all(entries.map(async entry => {
      const child = join(directory, entry.name)
      const info = entry.isSymbolicLink() ? await stat(child) : entry
      return { name: entry.name, path: child, directory: info.isDirectory() }
    }))
    return { path: directory, parent: dirname(directory), entries: rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) }
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new RemoteError('database-connections/unauthorized', 'Authenticated owner required', {})
  }

  private write(rows: DatabaseConnection[]): Promise<void> {
    return writeFileAtomic(this.filename, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private async secrets(id: string): Promise<{ password: string; passphrase: string }> {
    const record = await this.ctx.credentials.readRecord(credentialKey('db-connections', id))
    if (record && record.kind !== 'api-key') throw new Error('Unexpected database credential format')
    return { password: record?.key ?? '', passphrase: record?.env?.SSH_PASSPHRASE ?? '' }
  }

  private async connect(config: DatabaseConnection, password: string, passphrase: string, signal?: AbortSignal): Promise<OpenDatabaseConnection> {
    const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    lifetime.throwIfAborted()
    const tunnel = config.ssh.enabled ? await openTunnel(config, passphrase, lifetime) : undefined
    const client = new pg.Client({ host: tunnel ? '127.0.0.1' : config.host, port: tunnel?.port ?? config.port,
      user: config.user, password, database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: true, host: config.host, ...(isIP(config.host) ? {} : { servername: config.host }) } : false,
      connectionTimeoutMillis: 15_000 })
    let closing: Promise<void> | undefined
    const handle: OpenDatabaseConnection = { client, close: () => closing ??= (async () => {
      lifetime.removeEventListener('abort', cancel)
      tunnel?.close()
      try { await client.end() } finally {
        const handles = this.handles.get(config.id)
        handles?.delete(handle)
        if (!handles?.size) this.handles.delete(config.id)
      }
    })() }
    const cancel = () => { void handle.close().catch(() => { /* The active query/connect reports the lost transport. */ }) }
    client.on('error', cancel)
    lifetime.addEventListener('abort', cancel, { once: true })
    const handles = this.handles.get(config.id) ?? new Set<OpenDatabaseConnection>()
    handles.add(handle)
    this.handles.set(config.id, handles)
    try {
      lifetime.throwIfAborted()
      await client.connect()
      lifetime.throwIfAborted()
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }
}
