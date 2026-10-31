/** Wire types for the first-run Git Bash discovery Remote. */

/** One probed Windows Git Bash install location; mirrors the bash-local candidate row. */
export interface BashSetupCandidate {
  /** Install family the path belongs to, for example `program-files` or `scoop`. */
  readonly source: string
  /** Absolute path of the discovered `bash.exe`. */
  readonly bashPath: string
}

/** Committed Windows product selection; mirrors the bash-local product config. */
export interface BashSetupConfig {
  /** Whether the Windows product runs the Bash rows instead of the PowerShell rows. */
  readonly enabled: boolean
  /** Absolute path of the Bash executable passed to the executor as `bashPath`. */
  readonly bashPath: string
}

/** One probe read: host platform, what the probe found, and the committed selection. */
export interface BashSetupStatus {
  /** Host platform; the setup row only acts on `win32`. */
  readonly platform: NodeJS.Platform
  /** First install location the probe found, or absent when none exists. */
  readonly probe?: BashSetupCandidate
  /** Committed product selection, or absent when the platform default stands. */
  readonly config?: BashSetupConfig
  /** Current `PANEDESK_BASH_PATH` override, which wins over the committed selection. */
  readonly envOverride?: string
}

/** Response of a committing call: the status after the write settled. */
export type BashSetupWriteResult = BashSetupStatus
