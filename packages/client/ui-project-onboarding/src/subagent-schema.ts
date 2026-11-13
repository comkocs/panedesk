/** Serializable product schema for delegation guidance, shared with configuration forms. */
import z from '@panedesk/schemastery'
import { subagentDefaults } from './subagent-defaults.ts'
import type { DelegationText, SubagentPresets } from './types.ts'

const localized = (value: DelegationText) => z.object({
  zh: z.string().default(value.zh), en: z.string().default(value.en),
}).default(value)
const tier = (key: keyof SubagentPresets['tiers']) => z.object({
  criteria: localized(subagentDefaults.tiers[key].criteria),
  models: z.array(z.object({
    provider: z.string().default(''), model: z.string().default(''), effort: z.string().default(''),
    size: z.union(['all', 'large', 'medium', 'small']).default('all'),
  })).default([]),
  provider: z.string(), model: z.string(), effort: z.string(),
}).default(subagentDefaults.tiers[key])

/** All fields resolve when the product preference has never been saved. */
export const subagentSchema = z.object({
  language: z.union(['zh', 'en']).default(subagentDefaults.language),
  enabled: z.boolean().default(true),
  tiers: z.object({ a: tier('a'), b: tier('b'), c: tier('c') }).default(subagentDefaults.tiers),
  sizes: z.object({
    enabled: z.boolean().default(false),
    large: localized(subagentDefaults.sizes.large),
    medium: localized(subagentDefaults.sizes.medium),
    small: localized(subagentDefaults.sizes.small),
  }).default(subagentDefaults.sizes),
  mainDuties: z.object({
    read: z.boolean().default(true), split: z.boolean().default(true), delegate: z.boolean().default(true),
    review: z.boolean().default(true), merge: z.boolean().default(true), release: z.boolean().default(true),
    report: z.boolean().default(true), small: z.boolean().default(true),
  }).default(subagentDefaults.mainDuties),
  otherMainDuties: z.string().default(''),
  allowNested: z.boolean().default(true),
  nestedCondition: localized(subagentDefaults.nestedCondition),
}).default(subagentDefaults)
