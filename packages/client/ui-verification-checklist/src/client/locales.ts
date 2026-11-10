/** Typed English and Chinese verification-checklist copy. */
export const en = {
  title: 'Verification',
  open: 'Open the verification checklist in the right sidebar',
  description: 'Checks submitted for this session and its child sessions, grouped by requirement.',
  empty: 'No verification checklist has been submitted for this session.',
  loading: 'Reading verification settings…',
  failed: 'Verification settings could not be read. Forbidden categories stay unmarked.',
  estimated: 'Estimated {minutes} min',
  actual: 'Actual {time}',
  actualUnknown: 'Actual unknown',
  forbidden: 'Turned off for this workspace',
  undeclared: 'Undeclared',
  prohibitFailed: 'Could not record the prohibition. Check the connection and retry.',
  noTask: 'No current task; this check cannot be turned off.',
} satisfies Record<string, string>

/** Verification-checklist dictionary keys. */
export type VerificationChecklistKey = keyof typeof en

/** Chinese copy has the same complete key set. */
export const zh = {
  title: '验证',
  open: '在右栏打开验证清单',
  description: '本会话及其子会话提交的检查项，按需求标题分组。',
  empty: '本会话还没有提交验证清单。',
  loading: '正在读取验证设置…',
  failed: '无法读取验证设置，被关闭的类别暂不标灰。',
  estimated: '预计 {minutes} 分钟',
  actual: '实际 {time}',
  actualUnknown: '实际未知',
  forbidden: '本工作区已关闭',
  undeclared: '未申报',
  prohibitFailed: '无法记录禁止项，请检查连接后重试。',
  noTask: '没有当前任务，此项无法关闭。',
} satisfies Record<VerificationChecklistKey, string>
