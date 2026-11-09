/** Human-readable tool preferences and approximate context-cost labels. */
export const zh = {
  title: '工具',
  enableAll: '全部开启',
  subagentsFullTools: '子代理也用主窗全套工具',
  note: '保存后对新会话生效（首次发送消息时读取）。已有会话保持原选择；类型子代理的工具映射不受影响。',
  conditions: '开关不解除工具自身条件：exit_plan_mode 只在计划模式出现；Windows 只提供已选的 bash 或 pwsh。',
  tokens: '约 {count} token（说明与参数）',
  loading: '正在读取工具…',
  failed: '工具或设置读取失败，请重新打开本页。',
  saveFailed: '保存失败，请重新读取设置后再修改。',
  subagent: '把独立任务交给新的子代理。',
  subagent_fork: '复制当前上下文，让子代理另开一条工作线。',
  workflow: '运行由多个步骤组成的工作流。',
  create_goal: '为当前会话建立持续推进的目标。',
  update_goal: '更新会话目标及其状态。',
  get_goal: '查看当前会话的目标。',
  present: '把文件或成果呈现给你查看。',
  ask_user_question: '向你提问并等待选择或回答。',
  exit_plan_mode: '提交计划供你批准，然后结束计划阶段。',
  bash: '通过 Bash 执行命令。',
  pwsh: '通过 PowerShell 执行命令。',
  schedule_create: '创建到时发送消息的提醒。',
  schedule_update: '修改已有提醒。',
  session_new: '打开新会话，可同时发送首条任务。',
  session_rename: '修改会话名称。',
  session_list: '查看顶层会话列表。',
  session_send: '给另一会话发送消息。',
  panedesk_settings: '读取或修改 Panedesk 可编辑设置。',
  browser: '打开网页、查看内容并操作共享浏览器。',
} as const

/** Keys shared by both tool-page dictionaries. */
export type ToolSettingsKey = keyof typeof zh

export const en = {
  title: 'Tools',
  enableAll: 'Enable all',
  subagentsFullTools: 'Give subagents the full tool set',
  note: 'Saved changes apply to new sessions (captured at their first message). Existing sessions keep their selection; typed subagent tool mappings are unchanged.',
  conditions: 'Tool conditions still apply: exit_plan_mode appears only in plan mode; Windows offers only the selected bash or pwsh.',
  tokens: 'About {count} tokens (description and parameters)',
  loading: 'Loading tools…',
  failed: 'Could not read tools or settings. Reopen this page.',
  saveFailed: 'Could not save. Reload settings before editing again.',
  subagent: 'Delegate a separate task to a new subagent.',
  subagent_fork: 'Copy the current context into a separate subagent task.',
  workflow: 'Run a workflow with multiple steps.',
  create_goal: 'Set a continuing goal for this session.',
  update_goal: 'Update the session goal and its status.',
  get_goal: 'Read the current session goal.',
  present: 'Show you files or completed deliverables.',
  ask_user_question: 'Ask you a question and wait for your answer.',
  exit_plan_mode: 'Submit a plan for approval and finish planning.',
  bash: 'Run commands in Bash.',
  pwsh: 'Run commands in PowerShell.',
  schedule_create: 'Create a reminder that sends a message when due.',
  schedule_update: 'Change an existing reminder.',
  session_new: 'Open a new session, optionally with its first task.',
  session_rename: 'Change a session name.',
  session_list: 'List top-level sessions.',
  session_send: 'Send a message to another session.',
  panedesk_settings: 'Read or change editable Panedesk settings.',
  browser: 'Open pages, read content, and operate the shared browser.',
} satisfies Record<ToolSettingsKey, string>

/** Resolve known tool copy; extension tools supply their own description.
 * @param name - Registered model-facing name.
 * @returns A localized description key when this page owns one.
 */
export function toolDescriptionKey(name: string): ToolSettingsKey | undefined {
  return Object.hasOwn(zh, name) ? name as ToolSettingsKey : undefined
}
