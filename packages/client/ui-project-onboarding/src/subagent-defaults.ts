/** Shared bilingual defaults and labels for advisory delegation preferences. */
import type { VolatileSnapshot } from '@panedesk/cordis'
import type { SubagentPresets, SubagentTier } from './types.ts'

/** Stable task tiers, independent of their localized names. */
export const subagentTiers = ['a', 'b', 'c'] as const
/** Stable size bands, independent of task complexity. */
export const subagentSizes = ['large', 'medium', 'small'] as const

/** Read the released single-model preference as the first all-size choice.
 * @param tier - Validated current or legacy tier preference.
 * @returns A tier containing only criteria and the ordered model list.
 */
export function readSubagentTier(tier: VolatileSnapshot<SubagentTier>): SubagentTier {
  return { criteria: tier.criteria, models: tier.model && !tier.models.length
    ? [{ provider: tier.provider!, model: tier.model, effort: tier.effort!, size: 'all' }]
    : [...tier.models] }
}

/** Stable main-session responsibilities in display and prompt order. */
export const mainDuties = ['read', 'split', 'delegate', 'review', 'merge', 'release', 'report', 'small'] as const

/** Locale-owned labels shared by the form and model-facing instructions. */
export const delegationCopy = {
  zh: {
    tier_a: '甲档', tier_b: '乙档', tier_c: '丙档',
    size_all: '不限体量', size_large: '大', size_medium: '中', size_small: '小',
    sizeRules: '大中小规则', modelPriority: '依次优先',
    duty_read: '读需求与资料', duty_split: '拆任务、写派单', duty_delegate: '按档位派子代理',
    duty_review: '核对子代理回报与改动', duty_merge: '合并改动、解冲突', duty_release: '编译出包、发版',
    duty_report: '写收口、向用户汇报', duty_small: '丙档小改主窗自己做', smallTasks: '丙档小改',
    chooseModel: '按任务自选', defaultEffort: '默认', promptTitle: '子代理派遣预设',
    mainOwns: '这些主窗自己做', delegated: '这些交给子代理', none: '无', other: '其他主窗职责',
    nestedAllowed: '允许子代理再派孙代理。', nestedDenied: '不允许子代理再派孙代理。', condition: '条件',
  },
  en: {
    tier_a: 'Tier A', tier_b: 'Tier B', tier_c: 'Tier C',
    size_all: 'Any size', size_large: 'Large', size_medium: 'Medium', size_small: 'Small',
    sizeRules: 'Task-size rules', modelPriority: 'In priority order',
    duty_read: 'Read requirements and references', duty_split: 'Break down tasks and write assignments', duty_delegate: 'Delegate by tier',
    duty_review: 'Review subagent reports and changes', duty_merge: 'Merge changes and resolve conflicts', duty_release: 'Build, package, and release',
    duty_report: 'Write the wrap-up and report to the user', duty_small: 'Handle small Tier C changes in the main session', smallTasks: 'Small Tier C changes',
    chooseModel: 'Choose according to the task', defaultEffort: 'Default', promptTitle: 'Subagent delegation presets',
    mainOwns: 'The main session handles these itself', delegated: 'Delegate these to subagents', none: 'None', other: 'Other main-session duties',
    nestedAllowed: 'Subagents may delegate to nested subagents.', nestedDenied: 'Subagents must not delegate to nested subagents.', condition: 'Condition',
  },
}

/** Complete defaults also used when no product configuration has been saved. */
export const subagentDefaults: SubagentPresets = {
  language: 'zh',
  enabled: true,
  tiers: {
    a: {
      criteria: {
        zh: '核心逻辑与跨模块联动（状态、协议、存档、账本这类改一处别处必须跟着改），或同一处第二次返工。',
        en: 'Core logic and coupled changes across modules (state, protocols, saved data, or ledgers where one change requires others), or a second rework of the same area.',
      }, models: [],
    },
    b: {
      criteria: {
        zh: '一般功能与界面改动，限在一个模块内，各文件改动彼此独立。',
        en: 'Ordinary feature and UI changes within one module, with independent changes in each file.',
      }, models: [],
    },
    c: {
      criteria: {
        zh: '机械性改动（改名、替换、登记）、查资料、核对、跑固定脚本。',
        en: 'Mechanical changes (renaming, replacements, registration), research, cross-checking, or running fixed scripts.',
      }, models: [],
    },
  },
  sizes: {
    enabled: false,
    large: {
      zh: '预计改动超过 500 行，或涉及 5 个以上文件，或任务书单个模块超过 300 行。',
      en: 'Expected changes exceed 500 lines, involve more than 5 files, or the assignment exceeds 300 lines for one module.',
    },
    medium: {
      zh: '预计改动 100~500 行，或 2~5 个文件。',
      en: 'Expected changes cover 100–500 lines or 2–5 files.',
    },
    small: {
      zh: '预计改动 100 行以内，单个文件。',
      en: 'Expected changes cover at most 100 lines in a single file.',
    },
  },
  mainDuties: { read: true, split: true, delegate: true, review: true, merge: true, release: true, report: true, small: true },
  otherMainDuties: '',
  allowNested: true,
  nestedCondition: {
    zh: '只在子代理自己的任务里需要大范围只读查阅（扫目录、抄数据、读大文件）时派；孙代理只读、不写代码；一般不派。',
    en: 'Delegate only when the subagent’s own task requires broad read-only research (scanning directories, collecting data, or reading large files); nested subagents are read-only and do not write code; normally do not delegate further.',
  },
}
