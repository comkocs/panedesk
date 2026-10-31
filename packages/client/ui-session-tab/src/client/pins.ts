/**
 * Pinned entries kept in the browser. A pin is a bookmark: it names a message
 * inside one session and nothing else, so it never changes what a model sees.
 */
import type { SessionId } from '@panedesk/dsh-session/types'

/** Storage key. One document holds every session's pins. */
export const PIN_STORAGE_KEY = 'dsh.session-pins.v1'

/** One pinned message. */
export interface SessionPin {
  readonly sessionId: SessionId
  readonly messageId: string
  /** Wall-clock milliseconds when the pin was stored. */
  readonly pinnedAt: number
}

/** What a read of the pin store produced. */
export type PinRead =
  | { readonly status: 'ready'; readonly pins: readonly SessionPin[] }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error' }

interface PinDocument {
  readonly schemaVersion: 1
  readonly pins: readonly SessionPin[]
}

/** The smallest storage this store needs. */
export interface PinStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Whether one stored value is a pin document this version understands. */
function documentOf(value: unknown): PinDocument | undefined {
  if (typeof value !== 'object' || value === null || !('pins' in value)
    || !('schemaVersion' in value) || value.schemaVersion !== 1) return undefined
  const pins = value.pins
  if (!Array.isArray(pins)) return undefined
  const parsed: SessionPin[] = []
  const candidates: readonly unknown[] = pins
  for (const pin of candidates) {
    if (typeof pin !== 'object' || pin === null) return undefined
    if (!('sessionId' in pin) || typeof pin.sessionId !== 'string') return undefined
    if (!('messageId' in pin) || typeof pin.messageId !== 'string') return undefined
    if (!('pinnedAt' in pin) || typeof pin.pinnedAt !== 'number') return undefined
    parsed.push({ sessionId: pin.sessionId as SessionId, messageId: pin.messageId, pinnedAt: pin.pinnedAt })
  }
  return { schemaVersion: 1, pins: parsed }
}

/**
 * Read every pin, or a named failure when storage cannot be read.
 * @param storage - the browser store, or undefined when none exists.
 * @returns the stored pins, an empty result, or why the read failed.
 */
export function readPins(storage: PinStorage | undefined): PinRead {
  if (storage === undefined) return { status: 'unavailable' }
  let raw: string | null
  try { raw = storage.getItem(PIN_STORAGE_KEY) }
  catch (error) {
    console.error('Pin read failed:', error)
    return { status: 'error' }
  }
  if (raw === null) return { status: 'empty' }
  try {
    const parsed: unknown = JSON.parse(raw)
    const document = documentOf(parsed)
    if (document === undefined) return { status: 'error' }
    return document.pins.length === 0 ? { status: 'empty' } : { status: 'ready', pins: document.pins }
  } catch (error) {
    console.error('Pin document was not readable:', error)
    return { status: 'error' }
  }
}

/**
 * Store one pin, replacing an earlier pin of the same message.
 * @param storage - the browser store.
 * @param pin - the entry to keep.
 * @returns the pins now stored.
 */
export function addPin(storage: PinStorage, pin: SessionPin): readonly SessionPin[] {
  const current = readPins(storage)
  if (current.status === 'error' || current.status === 'unavailable') throw new Error('Pin storage is not writable')
  const kept = current.status === 'ready' ? current.pins.filter(item => item.messageId !== pin.messageId || item.sessionId !== pin.sessionId) : []
  const pins = [...kept, pin]
  storage.setItem(PIN_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, pins }))
  return pins
}

/**
 * Drop one pin.
 * @param storage - the browser store.
 * @param sessionId - session the pin belongs to.
 * @param messageId - message the pin names.
 * @returns the pins still stored.
 */
export function removePin(storage: PinStorage, sessionId: SessionId, messageId: string): readonly SessionPin[] {
  const current = readPins(storage)
  if (current.status === 'error' || current.status === 'unavailable') throw new Error('Pin storage is not writable')
  const pins = current.status === 'ready' ? current.pins.filter(item => item.messageId !== messageId || item.sessionId !== sessionId) : []
  storage.setItem(PIN_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, pins }))
  return pins
}

/** The browser's localStorage when it exists.
 * @returns local storage, or undefined when the browser denies access.
 */
export function browserPinStorage(): PinStorage | undefined {
  try { return globalThis.localStorage }
  catch (_storageDenied) { return undefined }
}
