/**
 * Product names for the wire protocols a pi-ai route may speak. The pickers
 * show these instead of the schema identifiers (`openai-completions`), which
 * are what `settings.yaml` carries and what the option values stay.
 */

import type { ModelsKey } from './locales.ts'

/** The protocols this page names, keyed by their schema identifier. */
const PROTOCOL_LABEL_KEYS: Readonly<Record<string, ModelsKey>> = {
  'openai-completions': 'protocolOpenAiCompletions',
  'openai-responses': 'protocolOpenAiResponses',
  'anthropic-messages': 'protocolAnthropicMessages',
}

/** Display order: Responses first, Anthropic second, Chat Completions last; unnamed protocols follow. */
const PROTOCOL_ORDER: readonly string[] = ['openai-responses', 'anthropic-messages', 'openai-completions']

/**
 * Sort protocol-keyed items into the page's display order, keeping the
 * adapter's order among protocols the page does not name.
 * @param items - items to sort.
 * @param protocolOf - the schema identifier of an item's protocol.
 * @returns a sorted copy.
 */
export function sortProtocols<T>(items: readonly T[], protocolOf: (item: T) => string): T[] {
  const rank = (item: T): number => {
    const at = PROTOCOL_ORDER.indexOf(protocolOf(item))
    return at === -1 ? PROTOCOL_ORDER.length : at
  }
  return items.toSorted((left, right) => rank(left) - rank(right))
}

/**
 * The picker text for one protocol identifier.
 * @param t - section copy.
 * @param protocol - the schema identifier of the protocol.
 * @returns the product name this page knows the protocol by; a protocol the
 * adapter adds before this page names it shows its identifier, the spelling
 * `settings.yaml` needs anyway.
 */
export function protocolLabel(t: (key: ModelsKey) => string, protocol: string): string {
  const key = PROTOCOL_LABEL_KEYS[protocol]
  return key === undefined ? protocol : t(key)
}
