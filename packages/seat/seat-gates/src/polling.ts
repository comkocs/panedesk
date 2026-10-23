/** Conservative static sleep recognition never executes a shell or evaluates expressions. */
import { resolve } from 'node:path'
import type { GateContext, SeatFailure } from '@panedesk/dsh-seat'

/** Statically measured sleep invocation; unknown syntax remains unclassified. */
export interface SleepCall { seconds: number }

/** Recognize literal shell, PowerShell and interpreter sleep statements.
 * @param command - untrusted shell text, never evaluated.
 * @returns known sleep statements; ambiguous statements are omitted.
 */
export function recognizeSleeps(command: string): readonly SleepCall[] {
  const statements: string[] = []
  let quote = ''
  let segment = ''
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i)
    if (char === '\\') { segment += char + (command[++i] ?? ''); continue }
    if (quote) { segment += char; if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; segment += char; continue }
    if (';&|\n'.includes(char)) { statements.push(segment.trim()); segment = ''; continue }
    segment += char
  }
  if (quote) return []
  statements.push(segment.trim())
  const result: SleepCall[] = []
  for (const statement of statements) {
    const source = statement.replace(/^timeout\s+(?:--signal=\w+\s+)?\d+(?:\.\d+)?[smhd]?\s+/, '')
    const shell = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)\s*$/.exec(source)
    if (shell) {
      const units: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }
      const multiplier = units[shell[2] ?? '']
      if (multiplier !== undefined) result.push({ seconds: Number(shell[1]) * multiplier })
      continue
    }
    const powershell = /^(?:Start-Sleep)\s+(?:(-Seconds|-Milliseconds)\s+)?(\d+(?:\.\d+)?)\s*$/i.exec(source)
    if (powershell) {
      result.push({ seconds: Number(powershell[2]) / (powershell[1]?.toLowerCase() === '-milliseconds' ? 1000 : 1) })
      continue
    }
    const python = /^python(?:3)?\s+-c\s+(['"])import time;\s*time\.sleep\((\d+(?:\.\d+)?)\)\1$/.exec(source)
    const ruby = /^ruby\s+-e\s+(['"])sleep\s+(\d+(?:\.\d+)?)\1$/.exec(source)
    const match = python ?? ruby
    if (match) result.push({ seconds: Number(match[2]) })
  }
  return result.filter(call => Number.isFinite(call.seconds))
}

/** Replayable classification retains no shell body or file contents. */
export interface PollingState { family: string | null; count: number; callId: string }

/** Compute a polling transition without publishing it before journal commit.
 * @param context - trusted tool invocation and pending-work state.
 * @param previous - committed preceding invocation, if any.
 * @param threshold - resolved consecutive-call limit.
 * @param maxSeconds - resolved per-call sleep duration limit.
 * @returns next observation and actionable refusal when a limit is crossed.
 */
export function checkPolling(context: Extract<GateContext, { hook: 'before-tool-call' }>, previous: PollingState | undefined, threshold: number, maxSeconds: number): { state: PollingState; failure: SeatFailure | null } {
  const args = context.arguments
  const sleeps = typeof args.command === 'string' && ['bash', 'shell', 'Bash'].includes(context.toolName) ? recognizeSleeps(args.command) : []
  const file = args.file_path ?? args.path ?? args.relativePath
  const isRead = ['read', 'Read', 'read_file', 'seat_read'].includes(context.toolName)
  const family = sleeps.length ? 'sleep' : isRead && typeof file === 'string' && context.cwd ? `read:${resolve(context.cwd, file)}` : null
  const state: PollingState = previous?.callId === context.callId ? previous : {
    family: context.hasPendingWork ? family : null,
    count: context.hasPendingWork && family !== null ? (previous?.family === family ? previous.count + 1 : 1) : 0,
    callId: context.callId,
  }
  const tooLong = sleeps.reduce((sum, call) => sum + call.seconds, 0) > maxSeconds
  const code = tooLong ? 'sleep-limit-exceeded' : state.count >= threshold ? 'polling' : null
  return { state, failure: code === null ? null : {
    code, message: tooLong ? 'The requested sleep exceeds the configured limit.' : 'Repeated waiting calls were detected.',
    alternative: 'Use seat_wait with the pending object IDs, then end the turn.', retryable: false, effectState: 'none',
  } }
}
