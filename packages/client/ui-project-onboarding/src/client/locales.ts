/** Typed copy for project guidance and settings. */
export const zh = {
  title: '项目开窗设置', intro: '选择这个项目收到事件后的开窗方式。之后可在项目设置修改。',
  off: '关', remind: '只提醒', auto: '自动',
  offHint: '不接收触发；手动和远程开窗不受影响。',
  remindHint: '事件进入待开清单，由你确认后开窗。',
  autoHint: '引擎按规则直接开窗，可能产生模型费用。',
  save: '保存', saving: '正在保存…', loading: '正在读取项目设置…',
  retry: '重试', error: '项目设置读取或保存失败，请重试；未保存的选择不会生效。',
  compensation: '项目设置未保存。请逐项核对档位恢复结果后再重试。',
  restored: '已恢复原档位和选档状态', conflict: '存在并发修改，已保留；请核对当前档位', failed: '恢复结果不明；请核对引擎状态',
  readonly: '没有修改产品设置的权限。', empty: '尚未进入任何项目。进入项目后可在这里修改档位。',
  success: '项目档位已保存。', close: '关闭', start: '用通用工作模式包开局',
  startHint: '将开局向导请求插入当前输入框，不自动发送，也不写项目文件。',
  unavailable: '当前没有可用的会话输入框；可在项目会话中调用 workflow-pack 技能。',
  request: '请调用 workflow-pack 技能，先读 getting-started.md，核对本项目需求，再开始干活。',
  settingsIntro: '当项目收到事件时，选择不自动开窗、先提醒你确认，或按规则自动开窗。',
  scope: '适用项目', scopeHint: '按项目目录生效，不是全局开关；无需进入项目会话即可修改。',
  project: '选择项目', chooseProject: '选择工作区', settingsEmpty: '还没有工作区。添加工作区后即可在这里设置，无需先开始会话。',
  workspacesLoading: '正在读取工作区…', workspacesError: '工作区列表读取失败；请重新连接后再查看。',
  openingMode: '开窗档位', defaultMode: '缺省：只提醒。首次确认前不会获准自动开窗。',
  immediateSave: '点击档位即保存；保存成功后生效。',
  configuration: '配置文件与引擎', configurationHint: '项目档位写入当前产品档案，不写用户项目目录。',
  settingsFile: '产品配置文件', catalogFile: '工位档案文件',
  catalogHint: '此文件保存本机所有项目的工位定义；当前项目按上方目录匹配，并非每项目单独一份文件。',
  catalogUnavailable: '未挂载本地工位服务，或档案使用非 JSON 存储；当前没有可打开的本地档案文件。',
  openFile: '打开文件', openDirectory: '打开所在目录', directory: '所在目录',
  pathError: '无法打开宿主路径；请确认文件已生成且宿主支持桌面打开，再重试。',
  inspectionLoading: '正在读取文件位置与引擎状态…', inspectionError: '文件位置或引擎状态读取失败；请刷新后再试。',
  engineStatus: '宿主自动开窗引擎', running: '在跑', recovering: '正在恢复，尚未就绪', engineUnavailable: '没在跑或不可用',
  engineUnknown: '状态未确认', refresh: '刷新状态',
  otherSettings: '本页可调项为项目开窗档位；没有单独的项目间隔或路径覆盖项。引擎运行参数由宿主部署配置管理。',
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
  compensation: 'Project settings were not saved. Review each policy restoration before retrying.',
  restored: 'Previous mode and choice state restored', conflict: 'Concurrent change retained; review the current mode', failed: 'Restoration outcome unknown; review engine state',
  readonly: 'You do not have permission to change product settings.', empty: 'No project has been entered yet. Enter a project to change its opening mode here.',
  success: 'Project opening mode saved.', close: 'Close', start: 'Start with the workflow pack',
  startHint: 'Insert a getting-started request into the current composer without sending it or writing project files.',
  unavailable: 'No session composer is available. Invoke the workflow-pack skill in a project session.',
  request: 'Invoke the workflow-pack skill, read getting-started.md, and check this project’s requirements before starting work.',
  settingsIntro: 'When a project receives an event, choose to ignore automatic opening, ask for approval, or open windows according to its rules.',
  scope: 'Project scope', scopeHint: 'Applies to the selected project directory, not globally. No project Session is required.',
  project: 'Select project', chooseProject: 'Choose a workspace', settingsEmpty: 'No workspaces yet. Add a workspace to configure it here without starting a Session.',
  workspacesLoading: 'Loading workspaces…', workspacesError: 'Could not load workspaces. Reconnect and check again.',
  openingMode: 'Opening mode', defaultMode: 'Default: Remind only. Automatic opening is not approved before an explicit choice.',
  immediateSave: 'Selecting a mode saves it immediately; it takes effect after a successful save.',
  configuration: 'Configuration and engine', configurationHint: 'Project modes are saved in the active product profile, never inside the project directory.',
  settingsFile: 'Product configuration file', catalogFile: 'Seat catalog file',
  catalogHint: 'This file stores local seat definitions for all projects. The selected directory identifies matching projects; there is no separate file per project.',
  catalogUnavailable: 'The local seat service is absent or uses non-JSON storage. No local catalog file is available to open.',
  openFile: 'Open file', openDirectory: 'Open containing folder', directory: 'Containing folder',
  pathError: 'Could not open the Host path. Check that the file exists and the Host supports desktop opening, then retry.',
  inspectionLoading: 'Reading file locations and engine status…', inspectionError: 'Could not read file locations or engine status. Refresh to retry.',
  engineStatus: 'Host automatic opening engine', running: 'Running', recovering: 'Recovering, not ready yet', engineUnavailable: 'Stopped or unavailable',
  engineUnknown: 'Status not confirmed', refresh: 'Refresh status',
  otherSettings: 'The project opening mode is the adjustable setting on this page; projects have no separate interval or path override. Host deployment configuration manages engine runtime parameters.',
} satisfies Record<ProjectOnboardingKey, string>

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project opening guidance and product preferences. */
    projectOnboarding: ProjectOnboardingKey
  }
}
