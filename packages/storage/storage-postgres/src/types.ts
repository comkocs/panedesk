/** Password-free connection settings persisted on this host. */
export interface StorageSettings {
  backend: 'local' | 'postgres'
  host: string
  port: number
  database: string
  user: string
  ssl: boolean
}

/** Settings-page state; credentials never cross the read API. */
export interface StorageStatus {
  settings: StorageSettings
  active: 'local' | 'postgres'
  error: string | null
  configPath: string
  hasPassword: boolean
  restartRequired: boolean
}

/** Explicit credential update; omission retains the stored password. */
export interface StorageSettingsInput {
  settings: StorageSettings
  password?: string
}

/** Connection check result, with a single-line driver error on failure. */
export interface ConnectionResult {
  connected: boolean
  error: string | null
}
