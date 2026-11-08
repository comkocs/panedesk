/** Public connection metadata; secrets never cross the read API. */
export interface DatabaseConnection {
  id: string
  name: string
  host: string
  port: number
  user: string
  database: string
  ssl: boolean
  modelEnabled: boolean
  ssh: {
    enabled: boolean
    host: string
    port: number
    user: string
    privateKeyPath: string
  }
}

/** Empty secrets clear stored values; omitted secrets preserve them when editing. */
export interface ConnectionInput extends Omit<DatabaseConnection, 'id'> {
  id?: string
  password?: string
  passphrase?: string
}

/** One connection probe; the error retains the driver message on one line. */
export interface ConnectionTest {
  ok: boolean
  error?: string
}
