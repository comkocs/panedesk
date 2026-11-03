/** Explicit unresolved tool evidence and the local-only native sandbox prerequisite. */
export const pendingAdmissionEvidence = [
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_act', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_extract', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_navigate', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_observe', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_screenshot', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-experimental-browser-use-stagehand-native:stagehand_tabs', reason: 'Live browser acquisition has no confined execution evidence.' },
  { key: '@panedesk/dsh-tool-seat:seat_renew', reason: 'The real renewal path has no model-free execution evidence.' },
  { key: '@panedesk/dsh-tool-seat:seat_replace', reason: 'Queued replacement and provider replay are covered; completed replacement has no model-free execution evidence.' },
] as const

/**
 * Permit a local prerequisite skip unless native CI evidence is explicitly required.
 * @param requirement - Value of PANEDESK_CI_NATIVE_SANDBOX; only required forbids a skip.
 * @param available - Result of the real prerequisite probe.
 * @param prerequisite - Executable required by this evidence cell.
 * @returns Whether the native execution cell can run.
 */
export function requireAdmissionSandbox(requirement: string | undefined, available: boolean, prerequisite = 'bubblewrap'): boolean {
  if (available) return true
  if (requirement === 'required') throw new Error(`PANEDESK_CI_NATIVE_SANDBOX=required needs usable ${prerequisite}; refusing to skip.`)
  return false
}
