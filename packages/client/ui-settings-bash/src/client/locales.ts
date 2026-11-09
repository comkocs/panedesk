/** Copy for the Windows Git Bash setup row. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  'title': 'Bash 工具(Windows)',
  'description': 'Windows 上检测到 Git Bash 就缺省用它跑 Bash 工具;也可在本行改回 PowerShell。',
  'loading': '正在检查本机的 Git Bash…',
  'error': 'Git Bash 检查失败。可在本行重试。',
  'unsupported': '本行只在 Windows 宿主上适用。',
  'retry': '重试',
  'env.title': '环境变量 PANEDESK_BASH_PATH 已选定 Bash。',
  'env.path': '选定的可执行文件',
  'probe.found': '找到 Git Bash:',
  'probe.write': '一键写入:用这个 Bash 启用 Bash 工具',
  'probe.hint': '检测到后已缺省在用;把确认后的选择写进产品配置可固定它,重启应用后生效。',
  'probe.busy': '正在写入…',
  'probe.failed': '选择没能写入。可在本行重试。',
  'notFound.title': '没有找到 Git Bash 安装。',
  'notFound.step1': '从 https://git-scm.com/download/win 安装 Git for Windows(默认安装位置可被检测)。',
  'notFound.step2': 'Scoop 用户可执行 scoop install git。',
  'notFound.step3': '重新打开本行再探测一次,或手动把 PANEDESK_BASH_PATH 指向你的 bash.exe。',
  'committed.title': 'Bash 工具已由产品配置启用。',
  'committed.path': '选定的可执行文件',
  'committed.restart': '重启应用后生效。',
  'committed.disable': '停用 Bash,改回 PowerShell',
  'committed.busy': '正在改回…',
  'committed.failed': '没能改回 PowerShell。可在本行重试。',
} as const

/** Translation keys shared by the Chinese and English dictionaries. */
export type BashSetupLocaleKey = keyof typeof zh

/** American English dictionary. */
export const en: Record<BashSetupLocaleKey, string> = {
  'title': 'Bash tools (Windows)',
  'description': 'Windows runs a detected Git Bash as the default for the Bash tools; this row switches back to PowerShell.',
  'loading': 'Checking this computer for Git Bash…',
  'error': 'The Git Bash check failed. Retry from this row.',
  'unsupported': 'This row applies to Windows hosts only.',
  'retry': 'Retry',
  'env.title': 'Bash is already selected by the environment variable PANEDESK_BASH_PATH.',
  'env.path': 'Selected executable',
  'probe.found': 'Found Git Bash:',
  'probe.write': 'Use this Bash and enable the Bash tools',
  'probe.hint': 'A detected Git Bash is already the default; writing the confirmed selection pins it, and the change applies after the app restarts.',
  'probe.busy': 'Writing…',
  'probe.failed': 'The selection could not be written. Retry from this row.',
  'notFound.title': 'No Git Bash installation was found.',
  'notFound.step1': 'Install Git for Windows from https://git-scm.com/download/win (the default install location is detected).',
  'notFound.step2': 'Scoop users can run scoop install git.',
  'notFound.step3': 'Reopen this row to probe again, or set PANEDESK_BASH_PATH to your bash.exe manually.',
  'committed.title': 'The Bash tools are enabled by the product configuration.',
  'committed.path': 'Selected executable',
  'committed.restart': 'The change applies after the app restarts.',
  'committed.disable': 'Stop using Bash and switch back to PowerShell',
  'committed.busy': 'Switching back…',
  'committed.failed': 'The switch back to PowerShell failed. Retry from this row.',
}
