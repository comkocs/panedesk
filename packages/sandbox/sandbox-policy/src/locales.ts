/** Host-visible workspace notices retain equivalent English and Chinese guidance. */
export const en = {
  inspectionFailed: 'Could not inspect existing workspace write access. No consent was created. Review the failure and refresh Settings > General > Windows workspace write access:',
  readOnly: 'Windows defaults to read-only. The owner can preauthorize the workspace in Settings > General > Windows workspace write access. Unattended tasks cannot grant this access. An explicit read-only session choice still applies after preauthorization.',
  legacyWrite: 'This workspace has write access left by an older version. Revoke it in Settings > General > Windows workspace write access. Stop active workspace processes before revoking; existing handles are not closed.',
}

/** Chinese workspace notices use the English key set. */
export const zh = {
  inspectionFailed: '无法检查已有工作区写权限。未创建同意记录。请核对故障，并刷新设置 > 通用 > Windows 工作区写权限：',
  readOnly: 'Windows 默认只读。所有者可在设置 > 通用 > Windows 工作区写权限中预授权。无人值守任务不能授予此权限。预授权后，显式选择的只读模式仍然生效。',
  legacyWrite: '该工作区有旧版留下的写权限。请在设置 > 通用 > Windows 工作区写权限中撤销。撤销前请停止工作区活动进程；已有句柄不会被关闭。',
} satisfies Record<keyof typeof en, string>
