/** Owner confirmation reads the host controlling terminal, never HTTP or redirected stdin. */
import { closeSync, openSync, writeSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { createInterface } from 'node:readline'
import { authLocale } from './auth-locale.ts'

/** Browser facts shown before a host-local login decision. */
export interface BrowserLoginRequest {
  readonly userAgent: string
  readonly requestedAt: number
  readonly source: string
}

/** The host owns this callback; request data cannot select or replace it. */
export type ConfirmBrowserLogin = (request: BrowserLoginRequest) => boolean | Promise<boolean>

/**
 * Ask through a POSIX controlling terminal; Windows and service launches refuse.
 * @param request - Untrusted browser identification, escaped before terminal output.
 * @param timeoutMs - Maximum owner decision wait, configured by the Host; defaults to one minute.
 * @returns The owner's explicit answer, or false on timeout or when no safe terminal is available.
 */
export function confirmBrowserLogin(request: BrowserLoginRequest, timeoutMs = 60_000): boolean | Promise<boolean> {
  if (process.platform === 'win32' || !process.stdin.isTTY) return false
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') } catch (_error) {
    // Redirected services must opt out explicitly rather than consume piped answers.
    return false
  }
  const escaped = (value: string): string => JSON.stringify(value)
  const facts = `${escaped(request.userAgent)} | ${new Date(request.requestedAt).toISOString()} | ${escaped(request.source)}`
  try {
    writeSync(fd, `${authLocale.en.confirm} / ${authLocale.zh.confirm}\n${facts}\n[y/N] `)
  } catch (_error) {
    closeSync(fd)
    return false
  }
  const input = new ReadStream(fd)
  const reader = createInterface({ input, terminal: false })
  return new Promise<boolean>((resolve) => {
    let decided = false
    const finish = (allowed: boolean): void => {
      if (decided) return
      decided = true
      clearTimeout(timer)
      reader.close()
      input.destroy()
      resolve(allowed)
    }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    reader.once('close', () => { finish(false) })
    input.once('error', () => { finish(false) })
    reader.once('line', (answer) => { finish(answer.trim().toLowerCase() === 'y') })
  })
}
