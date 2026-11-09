/** Host tool messages selected from the user's locale preference. */
export const en = {
  from: (name: string) => `[From ${name}] `,
  requiresAgent: 'Session operations require a calling agent.',
  modelNotFound: (name: string) => `Configured model not found: ${name}`,
  sessionNotFound: (target: string) => `Top-level session not found: ${target}`,
}

/** Chinese is used when no Host locale preference is available. */
export const zh: typeof en = {
  from: (name: string) => `〔来自 ${name}〕`,
  requiresAgent: '会话操作需要调用方智能体。',
  modelNotFound: (name: string) => `找不到已配置的模型：${name}`,
  sessionNotFound: (target: string) => `找不到顶层会话：${target}`,
}
