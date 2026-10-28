/** Typed copy for the seat approval surface. */
export const zh = {
  available: '可开 {count} 窗', title: '待批开窗', close: '关闭', approve: '批准', cancel: '取消待批',
  seat: '位', tasks: '单', window: '窗名', node: '节点', budget: '预算', absent: '未提供',
  windowBudget: '单窗 {amount} 微美元', dailyBudget: '每日 {amount} 微美元',
  empty: '暂无待批开窗', partial: '待批列表不完整，暂不可批准；请等待刷新。',
  failed: '读取失败，请检查连接后重新打开。', working: '正在提交',
  approved: '批准已登记，正在等待实际开窗。', opened: '已创建窗口', opening: '窗口已创建，首轮尚未完成。',
  openingFailed: '窗口已创建，但启动失败。请检查引擎诊断。',
  active: '开窗完成', cancelled: '待批已取消', unknown: '结果未知，请等待操作查询；不要重复提交。',
  stale: '待批版本已变更，请检查刷新后的条目再批准。',
  rejected: '操作被拒绝：{code}；{message}', blocked: '已批准但仍等待：{reason}；{blockedBy}',
} satisfies Record<string, string>
/** Seat approval dictionary keys. */
export type ApprovalKey = keyof typeof zh
/** English dictionary checked against the Chinese key set. */
export const en = {
  available: '{count} windows ready for approval', title: 'Pending window approvals', close: 'Close', approve: 'Approve', cancel: 'Cancel pending',
  seat: 'Seat', tasks: 'Tasks', window: 'Window', node: 'Node', budget: 'Budget', absent: 'Not provided',
  windowBudget: 'Window {amount} micro-USD', dailyBudget: 'Daily {amount} micro-USD',
  empty: 'No pending window approvals', partial: 'The queue is incomplete. Approval is unavailable until it refreshes.',
  failed: 'Read failed. Check the connection and reopen this panel.', working: 'Submitting',
  approved: 'Approval recorded. Waiting for an actual window.', opened: 'Window created', opening: 'Window created; its first turn has not finished.',
  openingFailed: 'Window created, but startup failed. Inspect engine diagnostics.',
  active: 'Opening completed', cancelled: 'Pending work cancelled', unknown: 'Outcome unknown. Wait for operation lookup; do not submit again.',
  stale: 'The pending version changed. Review the refreshed item before approving again.',
  rejected: 'Operation refused: {code}; {message}', blocked: 'Approved but waiting: {reason}; {blockedBy}',
} satisfies Record<ApprovalKey, string>
