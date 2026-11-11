/** Verification settings copy; stable ids remain independent of the display language. */
export const en = {
  title: 'Verification', workspace: 'Workspace', chooseWorkspace: 'Choose a workspace',
  enabled: 'Enabled', enabledHint: 'When disabled, activity is counted but no verification decisions are enforced.',
  preset: 'Preset', default: 'Default', unlimited: 'Unlimited (statistics only)', 'build-only': 'Build only', custom: 'Custom',
  fullTests: 'Full tests', mutation: 'Mutation tests', scripts: 'Self-written scripts', ci: 'Push / CI trigger', focusedTests: 'Focused tests',
  allow: 'Allow', once: 'Once per root turn, including all subagents', deny: 'Deny',
  clientMinutes: 'Client launch wait limit (minutes)', minutes: 'Verification budget (minutes per task)', percent: 'Verification budget (% of task time)',
  limitHint: 'Leave a numeric limit empty for unlimited. Verification includes builds; overlapping script time is counted once.',
  action: 'When the budget is exceeded', ask: 'Ask first', block: 'Block directly',
  approvalHint: 'Approval currently supports allow once or reject. The prompt lists task-wide alternatives, but the approval dialog cannot apply them.',
  save: 'Save', saved: 'Saved for this workspace.', loading: 'Loading verification switches…', error: 'Could not read or save verification switches: {reason}',
  scope: 'Workspace storage only; models cannot edit these switches. Changes apply to subsequent calls.',
  limits: 'External agents and remote CI contents cannot be inspected. Scripts can hide tests; use the self-written script switch and time budget.',
} satisfies Record<string, string>
/** Complete verification locale keys. */
export type VerificationKey = keyof typeof en
/** Chinese counterpart of the complete English dictionary. */
export const zh: Record<VerificationKey, string> = {
  title: '验证', workspace: '工作区', chooseWorkspace: '选择工作区',
  enabled: '启用', enabledHint: '关闭后只统计活动，不执行验证裁决。',
  preset: '预设', default: '缺省', unlimited: '不限（只统计）', 'build-only': '只编译', custom: '自定',
  fullTests: '全量测试', mutation: '变异测试', scripts: '自写脚本运行', ci: '推送触发 CI', focusedTests: '改动面测试',
  allow: '允许', once: '只一次（根会话本轮与全部子代理合计）', deny: '禁止',
  clientMinutes: '启动客户端单次等待上限（分钟）', minutes: '验证用时预算（每任务分钟）', percent: '验证用时预算（占任务用时百分比）',
  limitHint: '数值留空为不限。验证包括编译；自写脚本重叠用时只计一次。',
  action: '预算超线后', ask: '先问我', block: '直接拦',
  approvalHint: '现有审批仅支持单次放行或拒绝。提示会列出任务级选项，但审批框暂不能执行任务级选项。',
  save: '保存', saved: '已为此工作区保存。', loading: '正在读取验证开关…', error: '无法读取或保存验证开关：{reason}',
  scope: '仅存工作区域存储；模型不能修改。更改对后续调用生效。',
  limits: '无法检查外部代理与远端 CI 内容。脚本可能隐藏测试，可使用自写脚本开关及用时预算。',
}
