/** Read-only current-window selection from committed opening, closing and replacement facts. */
import type { EngineCloseData, EngineEffect, EngineOpenData, EngineReplacementData, SeatBinding, SeatMessageWindow, SeatNodeId } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'

/** Project local windows without changing any opening or replacement state.
 * @param effects - one complete committed engine cut.
 * @param nodeId - owning local node.
 * @returns open bindings; independent concurrent windows retain ambiguous primary selection.
 */
export function messageWindows(effects: readonly EngineEffect[], nodeId: SeatNodeId): SeatMessageWindow[] {
  const opened = new Map<SessionId, EngineOpenData>()
  const bindings = new Map<SessionId, SeatBinding>()
  const closed = new Set<SessionId>()
  const closing = new Map<SessionId, EngineCloseData>()
  const replacements = new Map<string, EngineReplacementData>()
  for (const effect of effects) {
    if (effect.kind === 'open/created' || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') {
      opened.set(effect.data.sessionId, effect.data)
    }
    if (effect.kind === 'open/created' || effect.kind === 'open/configured') bindings.set(effect.data.sessionId, effect.data.binding)
    if (effect.kind === 'seat/binding') bindings.set(effect.data.sessionId, effect.data)
    if (effect.kind === 'window/closed') closed.add(effect.data.sessionId)
    if (effect.kind === 'window/closing') closing.set(effect.data.sessionId, effect.data)
    if (effect.kind === 'window/replacement') replacements.set(effect.data.replacementId, effect.data)
  }
  const secondary = new Set<SessionId>()
  for (const replacement of replacements.values()) {
    if (replacement.newSessionId === null) continue
    // The old window remains authoritative until its replacement completes the first turn.
    const handedOver = ['awaiting-old-idle', 'closing-old', 'completed'].includes(replacement.phase)
    secondary.add(handedOver ? replacement.oldSessionId : replacement.newSessionId)
  }
  const windows = [...opened.values()].flatMap((open) => {
    const binding = bindings.get(open.sessionId)
    const close = closing.get(open.sessionId)
    if (close && !close.barrierReleased) return []
    return binding?.kind === 'seat' && binding.nodeId === nodeId && !closed.has(open.sessionId)
      && (open.phase === 'active' || open.phase === 'opening-pending')
      ? [{ seat: binding.seat, sessionId: open.sessionId, nodeId, primary: !secondary.has(open.sessionId) }] : []
  })
  return windows.map(window => ({ ...window, primary: window.primary
    && windows.filter(other => other.seat === window.seat && other.primary).length === 1 }))
}
