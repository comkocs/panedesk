/** Host input capture failures share actionable diagnostics across admission consumers. */
export const en = {
  captureFailed: 'Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline.',
  reviewFailed: 'Protected host input requires owner confirmation before creating an agent. Explicitly authorize workspace write access again to capture a new baseline.',
  authorityStructureFailed: 'Protected authoritative home tree has unsafe structure. Restore a real, owner-controlled directory with links confined to that tree before authorizing workspace writes again.',
}

/** Chinese diagnostics use the English key set. */
export const zh = {
  captureFailed: '受保护宿主输入捕获失败。请重新显式授权该工作区写入一次，以重新捕获基线。',
  reviewFailed: '受保护宿主输入复核未通过，无法创建代理。请重新显式授权该工作区写入一次，以重新捕获基线。',
  authorityStructureFailed: '受保护的宿主权威树结构不安全。请恢复本用户控制的真实目录，并将链接限制在该树内，再重新授权工作区写入。',
} satisfies Record<keyof typeof en, string>
