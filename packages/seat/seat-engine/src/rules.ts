/** 外部规则只匹配受信来源与事件类型；没有外部规则的旧档案保持原行为。 */
import type { SeatDefinition, SeatRule, TriggerEnvelope } from '@panedesk/dsh-seat'

/** 选择当前来源适用的首条已启用规则。
 * @param definition - 已冻结或当前档案。
 * @param trigger - 经来源注册表接纳的事件。
 * @returns 精确匹配的规则；未匹配时为空。
 */
export function triggerRule(definition: SeatDefinition, trigger: TriggerEnvelope): SeatRule | undefined {
  return definition.rules.find(rule => rule.enabled && rule.trigger.kind === trigger.kind
    && (rule.trigger.kind !== 'external' || (trigger.evidence.kind === 'external'
      && rule.trigger.sourceId === trigger.sourceId
      && (rule.trigger.eventType === undefined || rule.trigger.eventType === trigger.evidence.eventType))))
}

/** 已配置外部规则却无匹配时不得退回项目自动模式。
 * @param definition - 当前档案。
 * @param trigger - 来源事件。
 * @returns 是否有明确的外部规则限制且未命中。
 */
export function externalRuleMiss(definition: SeatDefinition, trigger: TriggerEnvelope): boolean {
  return trigger.kind === 'external' && definition.rules.some(rule => rule.trigger.kind === 'external')
    && triggerRule(definition, trigger) === undefined
}
