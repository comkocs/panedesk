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
