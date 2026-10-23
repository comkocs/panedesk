/** Explicit worktree policy never deletes, moves or commits a user's tree. */
import type { RegisterSeatWorktreeRequest, SeatTaskEndedRequest, SeatWorktreePolicy, SeatWorktreeRegistration, SeatWorktreeResult } from '@panedesk/dsh-seat'

/** Read-only Git evidence; unknown timestamps cannot establish maturity. */
export interface WorktreeEvidence { verified: boolean; merged: boolean; trackedClean: boolean; lastChangedAt: number | null }

/** Policy operates on an authoritative registration list supplied by its owner. */
export class WorktreePolicy {
  constructor(
    private readonly policy: SeatWorktreePolicy,
    private readonly inspect: (tree: SeatWorktreeRegistration) => Promise<WorktreeEvidence>,
    private readonly authorize: (request: RegisterSeatWorktreeRequest) => Promise<boolean>,
  ) {}

  /** Admit an explicitly registered tree only after read-only verification.
   * @param request - tree identity and optionally authorized force reason.
   * @param registered - existing committed registrations.
   * @returns proposed registration or an executable refusal; caller commits acceptance.
   */
  async register(request: RegisterSeatWorktreeRequest, registered: readonly SeatWorktreeRegistration[]): Promise<SeatWorktreeResult> {
    const tree = request.registration
    if (!(await this.inspect(tree)).verified) return { status: 'rejected', error: {
      code: 'worktree-unverified', message: 'The tree is not present in the repository worktree list.',
      alternative: 'Run git worktree list --porcelain and register an existing tree.', retryable: false, effectState: 'none',
    } }
    const existing = registered.filter(item => item.seat === tree.seat && item.kind === 'client' && item.path !== tree.path)
    if (tree.kind === 'client' && existing.length >= this.policy.clientTreesPerSlot) {
      const authorized = request.force !== undefined && request.force.reason.trim().length > 0 && await this.authorize(request)
      if (!authorized) return { status: 'rejected', error: {
        code: 'worktree-client-limit', message: 'The seat client-tree limit is reached.',
        alternative: `Use the registered tree ${JSON.stringify(existing[0]?.path)} and switch its branch instead.`, retryable: false, effectState: 'none',
      } }
    }
    return { status: 'registered', trees: [tree], alternatives: [] }
  }

  /** Report task-owned trees without taking destructive action.
   * @param request - authorized settlement fact.
   * @param registered - committed explicit registrations.
   * @returns observations with cleanup alternatives for every affected tree.
   */
  onTaskEnded(request: SeatTaskEndedRequest, registered: readonly SeatWorktreeRegistration[]): SeatWorktreeResult {
    const trees = registered.filter(tree => tree.taskId === request.taskId)
    return { status: 'observed', trees, alternatives: trees.map(tree => `Inspect git -C ${shellQuote(tree.path)} status --short before manually moving this tree to your pending-deletion directory.`) }
  }

  /** Report only clean, merged trees with known stale evidence.
   * @param registered - explicit registrations.
   * @param now - trusted wall clock in milliseconds.
   * @returns safe candidates and non-destructive inspection commands.
   */
  async mature(registered: readonly SeatWorktreeRegistration[], now: number): Promise<SeatWorktreeResult> {
    const trees: SeatWorktreeRegistration[] = []
    for (const tree of registered) {
      const evidence = await this.inspect(tree)
      if (evidence.verified && evidence.merged && evidence.trackedClean && evidence.lastChangedAt !== null
        && now - evidence.lastChangedAt >= this.policy.staleHours * 3_600_000) trees.push(tree)
    }
    return { status: 'observed', trees, alternatives: trees.map(tree => `Review git -C ${shellQuote(tree.path)} status --short; this merged tree is eligible for manual recycling.`) }
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
