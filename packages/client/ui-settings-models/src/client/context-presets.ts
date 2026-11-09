/** Context-capacity hints matching the Host model-name presets. */
const presets: readonly (readonly [readonly string[], number])[] = [
  [['sol'], 500_000],
  [['astra'], 262_144],
  [['glm'], 1_048_576],
  [['deepseek'], 1_000_000],
  [['claude', 'opus', 'sonnet', 'haiku'], 1_000_000],
]

/**
 * Resolve a display hint without importing a Host plugin at runtime.
 * @param id - Configured model id, in any casing.
 * @returns Matching capacity, or undefined for an unrecognized model.
 */
export function presetContextWindow(id: string): number | undefined {
  const segments = id.toLowerCase().split(/[^a-z0-9]+/)
  return presets.find(([words]) => words.some(word => segments.includes(word)))?.[1]
}
