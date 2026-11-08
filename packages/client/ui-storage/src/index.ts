/** Owner-only settings API for the storage backend; passwords have no read method. */
import type { Context } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from '@panedesk/dsh-storage-postgres'
import type { ConnectionResult, StorageSettingsInput, StorageStatus } from '@panedesk/dsh-storage-postgres/types'

declare module '@panedesk/cordis' {
  interface Context { dataStorage: DataStorageService }
}

export default class DataStorageService extends TypertRemoteService {
  static inject = ['postgresStorage']
  constructor(ctx: Context) { super(ctx, 'dataStorage') }

  /** Read non-secret configuration and the startup-selected backend. */
  @Remote
  read(): Promise<StorageStatus> { return this.ctx.postgresStorage.status() }

  /** Save the form; backend selection takes effect after restart. */
  @Remote
  save(input: StorageSettingsInput): Promise<StorageStatus> { return this.ctx.postgresStorage.save(input) }

  /** Check the supplied form without changing the active backend or saving it. */
  @Remote
  test(input: StorageSettingsInput): Promise<ConnectionResult> { return this.ctx.postgresStorage.testConnection(input) }

  /** Copy existing local units, retaining local files and existing remote keys. */
  @Remote
  migrate(): Promise<number> { return this.ctx.postgresStorage.migrate() }
}
