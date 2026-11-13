/** Role-specific model guidance rendered from the current product preferences. */
import { delegationCopy, mainDuties, readSubagentTier, subagentSizes, subagentTiers } from './subagent-defaults.ts'
import type { VolatileSnapshot } from '@panedesk/cordis'
import type { SubagentModel, SubagentPresets } from './types.ts'

/** Render advisory delegation rules without changing tool execution policy.
 * @param presets - Current validated product preferences.
 * @param subagent - Whether the requesting session has subagent origin.
 * @returns The role's prompt section, or empty text when disabled.
 */
export function subagentPrompt(presets: VolatileSnapshot<SubagentPresets>, subagent: boolean): string {
  if (!presets.enabled) return ''
  const language = presets.language
  const copy = delegationCopy[language]
  const lines = [`## ${copy.promptTitle}`]
  const modelList = (models: readonly SubagentModel[]) => {
    const choices = models.map(model => `subagent: provider=${JSON.stringify(model.provider)}, model=${JSON.stringify(model.model)}, ${model.effort ? `effort=${JSON.stringify(model.effort)}` : `effort: ${copy.defaultEffort}`}`)
    return choices.length ? `${choices.length > 1 ? `${copy.modelPriority}: ` : ''}${choices.join(' → ')}` : copy.chooseModel
  }
  if (subagent) {
    lines.push(presets.allowNested ? copy.nestedAllowed : copy.nestedDenied,
      `${copy.condition}: ${presets.nestedCondition[language]}`)
  } else {
    if (presets.sizes.enabled) {
      lines.push(`${copy.sizeRules}:`)
      for (const size of subagentSizes) lines.push(`${copy[`size_${size}`]}: ${presets.sizes[size][language]}`)
    }
    for (const key of subagentTiers) {
      const tier = readSubagentTier(presets.tiers[key])
      lines.push(`${copy[`tier_${key}`]}: ${tier.criteria[language]}`)
      if (presets.sizes.enabled) {
        for (const size of subagentSizes) {
          lines.push(`${copy[`tier_${key}`]} · ${copy[`size_${size}`]} → ${modelList(tier.models.filter(model => model.size === 'all' || model.size === size))}`)
        }
      } else {
        lines.push(`${copy[`tier_${key}`]} → ${modelList(tier.models)}`)
      }
    }
    lines.push(`${copy.mainOwns}: ${mainDuties.filter(key => presets.mainDuties[key]).map(key => copy[`duty_${key}`]).join('; ') || copy.none}`,
      `${copy.delegated}: ${mainDuties.filter(key => !presets.mainDuties[key]).map(key => key === 'small' ? copy.smallTasks : copy[`duty_${key}`]).join('; ') || copy.none}`)
    if (presets.otherMainDuties) lines.push(`${copy.other}: ${presets.otherMainDuties}`)
  }
  return lines.join('\n')
}
