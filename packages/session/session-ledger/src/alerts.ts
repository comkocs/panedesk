/** Safe journal diagnostics use fixed messages instead of retaining arbitrary provider errors. */
import type { LedgerAlert } from './types.ts'

const messages = {
  disconnect: 'The provider stream disconnected.',
  'retry-exhausted': 'The configured retry budget was exhausted.',
  'concurrency-rejected': 'The request was rejected by the concurrency limit.',
  'ledger-unavailable': 'Local accounting is unavailable; dependent dispatch was stopped.',
} as const

/** Replace untrusted error text with a bounded, category-owned message.
 * @param code - Trusted runtime failure category.
 * @param detail - Optional untrusted diagnostic, deliberately excluded from the journal.
 * @returns Safe alert with explicit redaction evidence.
 */
export function makeAlert(code: keyof typeof messages, detail?: string): LedgerAlert {
  return { code, message: messages[code], redacted: detail !== undefined }
}
