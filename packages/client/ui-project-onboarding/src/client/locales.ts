/** Typed copy for project guidance and settings. */
export const zh = {
  title: '项目开窗设置', intro: '选择这个项目收到事件后的开窗方式。之后可在项目设置修改。',
  off: '关', remind: '只提醒', auto: '自动',
  offHint: '不接收触发；手动和远程开窗不受影响。',
  remindHint: '事件进入待开清单，由你确认后开窗。',
  autoHint: '引擎按规则直接开窗，可能产生模型费用。',
  save: '保存', saving: '正在保存…', loading: '正在读取项目设置…',
  retry: '重试', error: '项目设置读取或保存失败，请重试；未保存的选择不会生效。',
  readonly: '没有修改产品设置的权限。', empty: '尚未进入任何项目。进入项目后可在这里修改档位。',
  success: '项目档位已保存。', close: '关闭', start: '用通用工作模式包开局',
  startHint: '将开局向导请求插入当前输入框，不自动发送，也不写项目文件。',
  unavailable: '当前没有可用的会话输入框；可在项目会话中调用 workflow-pack 技能。',
  request: '请调用 workflow-pack 技能，先读 getting-started.md，核对本项目需求，再开始干活。',
} satisfies Record<string, string>

/** Project-guidance dictionary key. */
export type ProjectOnboardingKey = keyof typeof zh

/** English project guidance and settings copy. */
export const en = {
  title: 'Project opening settings', intro: 'Choose how this project opens windows after events. Change it later in project settings.',
  off: 'Off', remind: 'Remind only', auto: 'Automatic',
  offHint: 'Ignore triggers; manual and remote opening remain available.',
  remindHint: 'Queue events for your approval before opening windows.',
  autoHint: 'The engine opens windows according to rules and may incur model charges.',
  save: 'Save', saving: 'Saving…', loading: 'Loading project settings…',
  retry: 'Retry', error: 'Could not read or save project settings. Retry; unsaved choices do not take effect.',
  readonly: 'You do not have permission to change product settings.', empty: 'No project has been entered yet. Enter a project to change its opening mode here.',
  success: 'Project opening mode saved.', close: 'Close', start: 'Start with the workflow pack',
  startHint: 'Insert a getting-started request into the current composer without sending it or writing project files.',
  unavailable: 'No session composer is available. Invoke the workflow-pack skill in a project session.',
  request: 'Invoke the workflow-pack skill, read getting-started.md, and check this project’s requirements before starting work.',
} satisfies Record<ProjectOnboardingKey, string>

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project opening guidance and product preferences. */
    projectOnboarding: ProjectOnboardingKey
  }
}
