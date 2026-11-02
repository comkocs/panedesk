/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  allowWorkspace: '允许工作区写入',
  workspaceWrite: '允许向目录 {workspace} 写入吗？这会添加 Windows 目录写入 ACL。可在设置 > 通用 > Windows 工作区写权限中撤销。',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  allowWorkspace: 'Allow workspace writes',
  workspaceWrite: 'Allow sandboxed writes to {workspace}? This adds a Windows directory write ACL. Revoke in Settings > General > Windows workspace write access.',
} satisfies Record<ApprovalKey, string>
