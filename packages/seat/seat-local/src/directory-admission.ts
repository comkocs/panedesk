/** Single-use traditional-create confirmations bind principal, canonical path and catalog revisions. */
import { randomUUID } from 'node:crypto'
import type { DirectoryChoiceResult, DirectoryConfirmation, ResolveDirectoryChoiceRequest, SeatDefinition, SeatName, SeatPrincipalId } from '@panedesk/dsh-seat'
import { canonicalPath, directoryOwners } from './identity.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'
import { validateLocalPaths } from './paths.ts'

/** Owns confirmation capabilities for one node provider lifetime. */
export class DirectoryAdmission {
  private readonly confirmations = new Map<DirectoryConfirmation['token'], DirectoryConfirmation>()
  constructor(private readonly maxConfirmations: number) {}

  /** Issue a capability only after the trusted consumer has collected a user's choice.
   * @param cwd - selected creation path.
   * @param principalId - authenticated actor.
   * @param definitions - current authorized catalog.
   * @param choice - explicit seat or traditional choice.
   * @returns a single-use capability.
   */
  async confirm(cwd: string, principalId: SeatPrincipalId, definitions: readonly SeatDefinition[], choice: DirectoryConfirmation['choice']): Promise<DirectoryConfirmation> {
    if (this.confirmations.size >= this.maxConfirmations) throw new Error('Directory confirmation capacity reached')
    const owners = await directoryOwners(cwd, definitions)
    if (choice.kind === 'open-seat' && !owners.some(item => item.seat === choice.seat)) throw new Error('Selected seat does not own this directory')
    const confirmation: DirectoryConfirmation = { token: randomUUID() as DirectoryConfirmation['token'], cwd: await canonicalPath(cwd), principalId,
      candidates: owners.map(({ seat, revision }) => ({ seat, revision })), choice }
    this.confirmations.set(confirmation.token, structuredClone(confirmation))
    return confirmation
  }

  /** Reject ambiguous or stale creation before any upstream create side effect.
   * @param request - requested path and optional retained confirmation.
   * @param principalId - authenticated actor, not a wire-provided identity.
   * @param definitions - authorized local definitions.
   * @returns complete choices or an explicit free/seat admission.
   */
  async resolve(request: ResolveDirectoryChoiceRequest, principalId: SeatPrincipalId,
    definitions: readonly SeatDefinition[]): Promise<DirectoryChoiceResult> {
    const refusal = validateLocalPaths([request.cwd])
    if (refusal !== null) return refusal
    const cwd = await canonicalPath(request.cwd)
    const owners = await directoryOwners(cwd, definitions)
    const candidates = owners.map(({ seat, revision }) => ({ seat, revision }))
    if (request.confirmation !== undefined) {
      const retained = this.confirmations.get(request.confirmation.token)
      this.confirmations.delete(request.confirmation.token)
      if (retained === undefined || digest(retained) !== digest(request.confirmation) || retained.cwd !== cwd
        || retained.principalId !== principalId || digest(retained.candidates) !== digest(candidates)) {
        return rejected('seat-choice-required', 'Directory confirmation is missing, consumed or stale.', 'Resolve the directory and confirm its current candidates again.')
      }
      return retained.choice.kind === 'traditional' ? { status: 'allowed', identity: 'free' }
        : { status: 'allowed', identity: 'seat', seat: retained.choice.seat }
    }
    if (owners.length === 0) return { status: 'allowed', identity: 'free' }
    if (request.seat !== undefined && owners.some(owner => owner.seat === request.seat)) return { status: 'allowed', identity: 'seat', seat: request.seat }
    const alternative = owners.map(owner => `panedesk --profile seat open --seat ${shellQuote(owner.seat)}`).join(' OR ')
    return { status: 'choice-required', candidates: candidates.map(item => item.seat), choices: ['open-seat', 'traditional', 'cancel'], alternative }
  }

  /** Revoke all outstanding capabilities when the provider unloads. */
  dispose(): void { this.confirmations.clear() }
}

function shellQuote(value: SeatName): string { return `'${value.replaceAll("'", "'\\''")}'` }
