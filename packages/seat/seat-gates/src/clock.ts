/** Clock data is appended to logged output, never inserted into a system prefix. */

/** Instance-owned minute deduplication prevents repeated timestamps in one turn. */
export class SeatClock {
  private readonly turns = new Map<string, number>()
  constructor(private readonly now: () => number, private readonly timeZone: string) {
    new Intl.DateTimeFormat('en', { timeZone }).format(0)
  }

  /** Produce at most one timestamp per turn, with its source and configured zone.
   * @param turnId - trusted current turn identity.
   * @returns tail data for an already logged tool result, or null on repetition.
   */
  stamp(turnId: string): string | null {
    const now = this.now()
    if (this.turns.has(turnId)) return null
    this.turns.set(turnId, Math.floor(now / 60_000))
    return JSON.stringify({ source: 'system-clock', at: new Date(now).toISOString(), timeZone: this.timeZone })
  }

  /** Release deduplication state once the owning turn is settled.
   * @param turnId - settled turn identity.
   */
  release(turnId: string): void { this.turns.delete(turnId) }
}
