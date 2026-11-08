/** Password-free connection settings persisted on this host. */
export interface StorageSettings {
  backend: 'local' | 'postgres'
  connectionId: string
}

/** Settings-page state; credentials never cross the read API. */
export interface StorageStatus {
  settings: StorageSettings
  active: 'local' | 'postgres'
  error: string | null
  configPath: string
  connections: { id: string; name: string }[]
  restartRequired: boolean
}

/** Saved database connection selection. */
export interface StorageSettingsInput {
  settings: StorageSettings
}

/** Connection check result, with a single-line driver error on failure. */
export interface ConnectionResult {
  connected: boolean
  error: string | null
}
