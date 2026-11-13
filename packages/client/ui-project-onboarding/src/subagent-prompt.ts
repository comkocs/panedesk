/** Role-specific model guidance rendered from the current product preferences. */
import { delegationCopy, mainDuties, subagentTiers } from './subagent-defaults.ts'
import type { SubagentPresets } from './types.ts'

/** Render advisory delegation rules without changing tool execution policy.
 * @param presets - Current validated product preferences.
 * @param subagent - Whether the requesting session has subagent origin.
 * @returns The role's prompt section, or empty text when disabled.
 */
export function subagentPrompt(presets: SubagentPresets, subagent: boolean): string {
  if (!presets.enabled) return ''
  const language = presets.language
  const copy = delegationCopy[language]
  const lines = [`## ${copy.promptTitle}`]
  if (subagent) {
    lines.push(presets.allowNested ? copy.nestedAllowed : copy.nestedDenied,
      `${copy.condition}: ${presets.nestedCondition[language]}`)
  } else {
    for (const key of subagentTiers) {
      const tier = presets.tiers[key]
      const model = tier.model
        ? `subagent: provider=${JSON.stringify(tier.provider)}, model=${JSON.stringify(tier.model)}, ${tier.effort ? `effort=${JSON.stringify(tier.effort)}` : `effort: ${copy.defaultEffort}`}`
        : copy.chooseModel
      lines.push(`${copy[`tier_${key}`]}: ${tier.criteria[language]} ${model}`)
    }
    lines.push(`${copy.mainOwns}: ${mainDuties.filter(key => presets.mainDuties[key]).map(key => copy[`duty_${key}`]).join('; ') || copy.none}`,
      `${copy.delegated}: ${mainDuties.filter(key => !presets.mainDuties[key]).map(key => key === 'small' ? copy.smallTasks : copy[`duty_${key}`]).join('; ') || copy.none}`)
    if (presets.otherMainDuties) lines.push(`${copy.other}: ${presets.otherMainDuties}`)
  }
  return lines.join('\n')
}
