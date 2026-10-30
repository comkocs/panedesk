/** Typed seat UI copy; names and provider refusal details remain verbatim data. */
export const en = {
  seat: 'Seat', seats: 'Seats', free: 'Free window', open: 'Open seat', opened: 'Open', unopened: 'Not open',
  busy: 'Busy', idle: 'Idle', unknown: 'Unknown', unavailable: 'Seat data is unavailable.',
  showAlerts: 'Show seat alerts',
  incomplete: 'Seat data is incomplete; opening is disabled.',
  identityLoading: 'Loading identity', identityFailed: 'Identity read failed',
  directoryAmbiguous: 'Select a single main-view Session before opening a seat.',
  directoryRefused: 'The current directory is not registered for this seat. Use profile directory to open it.',
  directoryTitle: 'Choose the startup directory',
  directoryDescription: 'The current directory differs from the seat profile.',
  currentDirectory: 'Current directory', profileDirectory: 'Profile directory',
  profile: 'Use profile directory', here: 'Stay in this directory', cancel: 'Cancel', close: 'Close',
  openFailed: 'Seat opening was refused: {reason}', memoryDenied: 'Memory write refused [{code}]: {reason}',
  engineStopped: 'Seat engine stopped [{code}]. Repair the cause and restart the host; this alert clears when the restarted engine reports no failure.',
  engineRetrying: 'Seat engine is retrying [{code}]. Queued work is retained; this alert clears after a complete successful recovery round.',
  missingPreset: 'Agent preset "{preset}" is unavailable [{code}]; no Session was created. Restore the preset and submit a new opening. This alert clears after that seat opens successfully.',
  modelUnavailable: 'Model "{provider}/{model}" is unavailable [{code}]; this Session failed to open. Other seats continue. Restore the model and resend your message in this Session; this alert clears when model configuration succeeds.',
  liveModelUnavailable: 'Model "{provider}/{model}" is unavailable [{code}]; this window’s turn failed. Other seats and the engine continue. Restore the model and resend your message here; this alert clears after a completed resend or when this runtime is closed.',
  existingChoice: 'This seat already has windows. Select an existing window from Seats before opening another.',
} as const
/** Locale-owned key set. */
export type SeatKey = keyof typeof en
/** Chinese seat UI copy. */
export const zh: Record<SeatKey, string> = {
  seat: '位', seats: '工位', free: '自由窗', open: '按位开', opened: '在开', unopened: '未开',
  busy: '忙', idle: '闲', unknown: '未知', unavailable: '工位数据不可用。',
  showAlerts: '查看工位告警',
  incomplete: '工位数据不完整，暂不能按位开。',
  identityLoading: '身份读取中', identityFailed: '身份读取失败',
  directoryAmbiguous: '请先选定唯一主视图会话，再按位开。',
  directoryRefused: '当前目录未登记到该工位，请选择“改到档案目录”后按位开。',
  directoryTitle: '选择起窗目录', directoryDescription: '当前起窗目录与工位档案目录不同。',
  currentDirectory: '当前目录', profileDirectory: '档案目录',
  profile: '改到档案目录', here: '仍在此开', cancel: '取消', close: '关闭',
  openFailed: '按位开被拒：{reason}', memoryDenied: '记忆写入被拒 [{code}]：{reason}',
  engineStopped: '工位引擎已停止 [{code}]。请修复原因后重启宿主；重启后的引擎报告无故障时，本告警清除。',
  engineRetrying: '工位引擎正在重试 [{code}]，排队工作已保留；完整恢复轮次成功后，本告警清除。',
  missingPreset: '代理预设“{preset}”不可用 [{code}]，未创建会话。请恢复预设后重新提交开窗；该工位成功开窗后，本告警清除。',
  modelUnavailable: '模型“{provider}/{model}”不可用 [{code}]，此会话开窗失败，其他工位继续运行。请恢复模型后在此会话重发消息；模型配置成功后，本告警清除。',
  liveModelUnavailable: '模型“{provider}/{model}”不可用 [{code}]，此窗口回合失败，其他工位与引擎继续运行。请恢复模型后在此窗口重发消息；重发回合成功完成或此运行时关闭后，本告警清除。',
  existingChoice: '该位已有在开会话，请先从工位列表选择已有会话。',
}
