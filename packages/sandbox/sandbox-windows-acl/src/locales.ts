/** Host-side Windows state diagnostics share typed locale keys without a Client dependency. */
export const en = {
  unsafeState: (directory: string, mask: string) => `Windows owner state is not trusted: the sandbox token can modify ${directory} (access mask ${mask}). First-write approval is refused.`,
  review: 'Back up and review the directory and trustee first; /remove:g removes all explicit allow entries for this trustee.',
  allowEntry: (directory: string, sid: string, mask: string, inherited: boolean) => `Allow ACE: ${directory}; SID=${sid}; mask=${mask}; inherited=${inherited}. Review then remove this trustee’s explicit grants:`,
  unknownTrustee: 'The allow source could not be identified. Inspect the reported directory with icacls.exe and resolve inherited entries at their source. After identifying the exact directory and SID, use: icacls.exe \'<directory>\' /remove:g \'*<SID>\'. Never guess a trustee or remove by SID prefix.',
}

/** Chinese diagnostics have the same keys and arguments as English. */
export const zh = {
  unsafeState: (directory: string, mask: string) => `Windows 所有者状态不可信：沙箱令牌可修改 ${directory}（权限掩码 ${mask}）。已拒绝首次写入审批。`,
  review: '请先备份并核对目录与主体；/remove:g 会移除该主体的全部显式允许项。',
  allowEntry: (directory: string, sid: string, mask: string, inherited: boolean) => `允许项：${directory}；SID=${sid}；掩码=${mask}；继承=${inherited}。核对后移除该主体的显式允许项：`,
  unknownTrustee: '无法确定允许项来源。请用 icacls.exe 检查所报目录，并到继承项来源处理。确认精确目录与 SID 后使用：icacls.exe \'<directory>\' /remove:g \'*<SID>\'。不得猜测主体或按 SID 前缀移除。',
} satisfies typeof en
