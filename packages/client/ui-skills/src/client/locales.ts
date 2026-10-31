/** Copy dictionaries for the Skills settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Skills',
  title: 'Skills',
  intro: 'Skills this deployment can use. The list is read-only.',
  load: 'Load skills',
  workspace: 'Workspace',
  hostSkills: 'Built-in and user skills only',
  loading: 'Loading skills…',
  empty: 'No skills were found.',
  loadFailed: 'Loading skills failed',
  retry: 'Retry',
  unavailable: 'Skill listing is not available in this deployment.',
  disabled: 'Skill listing is turned off.',
  denied: 'You do not have permission to list skills.',
  noWorkspace: 'Open a workspace to list its project skills. Built-in and user skills are listed without one.',
  groupBuiltin: 'Built-in',
  groupUser: 'User',
  groupProject: 'Project',
  open: 'Open source file',
  opened: 'Opened the source file.',
  openFailed: 'Opening the source file failed',
  sourcePath: 'Source path',
}

/** The settings.skills namespace key union. */
export type SkillsKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '技能',
  title: '技能',
  intro: '本部署可用的技能。列表只读。',
  load: '加载技能',
  workspace: '工作区',
  hostSkills: '仅内置和用户级技能',
  loading: '正在加载技能…',
  empty: '没有找到技能。',
  loadFailed: '加载技能失败',
  retry: '重试',
  unavailable: '本部署不能列出技能。',
  disabled: '技能列表已关闭。',
  denied: '你没有列出技能的权限。',
  noWorkspace: '打开一个工作区后才能列出它的项目技能。内置技能和用户技能不需要工作区。',
  groupBuiltin: '内置',
  groupUser: '用户级',
  groupProject: '项目级',
  open: '打开源文件',
  opened: '已打开源文件。',
  openFailed: '打开源文件失败',
  sourcePath: '来源路径',
}
