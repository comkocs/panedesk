/** Append-only timing line for one brand-new Session, written under the harness home. */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** One named stretch of the creation path, in milliseconds. */
export interface NewSessionTimingSegment {
  /** Stable step name, such as `directory` or `publish`. */
  readonly name: string
  /** Elapsed wall time of the step. */
  readonly ms: number
}

/** Recorder handed through one brand-new creation. */
export interface NewSessionTiming {
  /**
   * Run one step and keep its elapsed time.
   * @param name - stable step name written into the timing line.
   * @param step - work whose duration is recorded, including when it rejects.
   * @returns the step result.
   */
  measure<T>(name: string, step: () => Promise<T> | T): Promise<T>
  /**
   * Record the identity once it has been minted.
   * @param sessionId - identity this line belongs to.
   */
  identify(sessionId: string): void
  /**
   * Append the line once. Later calls do nothing, so a follow-up failure still
   * leaves the steps measured before it.
   */
  finish(): void
}

const LOG_LIMIT_BYTES = 1024 * 1024

/**
 * Resolve the harness home the same way the home-paths package does:
 * `$PANEDESK_HOME` when it is non-blank, otherwise `~/.panedesk`.
 * @returns the absolute harness home.
 */
function harnessHome(): string {
  const configured = process.env['PANEDESK_HOME']
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.panedesk')
  return resolve(selected)
}

/** Append one timing line, dropping the older half once the file passes 1 MB. */
function appendTimingLine(line: string): void {
  const directory = join(harnessHome(), 'logs')
  const path = join(directory, 'new-session-timing.log')
  try {
    mkdirSync(directory, { recursive: true })
    let existing = ''
    try {
      if (statSync(path).size > LOG_LIMIT_BYTES) existing = readFileSync(path, 'utf8')
    } catch (absent: unknown) {
      void absent
    }
    if (existing.length > 0) {
      const kept = existing.slice(Math.floor(existing.length / 2))
      const cut = kept.indexOf('\n')
      writeFileSync(path, `${cut === -1 ? '' : kept.slice(cut + 1)}${line}`, 'utf8')
      return
    }
    appendFileSync(path, line, 'utf8')
  } catch (failure: unknown) {
    void failure
  }
}

/**
 * Start one timing line for a brand-new Session.
 * The line is appended when {@link NewSessionTiming.finish} runs, and names
 * each step that took longer than 300 milliseconds.
 * @param workspaceId - Workspace the Session joins, when the request named one.
 * @param clientMs - click-to-request milliseconds measured by the Client, when it sent one.
 * @returns the recorder creation passes through its steps.
 */
export function startNewSessionTiming(
  workspaceId: string | undefined,
  clientMs: number | undefined,
): NewSessionTiming {
  const startedAt = Date.now()
  const segments: NewSessionTimingSegment[] = []
  let sessionId: string | undefined
  let wrote = false
  const finish = (): void => {
    if (wrote) return
    wrote = true
    const totalMs = Date.now() - startedAt
    const slow = segments.filter(segment => segment.ms > 300).map(segment => segment.name)
    const parts = [
      new Date(startedAt).toISOString(),
      `workspace=${workspaceId ?? '-'}`,
      `session=${sessionId ?? '-'}`,
      ...clientMs === undefined ? [] : [`client=${String(clientMs)}`],
      ...segments.map(segment => `${segment.name}=${String(segment.ms)}`),
      `total=${String(totalMs)}`,
      ...slow.length === 0 ? [] : [`slow=${slow.join(',')}`],
    ]
    appendTimingLine(`${parts.join(' ')}\n`)
  }
  return {
    async measure(name, step) {
      const began = Date.now()
      try {
        return await step()
      } finally {
        segments.push({ name, ms: Date.now() - began })
      }
    },
    identify(id) { sessionId = id },
    finish,
  }
}

/** @internal Exported so the line format stays next to its writer. */
export const NEW_SESSION_TIMING_LOG = 'logs/new-session-timing.log'
