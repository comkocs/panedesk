/** Shared bilingual defaults and labels for advisory delegation preferences. */
import type { SubagentPresets } from './types.ts'

/** Stable task tiers, independent of their localized names. */
export const subagentTiers = ['a', 'b', 'c'] as const
/** Stable main-session responsibilities in display and prompt order. */
export const mainDuties = ['read', 'split', 'delegate', 'review', 'merge', 'release', 'report', 'small'] as const

/** Locale-owned labels shared by the form and model-facing instructions. */
export const delegationCopy = {
  zh: {
    tier_a: '甲 · 大任务', tier_b: '乙 · 中任务', tier_c: '丙 · 小任务',
    duty_read: '读需求与资料', duty_split: '拆任务、写派单', duty_delegate: '按档位派子代理',
    duty_review: '核对子代理回报与改动', duty_merge: '合并改动、解冲突', duty_release: '编译出包、发版',
    duty_report: '写收口、向用户汇报', duty_small: '丙档小改主窗自己做', smallTasks: '丙档小改',
    chooseModel: '按任务自选', defaultEffort: '默认', promptTitle: '子代理派遣预设',
    mainOwns: '这些主窗自己做', delegated: '这些交给子代理', none: '无', other: '其他主窗职责',
    nestedAllowed: '允许子代理再派孙代理。', nestedDenied: '不允许子代理再派孙代理。', condition: '条件',
  },
  en: {
    tier_a: 'Tier A · large', tier_b: 'Tier B · medium', tier_c: 'Tier C · small',
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
        zh: '改动跨 3 个以上模块，或模块之间有状态、协议、存档依赖（改一处别处必须跟着改），或同一处第二次返工；任务书单个模块超过 300 行也算。',
        en: 'Changes span more than 3 modules, involve state, protocol, or saved-data dependencies between modules (one change requires others), or revisit the same area for a second rework; an assignment exceeding 300 lines for one module also qualifies.',
      }, provider: '', model: '', effort: '',
    },
    b: {
      criteria: {
        zh: '一个模块内的多个文件，改动彼此独立；或任务书单个模块 100~300 行。',
        en: 'Multiple files within one module with independent changes; or an assignment of 100–300 lines for one module.',
      }, provider: '', model: '', effort: '',
    },
    c: {
      criteria: {
        zh: '单个文件的小改、查资料、核对、跑固定脚本；或任务书单个模块 100 行以内。',
        en: 'A small single-file change, research, cross-checking, or running fixed scripts; or an assignment of at most 100 lines for one module.',
      }, provider: '', model: '', effort: '',
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
