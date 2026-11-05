/** Actionable launch-budget reports use the host's paired diagnostic dictionaries. */
export const en = {
  crowdedAncestor: (path: string, count: number): string => `Cannot start the sandbox: ancestor directory ${JSON.stringify(path)} contains ${count} entries and its readable-sibling grants exceed the execve argument budget. Remove expired temporary entries from that directory or move the workspace and private paths out of the crowded directory. The command was not started; unconfined execution is not permitted.`,
}

/** Chinese diagnostics use the English key set. */
export const zh = {
  crowdedAncestor: (path: string, count: number): string => `无法启动沙箱：祖先目录 ${JSON.stringify(path)} 含 ${count} 项，其可读兄弟项授权超过 execve 参数预算。请清理该目录中过期的临时项，或将工作区与私密路径移出拥挤目录。命令未启动，不允许降级为无沙箱执行。`,
} satisfies Record<keyof typeof en, typeof en.crowdedAncestor>
