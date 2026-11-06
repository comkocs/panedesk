/** Host input capture failures share actionable diagnostics across admission consumers. */
export const en = {
  captureFailed: 'Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline.',
  reviewFailed: 'Protected host input requires owner confirmation before creating an agent. Explicitly authorize workspace write access again to capture a new baseline.',
  reviewStalled: 'Protected host input review stalled: no progress within the configured interval (30 seconds by default). Check storage responsiveness and retry; workspace write access remains denied.',
  reviewProgress: (completed: number, total: number) => total < 0
    ? `Reviewing protected host inputs: ${completed} review steps completed; remaining work is being determined.`
    : `Reviewing protected host inputs: ${completed} checked, ${Math.max(0, total - completed)} remaining.`,
  starting: 'Panedesk starting; protected input review precedes application startup.',
  authorityStructureFailed: 'Protected authoritative home tree has unsafe structure. Restore a real, owner-controlled directory with links confined to that tree before authorizing workspace writes again.',
}

/** Chinese diagnostics use the English key set. */
export const zh = {
  captureFailed: '受保护宿主输入捕获失败。请重新显式授权该工作区写入一次，以重新捕获基线。',
  reviewFailed: '受保护宿主输入复核未通过，无法创建代理。请重新显式授权该工作区写入一次，以重新捕获基线。',
  reviewStalled: '受保护宿主输入复核卡住：在配置的间隔内没有进展（缺省 30 秒）。请检查存储响应后重试；工作区写入仍被拒绝。',
  reviewProgress: (completed: number, total: number) => total < 0
    ? `正在复核受保护宿主输入：已完成 ${completed} 个复核步骤；剩余工作量正在确定。`
    : `正在复核受保护宿主输入：已核 ${completed}，还剩 ${Math.max(0, total - completed)}。`,
  starting: 'Panedesk 正在启动；应用启动前先复核受保护输入。',
  authorityStructureFailed: '受保护的宿主权威树结构不安全。请恢复本用户控制的真实目录，并将链接限制在该树内，再重新授权工作区写入。',
} satisfies { [K in keyof typeof en]: (typeof en)[K] }
