/** Owner-authenticated settings bridge to the Host database connection service. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-db-connections'
import type { ConnectionInput, ConnectionTest, DatabaseConnection } from '@panedesk/dsh-db-connections/types'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'

/** Settings methods retain the database service's owner checks and credential handling. */
export default class DatabaseConnectionSettings extends TypertRemoteService {
  static inject = ['databaseConnections']
  constructor(ctx: Context) { super(ctx, 'databaseConnectionSettings') }

  /** Read saved non-secret connection settings.
   * @returns Catalog location and saved connections.
   */
  @Remote
  inspect(): Promise<{ filename: string; connections: DatabaseConnection[] }> {
    return this.ctx.databaseConnections.inspect()
  }

  /** Save connection settings through the credential-owning service.
   * @param input - Connection settings and optional credential updates.
   * @returns Saved non-secret connection.
   */
  @Remote
  save(input: ConnectionInput): Promise<DatabaseConnection> { return this.ctx.databaseConnections.save(input) }

  /** Delete a connection and release its credentials and open handles.
   * @param id - Saved connection id.
   */
  @Remote
  deleteConnection(id: string): Promise<void> { return this.ctx.databaseConnections.remove(id) }

  /** Probe connection settings without saving them.
   * @param input - Connection settings and optional draft credentials.
   * @returns Connection result.
   */
  @Remote
  test(input: ConnectionInput): Promise<ConnectionTest> { return this.ctx.databaseConnections.test(input) }

  /** Browse filenames without reading private-key contents.
   * @param path - Absolute directory or empty for the home directory.
   * @returns Directory location and entries.
   */
  @Remote
  browseKeys(path: string): Promise<{ path: string; parent: string; entries: { name: string; path: string; directory: boolean }[] }> {
    return this.ctx.databaseConnections.browseKeys(path)
  }
}
