/** Append-only timing line for one New Session click, written under the harness home. */

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
   * @param clientElapsedMs - click-to-page milliseconds; when present, also supplies total.
   * @param pageShown - whether navigation displayed its page rather than failing or being superseded.
   */
  finish(clientElapsedMs?: number, pageShown?: boolean): void
  /** Record whether the Host actually created or reused the Session.
   * @param kind - actual result of the Host's reuse decision.
   */
  classify(kind: NewSessionTimingKind): void
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

/** Which New Session click this line records. */
export type NewSessionTimingKind = 'created' | 'reused'

/**
 * Start one timing line for a New Session click.
 * The line is appended when {@link NewSessionTiming.finish} runs, names the
 * click as a fresh creation or a switch to an existing blank, and names each
 * step that took longer than 300 milliseconds.
 * @param workspaceId - Workspace the Session joins, when the request named one.
 * @param clientMs - click-to-request milliseconds measured by the Client, when it sent one.
 * @param kind - whether the click created a Session or switched to a blank one.
 * @returns the recorder the click passes through its steps.
 */
export function startNewSessionTiming(
  workspaceId: string | undefined,
  clientMs: number | undefined,
  kind: NewSessionTimingKind = 'created',
): NewSessionTiming {
  const startedAt = Date.now()
  const segments: NewSessionTimingSegment[] = []
  let sessionId: string | undefined
  let wrote = false
  const finish = (clientElapsedMs?: number, pageShown?: boolean): void => {
    if (wrote) return
    wrote = true
    const totalMs = clientElapsedMs ?? Date.now() - startedAt
    const elapsedClient = clientElapsedMs ?? clientMs
    const slow = segments.filter(segment => segment.ms > 300).map(segment => segment.name)
    const parts = [
      new Date(startedAt).toISOString(),
      `workspace=${workspaceId ?? '-'}`,
      `session=${sessionId ?? '-'}`,
      `kind=${kind}`,
      ...pageShown === undefined ? [] : [`page=${pageShown ? 'shown' : 'not-shown'}`],
      ...elapsedClient === undefined ? [] : [`client=${String(elapsedClient)}`],
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
    classify(value) { kind = value },
    finish,
  }
}

/** @internal Exported so the line format stays next to its writer. */
export const NEW_SESSION_TIMING_LOG = 'logs/new-session-timing.log'
