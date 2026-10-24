/** External rules match trusted sources and event types; definitions without external rules retain existing behavior. */
import type { SeatDefinition, SeatRule, TriggerEnvelope } from '@panedesk/dsh-seat'

/** Select the first enabled rule matching the current source.
 * @param definition - Frozen or current seat definition.
 * @param trigger - Event accepted through the source registry.
 * @returns Exactly matching rule, or undefined when none matches.
 */
export function triggerRule(definition: SeatDefinition, trigger: TriggerEnvelope): SeatRule | undefined {
  return definition.rules.find(rule => rule.enabled && rule.trigger.kind === trigger.kind
    && (rule.trigger.kind !== 'external' || (trigger.evidence.kind === 'external'
      && rule.trigger.sourceId === trigger.sourceId
      && (rule.trigger.eventType === undefined || rule.trigger.eventType === trigger.evidence.eventType))))
}

/** Prevent fallback to project automatic mode when configured external rules do not match.
 * @param definition - Current seat definition.
 * @param trigger - Source event.
 * @returns Whether explicit external restrictions exist without a matching rule.
 */
export function externalRuleMiss(definition: SeatDefinition, trigger: TriggerEnvelope): boolean {
  return trigger.kind === 'external' && definition.rules.some(rule => rule.trigger.kind === 'external')
    && triggerRule(definition, trigger) === undefined
}
