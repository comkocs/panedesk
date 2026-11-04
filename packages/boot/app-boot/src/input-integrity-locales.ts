/** Host input capture failures share actionable diagnostics across admission consumers. */
export const en = {
  captureFailed: 'Protected host input capture failed. Explicitly authorize workspace write access again to capture a new baseline.',
  reviewFailed: 'Protected host input requires owner confirmation before creating an agent. Explicitly authorize workspace write access again to capture a new baseline.',
}

/** Chinese diagnostics use the English key set. */
export const zh = {
  captureFailed: '受保护宿主输入捕获失败。请重新显式授权该工作区写入一次，以重新捕获基线。',
  reviewFailed: '受保护宿主输入复核未通过，无法创建代理。请重新显式授权该工作区写入一次，以重新捕获基线。',
} satisfies Record<keyof typeof en, string>
