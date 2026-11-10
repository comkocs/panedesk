/** Shared display vocabulary and fixed refusal text; this package does not enforce policy. */
export const ACTIVITY_CATEGORIES = {
  write: { en: 'Write code', zh: '写代码' },
  read: { en: 'Read and search', zh: '读与搜' },
  build: { en: 'Build', zh: '编译构建' },
  'test-focused': { en: 'Focused tests', zh: '改动面测试' },
  'test-full': { en: 'Full tests', zh: '全量测试' },
  mutation: { en: 'Mutation tests', zh: '变异测试' },
  client: { en: 'Client / end-to-end', zh: '启动客户端 / 端到端' },
  ci: { en: 'Push / CI trigger', zh: '推送触发 CI' },
  script: { en: 'Self-written script', zh: '自写脚本运行' },
  wait: { en: 'Wait', zh: '等待' },
  model: { en: 'Model', zh: '模型' },
  other: { en: 'Other commands', zh: '其他命令' },
} as const

/** Stable category ids shared by classification, accounting and verification consumers. */
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES

/** Fixed templates for verification consumers; replace only the category placeholder. */
export const ACTIVITY_REFUSAL = {
  zh: '本项目已关闭〈类〉。不要换写法重试,继续做功能;要开请用户到「验证」设置。',
  en: 'This project has turned off <category>. Do not retry it another way; continue with the feature. The user can turn it on in Verification settings.',
} as const
