/** Browser-safe reasoning defaults for models outside the installed provider catalog. */

import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

/** Model identity and protocol facts available to both configuration and model resolution. */
export interface ReasoningModelHint {
  id: string
  name?: string | undefined
  api?: string | undefined
  supportsReasoningEffort?: boolean | undefined
}

/**
 * Infer effort spellings without replacing an explicit model declaration.
 * @param model - model id, display name, protocol, and endpoint capability override.
 * @returns inferred levels and unchanged wire spellings, or false when effort support is unknown.
 */
export function inferReasoningEfforts(model: ReasoningModelHint): false | Partial<Record<ModelThinkingLevel, string>> {
  const identities = [model.id, model.name ?? ''].map(value => value.toLowerCase())
  if (identities.some(value => /image|tts|embedding|audio|speech|whisper|transcri|dall-e|sora|video/.test(value))) return false
  if (model.supportsReasoningEffort === false) return false
  const matches = (pattern: RegExp): boolean => identities.some(value => pattern.test(value))
  let levels: readonly ModelThinkingLevel[]
  if (matches(/(?:^|[\s/:])(?:gpt-|o\d|claude-|grok-|(?:astra|sol|terra|luna)[\s\d.-])/)) {
    levels = ['low', 'medium', 'high', 'xhigh']
  } else if (matches(/(?:^|[\s/:])(?:glm|deepseek|gemini)-/)
    && model.supportsReasoningEffort === true) {
    levels = ['low', 'medium', 'high']
  } else {
    return false
  }
  return Object.fromEntries(levels.map(level => [level, level]))
}
