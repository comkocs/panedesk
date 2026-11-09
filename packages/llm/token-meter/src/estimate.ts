/**
 * Fixed-density heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers.
 *
 * @module @panedesk/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@panedesk/dsh-llm'
import type { EpochHeader } from '@panedesk/dsh-session'

/**
 * Estimate CJK scripts and fullwidth punctuation at one token per character;
 * other Unicode characters at four per token.
 * @param text - text to price without mutation.
 * @returns rounded-up heuristic text tokens.
 */
export function estimateText(text: string): number {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u.test(character)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed. Image offload marks do not
 * change this reference-only heuristic; route pricing owns their placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + estimateText(JSON.stringify(reference))
  }
  return BLOCK_OVERHEAD + estimateText(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateText(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateText(block.name)
          + estimateText(block.arguments)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let text = ''
  for (const block of message.content) {
    text += block.type === 'text' ? block.text : JSON.stringify(block)
  }
  return estimateText(text) + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateText(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}
