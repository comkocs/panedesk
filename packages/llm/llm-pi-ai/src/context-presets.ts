/**
 * Context-window presets matched by model name. A listing endpoint that
 * discloses no capacity and a configuration that writes none still need a
 * trustworthy window for the model families this harness routes most, so
 * resolution consults this table between the configured value and the
 * installed pi-ai catalog.
 *
 * Matching is by name segment, never by provider route: a model id splits on
 * every non-alphanumeric run, lowercases, and hits a preset when one segment
 * equals a listed word. That reaches a family model behind an aggregator route
 * (`gpt` serving `glm-5.3`) while leaving unrelated ids to the route default.
 * The table is one constant so each release can extend it.
 *
 * @module dsh-llm-pi-ai/context-presets
 */

/** Preset context capacities by exact name segment, most specific family first. */
const CONTEXT_WINDOW_PRESETS: readonly (readonly [readonly string[], number])[] = [
  // GPT family sizes diverge by variant: Sol (including `-high`) at 500,000,
  // Astra at the 262,144 route default's own magnitude.
  [['sol'], 500_000],
  [['astra'], 262_144],
  [['glm'], 1_048_576],
  [['deepseek'], 1_000_000],
  [['claude', 'opus', 'sonnet', 'haiku'], 1_000_000],
]

/** Separators between the name segments a preset matches: dashes, dots, underscores. */
const SEGMENT_SEPARATOR = /[^a-z0-9]+/

/**
 * The preset context window for one model id.
 * @param id - model id as configured or listed, any casing.
 * @returns the preset capacity, or `undefined` when no segment matches and the
 *   next resolution layer (installed catalog, then route default) applies.
 */
export function presetContextWindow(id: string): number | undefined {
  const segments = id.toLowerCase().split(SEGMENT_SEPARATOR)
  for (const [words, contextWindow] of CONTEXT_WINDOW_PRESETS) {
    if (words.some(word => segments.includes(word))) return contextWindow
  }
  return undefined
}
