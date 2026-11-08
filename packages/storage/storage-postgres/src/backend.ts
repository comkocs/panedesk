/** PostgreSQL storage backend with one live handle per declared unit. */
import type { OpenDatabaseConnection } from '@panedesk/dsh-db-connections'
import { StorageError, UNIT_NAME_RE, type KvFacet, type KvUnitDescriptor, type StorageBackend } from '@panedesk/dsh-storage'
import { initializeSchema } from './schema.ts'
import { PostgresKvUnit } from './unit.ts'

export class PostgresStorageBackend implements StorageBackend {
  readonly client: OpenDatabaseConnection['client']
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }
  private readonly units = new Map<string, Promise<PostgresKvUnit>>()
  private closing: Promise<void> | undefined

  constructor(private readonly connection: OpenDatabaseConnection, onError: (error: Error) => void) {
    this.client = connection.client
    this.client.on('error', onError)
  }

  async initialize(): Promise<void> { await initializeSchema(this.client) }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<PostgresKvUnit> {
    if (this.closing) throw new StorageError('closed', 'postgres backend is closed')
    if (![descriptor.name, ...descriptor.tables].every(name => UNIT_NAME_RE.test(name))) throw new StorageError('malformed-medium', 'Invalid unit or table name')
    if (this.units.has(descriptor.name)) throw new Error(`Unit '${descriptor.name}' is already open`)
    const pending = this.materialize(descriptor)
    this.units.set(descriptor.name, pending)
    void pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materialize(descriptor: KvUnitDescriptor): Promise<PostgresKvUnit> {
    await this.client.query('INSERT INTO panedesk.storage_units (name, version) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [descriptor.name, descriptor.version])
    const result = await this.client.query<{ version: number }>('SELECT version FROM panedesk.storage_units WHERE name = $1', [descriptor.name])
    if (result.rows[0]?.version !== descriptor.version) throw new StorageError('version-mismatch', `Incompatible stored version for unit '${descriptor.name}'`)
    return new PostgresKvUnit(this.client, descriptor, () => this.units.delete(descriptor.name))
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const units = await Promise.allSettled([...this.units.values()])
      await Promise.all(units.flatMap(unit => unit.status === 'fulfilled' ? [unit.value.close()] : []))
      await this.connection.close()
    })()
    return this.closing
  }
}
