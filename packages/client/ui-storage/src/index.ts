/** Owner-only storage selection API; connection credentials remain with database connections. */
import type { Context } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from '@panedesk/dsh-storage-postgres'
import type { ConnectionResult, StorageSettingsInput, StorageStatus } from '@panedesk/dsh-storage-postgres/types'

declare module '@panedesk/cordis' {
  interface Context { dataStorage: DataStorageService }
}

/** Owner-authenticated access to storage selection and local-data copying. */
export default class DataStorageService extends TypertRemoteService {
  static inject = ['postgresStorage']
  constructor(ctx: Context) { super(ctx, 'dataStorage') }

  /** Read non-secret configuration and the startup-selected backend.
   * @returns Saved selection, available connections and active backend.
   */
  @Remote
  read(): Promise<StorageStatus> { return this.ctx.postgresStorage.status() }

  /** Save the form; backend selection takes effect after restart.
   * @param input - Selected local backend or saved connection id.
   * @returns Persisted selection and restart status.
   */
  @Remote
  save(input: StorageSettingsInput): Promise<StorageStatus> { return this.ctx.postgresStorage.save(input) }

  /** Check the supplied form without changing the active backend or saving it.
   * @param input - Saved connection selection to probe.
   * @returns Whether SELECT 1 succeeded and any connection error.
   */
  @Remote
  test(input: StorageSettingsInput): Promise<ConnectionResult> { return this.ctx.postgresStorage.testConnection(input) }

  /** Copy existing local units, retaining local files and existing remote keys.
   * @returns Number of newly copied rows.
   */
  @Remote
  migrate(): Promise<number> { return this.ctx.postgresStorage.migrate() }
}
