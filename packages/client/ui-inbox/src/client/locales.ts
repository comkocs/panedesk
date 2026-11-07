/** Locale-owned inbox labels use the existing six public message states. */
export const en = {
  title: 'Inbox', close: 'Close', sender: 'Sender seat', time: 'Time', priority: 'Priority', state: 'Status',
  queued: 'Queued', injected: 'Injected', responded: 'Responded', withdrawn: 'Withdrawn', invalidated: 'Invalidated', rejected: 'Rejected',
  immediate: 'Immediate', steer: 'Steer', queue: 'Queue', human: 'Human', unknown: 'Unknown',
  quarantine: 'Isolated messages: {count}', reasons: 'Isolation reasons',
  corrupt: 'Damaged record', 'unsupported-version': 'Unsupported record version', 'invalid-fields': 'Invalid record fields',
  idle: 'Open the inbox to inspect received messages.', loading: 'Loading inbox…', empty: 'No received messages.',
  homePermissions: 'Inbox unavailable: permissions on data directory {path} are too broad. Only the current user, SYSTEM, and Administrators may read and write it.',
  error: 'Inbox unavailable. Check the connection.', unauthorized: 'Owner permission required.', disabled: 'Inbox is disabled.',
  success: 'Inbox is up to date.', failed: 'Refresh failed. Displayed information may be stale.', partial: 'Inbox results are incomplete.',
} satisfies Record<string, string>
/** Typed inbox dictionary keys. */
export type InboxKey = keyof typeof en
/** Chinese product copy shares the complete English key set. */
export const zh = {
  title: '收件', close: '关闭', sender: '发方位', time: '时刻', priority: '优先级', state: '状态',
  queued: '排队中', injected: '已注入', responded: '已回应', withdrawn: '已撤回', invalidated: '已失效', rejected: '已拒绝',
  immediate: '立即', steer: '引导', queue: '排队', human: '人工', unknown: '未知',
  quarantine: '存在隔离消息：{count}', reasons: '隔离原因',
  corrupt: '记录损坏', 'unsupported-version': '记录版本不受支持', 'invalid-fields': '记录字段无效',
  idle: '打开收件以查看收到的消息。', loading: '正在读取收件…', empty: '暂无收到的消息。',
  homePermissions: '收件不可用：数据目录 {path} 的权限过宽，只允许当前用户、SYSTEM 和 Administrators 读写。',
  error: '收件不可用，请检查连接。', unauthorized: '需要所有者权限。', disabled: '收件已禁用。',
  success: '收件已更新。', failed: '刷新失败，所示信息可能已过期。', partial: '收件结果不完整。',
} satisfies Record<InboxKey, string>
