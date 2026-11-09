/** Locale-owned profile editor and table import copy. */
export const en = {
  singleMachineAdvanced: 'Advanced (not needed on one machine)',
  sourceOwned: 'This catalog is owned by its import source. Editing and deletion require an explicit transfer.',
  takeover: 'Transfer editing authority', confirmTakeover: 'Confirm transfer', takenOver: 'Editing authority transferred. Reload the profile before editing.',
  takeoverWarning:
    'Transfer this entire catalog from the import source to local profile editing? The authorization is recorded and all definition revisions advance. Later source imports may report conflicts.',
  nav: 'Seat profiles', loading: 'Loading seat profiles…', empty: 'No seat profiles.', refresh: 'Refresh',
  unavailable: 'Seat profiles are unavailable or access was denied. Restore owner access and refresh.',
  save: 'Save profile', saving: 'Working…', saved: 'Profile saved.', failed: 'The operation failed or its outcome is unknown. Refresh before retrying.',
  conflict: 'The catalog or deletion impact changed. Your draft was not overwritten. Refresh and review before retrying.',
  invalid: 'Some fields are invalid. Check JSON fields and the configured presets, model, paths and rules.',
  back: 'Back to profiles', remove: 'Delete profile', confirmRemove: 'Confirm delete', cancel: 'Cancel',
  removeTitle: 'Delete this seat profile?', removeWarning: 'Only the definition will be deleted. These windows stay open and approvals remain pending, but later actions requiring this definition may fail until it is restored.',
  stateVersion: 'State version', stateUnknown: 'State unknown (resume required)', windows: 'Open windows', pending: 'Pending approvals', none: 'None', removed: 'Profile deleted.',
  directories: 'Workspaces (JSON)', memoryDirectories: 'Memory directories (JSON)', opening: 'Opening sentence or file (JSON)',
  openingInstructionFiles: 'Charter / opening required files (JSON)', agentPreset: 'Agent preset', provider: 'Provider', model: 'Model',
  reasoningEffort: 'Reasoning effort', permissionPreset: 'Permission preset', platform: 'Platform', node: 'Node', rules: 'Opening rules (JSON)',
  advanced: 'Opening rules and limits', projectId: 'Project', subscriptions: 'Subscriptions (JSON)', checkpointFiles: 'Checkpoint files (JSON)',
  remoteAdmission: 'Remote admission (JSON, empty to remove)', wakeTemplate: 'Wake template (JSON, empty to remove)', autoKeepAlive: 'Automatic keepalive (true / false)',
  maxOpenSessions: 'Maximum open sessions', maxActiveSubagents: 'Maximum active subagents', contextThresholdTokens: 'Context threshold (empty to remove)',
  subagentContextThresholdTokens: 'Subagent context threshold', pollingThreshold: 'Polling threshold (empty to remove)', maxSleepSeconds: 'Maximum sleep seconds (empty to remove)',
  worktree: 'Worktree policy (JSON)', immutable: 'Seat name, schema version and import source are retained. Saving increments the definition revision.',
  import: 'Import table', sourcePath: 'Host source path', format: 'Format', markdown: 'Markdown', csv: 'CSV', table: 'Markdown table heading (optional)',
  mapping: 'Header → definition field mapping (JSON)', defaults: 'Definition defaults (JSON)', preview: 'Preview table', commit: 'Import selected rows',
  imported: 'Selected rows imported.', noRows: 'No preview rows.', row: 'Row {row}: {seat} — {action}',
  sourceChanged: 'Changing the source, mapping or defaults clears the preview. No rows are imported before confirmation.',
  preset: 'Product mapping preset', noPreset: 'Generic mapping', useProfile: 'Use selected profile as defaults',
  rejectSeatNotFound:
    'This seat profile no longer exists, so nothing was changed. Refresh the profile list and restore the definition if it is still needed.',
  rejectSeatAlreadyOpen:
    'This seat already has an open window, so another was not opened. Use the open window or close it before opening again.',
  rejectSeatChoiceRequired: 'More than one seat matches, so nothing was opened. Choose one seat explicitly and retry.',
  rejectCrossNodeUnsupported: 'This operation belongs to another node, so it was not applied here. Run it on the node that owns the seat.',
  rejectImportPreviewStale:
    'The preview no longer matches the source or catalog, so nothing was imported. Preview the source again before selecting rows.',
  rejectImportConflict:
    'The source conflicts with existing profile edits, so the conflicting rows were not imported. Review the preview differences and import only rows you accept.',
  rejectImportSourceAuthoritative:
    'The import source still owns this catalog, so the profile was not saved or deleted. Transfer editing authority first, then retry.',
  rejectSeatStoreAuthoritative:
    'This catalog is already owned by seat profiles, so the import source cannot change it. Edit the profile directly instead of importing.',
  rejectInvalidDefinition:
    'The profile definition is invalid, so it was not saved or imported. Correct the JSON fields, presets, model, paths and rules, then retry.',
  rejectInvalidRequest: 'The selection is empty or does not match the current preview, so nothing was imported. Select at least one row shown by the latest preview.',
  rejectUnsupportedSchemaVersion:
    'This profile uses a schema version this editor cannot write, so it was left unchanged. Open it with a build that supports that version.',
  rejectRevisionConflict:
    'The catalog changed after this view was loaded, so the draft was not written. Refresh, review the current profile, and retry.',
  rejectOperationIdConflict:
    'This request was already submitted with different contents, so it was not applied again. Refresh and submit the current change as a new action.',
  rejectEventIdConflict:
    'This change conflicts with an event already recorded for the profile, so it was not applied. Refresh and review the current profile before retrying.',
  rejectUnauthorized:
    'Only the signed-in local owner can change seat profiles, so this action was refused. Sign in as that owner and retry.',
  rejectUnavailable:
    'The seat engine or its observations are unavailable, so nothing was changed. Restore the local seat engine and refresh before retrying.',
  rejectDisabled: 'Seat profile changes are disabled, so this action was not applied. Enable the seat feature and retry.',
  rejectEngineStoreCorrupt:
    'The seat engine store cannot be read safely, so the profile was not changed. Repair the engine store from its recovery log before retrying.',
  rejectSessionNotFound:
    'The selected window is no longer active, so the profile action was not applied. Refresh the window list and retry.',
  rejectSessionBusy: 'A window for this seat is busy, so the profile action was not applied. Wait until it is idle, then retry.',
  rejectStateConflict:
    'The seat state changed while this action was running, so it was not applied. Refresh and review the current state before retrying.',
  rejectOwnerUnknown: 'The local owner identity is unknown, so the profile was not changed. Restore the owner sign-in and retry.',
  rejectMemorySeatMismatch:
    'A memory directory belongs to a different seat, so the profile was not saved. Point memory directories at this seat and retry.',
  rejectWakeTemplateMissing:
    'This seat has no wake template, so the wake action was not applied. Add a wake template to the profile and retry.',
  rejectBatchExplicitSeatsRequired:
    'A batch must name each seat explicitly, so nothing was opened. Replace any all or wildcard selection with an explicit seat list.',
  rejectBatchLimitExceeded:
    'The batch is larger than the configured seat limit, so nothing was opened. Split the list and submit the smaller batches.',
  rejectCacheEvidenceUnavailable:
    'Cache evidence for this seat is unavailable, so the cache action was not applied. Refresh the seat observations and retry.',
  rejectCacheExpired: 'The seat cache has expired, so the cache action was not applied. Refresh the profile and retry.',
  rejectCachePrefixChanged:
    'The cached prefix changed, so the cache action was not applied. Refresh the profile and retry against the current prefix.',
  rejectMaintenanceBusy:
    'Cache maintenance is already running for this seat, so this action was not applied. Wait for it to finish and retry.',
  rejectRenewalUncertain:
    'Cache renewal did not finish in a known state, so it was not reported as applied. Refresh and check the seat before retrying.',
  rejectSubagentRenewalExpired: 'The subagent cache renewal expired, so it was not applied. Refresh the seat and retry the renewal.',
  rejectSubagentContextLimit:
    'The subagent context limit was reached, so the action was not applied. Reduce the subagent context or raise its profile limit, then retry.',
  rejectEvidenceUnavailable:
    'A window for this seat has unknown state, so the profile was not changed. Open that window from the session list so it resumes, then retry.',
  rejectPolling: 'The seat is polling, so this action was not applied. Wait for polling to finish and retry.',
  rejectSleepLimitExceeded:
    'The requested sleep is longer than this seat allows, so it was not applied. Lower the sleep duration and retry.',
  rejectGateDenied:
    'A seat gate denied this action, so nothing was changed. Review the gate result shown for this seat and retry only after it allows the action.',
  rejectAuditUnavailable: 'The audit record for this action is unavailable, so it was not applied. Restore audit storage and retry.',
  rejectCheckpointUnavailable:
    'A checkpoint file is unavailable, so the profile action was not applied. Restore the checkpoint file and retry.',
  rejectCheckpointChanged: 'A checkpoint file changed, so the profile action was not applied. Review the checkpoint and retry.',
  rejectCheckpointBudgetExceeded:
    'The checkpoint budget was exceeded, so the action was not applied. Reduce the checkpoint work and retry.',
  rejectBudgetUnverifiable: 'The seat budget cannot be verified, so the action was not applied. Restore budget evidence and retry.',
  rejectBudgetFull: 'The seat budget is full, so the action was not applied. Free budget or wait for it to recover, then retry.',
  rejectBudgetStopped: 'The seat budget is stopped, so the action was not applied. Restore the budget and retry.',
  rejectSourceNotFound:
    'The import source file was not found, so nothing was imported. Choose a host file that exists and preview it again.',
  rejectSourceAuthenticationFailed:
    'The import source could not be authenticated, so nothing was imported. Restore access to that source and preview it again.',
  rejectSourcePayloadTooLarge:
    'The import source is larger than the configured limit, so nothing was imported. Choose a smaller source and preview it again.',
  rejectSourceTimestampInvalid:
    'The import source timestamp is invalid, so nothing was imported. Correct the source clock or file timestamp and preview it again.',
  rejectCallbackAuthenticationFailed:
    'The callback could not be authenticated, so the profile action was not applied. Restore callback credentials and retry.',
  rejectCallbackProtocolError:
    'The callback response did not follow the expected protocol, so the action was not applied. Retry after the callback endpoint is corrected.',
  rejectOpenCreateFailed: 'The seat window could not be created, so no window was opened. Review the seat definition and retry.',
  rejectOpenConfigurationFailed:
    'The seat window configuration was rejected, so no window was opened. Correct the opening configuration and retry.',
  rejectOpeningFailed: 'Opening the seat failed, so no window was opened. Review the opening sentence, files and model, then retry.',
  rejectOpeningOwnerLost: 'The owner of this opening is no longer available, so the window was not opened. Restore that owner and retry.',
  rejectSessionIdConflict:
    'This window identity is already in use, so the profile action was not applied. Refresh the window list and retry.',
  rejectReplacementOpenFailed:
    'The replacement window could not be opened, so the current window was left unchanged. Review the opening configuration and retry.',
  rejectReplacementFirstTurnFailed:
    'The replacement window failed on its first turn, so the replacement was not kept. Review the opening and retry.',
  rejectReplacementCleanupFailed:
    'Replacement cleanup failed, so the seat was left for review. Refresh the window list and resolve the leftover window before retrying.',
  rejectWaitIdConflict: 'This wait identity is already in use, so the wait was not created. Refresh and submit the wait again.',
  rejectWaitObjectNotFound:
    'The waited object no longer exists, so the wait was not created. Refresh the profile and choose a current object.',
  rejectWaitObjectUnauthorized:
    'The waited object is not authorized for this seat, so the wait was not created. Choose an object this seat may access.',
  rejectTicketNotFound:
    'The referenced ticket was not found, so the profile action was not applied. Refresh the ticket reference and retry.',
  rejectTicketCancelled: 'The referenced ticket is cancelled, so the profile action was not applied. Choose an open ticket and retry.',
  rejectReportNotFound:
    'The referenced report was not found, so the profile action was not applied. Refresh the report reference and retry.',
  rejectReportRevoked: 'The referenced report was revoked, so the profile action was not applied. Choose a current report and retry.',
  rejectCausalDepthExceeded:
    'This action would nest seat work deeper than allowed, so it was not applied. Reduce the nested handoff depth and retry.',
  rejectRuleSelfLoop: 'An opening rule points back at itself, so the profile was not saved. Remove the self-referencing rule and retry.',
  rejectQueryCursorInvalid: 'The window list cursor changed, so the query was not continued. Refresh the window list and start it again.',
  rejectExportEventConflict:
    'The export conflicts with events already recorded, so it was not written. Refresh and export the current range again.',
  rejectWorktreeClientLimit:
    'This seat already has as many client worktrees as its policy allows, so another was not created. Close one or raise the profile limit, then retry.',
  rejectWorktreeUnverified:
    'The worktree could not be verified, so the profile action was not applied. Check the worktree policy and retry.',
  rejectUnknown: 'Unknown error ({code}). Refresh before retrying.',
} as const
/** Profile dictionary keys. */
export type ProfileKey = keyof typeof en
/** Chinese profile editor copy. */
export const zh: Record<ProfileKey, string> = {
  singleMachineAdvanced: '高级(单机用不着)',
  sourceOwned: '当前目录由导入源持有；编辑与删除前必须显式转交权限。',
  takeover: '转交编辑权限', confirmTakeover: '确认转交', takenOver: '编辑权限已转交，请重新加载档案后编辑。',
  takeoverWarning: '确认将整个目录从导入源转交给本地档案编辑？此授权会留存，所有定义版本均会递增；后续来源导入可能出现冲突。',
  nav: '工位档案', loading: '工位档案加载中…', empty: '暂无工位档案。', refresh: '刷新',
  unavailable: '工位档案不可用或无权限，请恢复所有者权限后刷新。',
  save: '保存档案', saving: '处理中…', saved: '档案已保存。', failed: '操作失败或结果尚不确定，请刷新后再操作。',
  conflict: '档案版本或删除影响已变化，未覆盖你的草稿，请刷新并核对后重试。',
  invalid: '部分字段无效，请检查 JSON 字段及已配置的预设、模型、路径和规则。',
  back: '返回工位列表', remove: '删除工位', confirmRemove: '确认删除', cancel: '取消',
  removeTitle: '确认删除本位档案？', removeWarning: '仅删除定义；下列窗口保持打开、待批不取消，但依赖本定义的后续操作可能失败，须恢复定义后再处理。',
  stateVersion: '状态版本', stateUnknown: '状态未知（需恢复）', windows: '在开窗', pending: '待批事项', none: '无', removed: '档案已删除。',
  directories: '工作区（JSON）', memoryDirectories: '记忆目录（JSON）', opening: '开窗句或文件（JSON）',
  openingInstructionFiles: '章程 / 开窗必读件（JSON）', agentPreset: 'Agent 预设', provider: '提供商', model: '模型',
  reasoningEffort: '推理档位', permissionPreset: '权限预设', platform: '平台', node: '节点', rules: '开窗规则（JSON）',
  advanced: '开窗规则与限制', projectId: '项目', subscriptions: '订阅文件（JSON）', checkpointFiles: '检查点文件（JSON）',
  remoteAdmission: '远端准入（JSON，留空移除）', wakeTemplate: '唤醒模板（JSON，留空移除）', autoKeepAlive: '自动保活（true / false）',
  maxOpenSessions: '最大在开会话数', maxActiveSubagents: '最大活跃子代理数', contextThresholdTokens: '上下文阈值（留空移除）',
  subagentContextThresholdTokens: '子代理上下文阈值', pollingThreshold: '轮询阈值（留空移除）', maxSleepSeconds: '最长睡眠秒数（留空移除）',
  worktree: '工作树策略（JSON）', immutable: '位名、格式版本与导入来源保留；保存时递增定义版本。',
  import: '从表格导入', sourcePath: '宿主源文件路径', format: '格式', markdown: 'Markdown', csv: 'CSV', table: 'Markdown 表格标题（可选）',
  mapping: '表头 → 定义字段映射（JSON）', defaults: '定义默认值（JSON）', preview: '预览表格', commit: '导入勾选行',
  imported: '勾选行已导入。', noRows: '暂无预览行。', row: '第 {row} 行：{seat} — {action}',
  sourceChanged: '修改源文件、映射或默认值后清空预览；确认前不会导入任何行。',
  preset: '产品映射预设', noPreset: '通用映射', useProfile: '以当前档案为默认值',
  rejectSeatNotFound: '该工位档案已不存在，未作任何更改。请刷新档案列表；仍需要时先恢复定义。',
  rejectSeatAlreadyOpen: '该工位已有打开的窗口，未再开新窗。请使用现有窗口，或关闭后再开。',
  rejectSeatChoiceRequired: '匹配到多个工位，未开任何窗。请明确选择一个工位后再试。',
  rejectCrossNodeUnsupported: '该操作属于另一个节点，未在本节点执行。请到持有该工位的节点上执行。',
  rejectImportPreviewStale: '预览已与源文件或目录不一致，未导入任何行。请重新预览后再勾选。',
  rejectImportConflict: '源文件与现有档案修改冲突，冲突行未导入。请核对预览差异后，只导入确认接受的行。',
  rejectImportSourceAuthoritative: '导入源仍持有当前目录，档案未保存或删除。请先转交编辑权限，再重试。',
  rejectSeatStoreAuthoritative: '当前目录已由工位档案持有，导入源不能再改它。请直接编辑档案，不要通过导入修改。',
  rejectInvalidDefinition: '档案定义无效，未保存或导入。请修正 JSON 字段、预设、模型、路径和规则后再试。',
  rejectInvalidRequest: '未选择行或选择与当前预览不符，未导入任何行。请至少勾选一行最新预览中显示的内容。',
  rejectUnsupportedSchemaVersion: '该档案的格式版本本编辑器无法写入，已保持原样。请用支持该版本的构建打开。',
  rejectRevisionConflict: '加载本视图后目录已变化，草稿未写入。请刷新并核对当前档案后再试。',
  rejectOperationIdConflict: '同一请求已以不同内容提交过，未再次执行。请刷新后把当前修改作为新操作提交。',
  rejectEventIdConflict: '该修改与档案中已记录的事件冲突，未执行。请刷新并核对当前档案后再试。',
  rejectUnauthorized: '只有已登录的本地所有者能修改工位档案，该操作已被拒绝。请以该所有者身份登录后重试。',
  rejectUnavailable: '工位引擎或其观测暂不可用，未作任何更改。请恢复本地工位引擎并刷新后再试。',
  rejectDisabled: '工位档案修改已停用，该操作未执行。请启用工位功能后再试。',
  rejectEngineStoreCorrupt: '工位引擎存储无法安全读取，档案未更改。请先按其恢复日志修复引擎存储再试。',
  rejectSessionNotFound: '所选窗口已不再活动，档案操作未执行。请刷新窗口列表后再试。',
  rejectSessionBusy: '该工位有窗口正忙，档案操作未执行。请待其空闲后再试。',
  rejectStateConflict: '操作进行时工位状态已变化，未执行。请刷新并核对当前状态后再试。',
  rejectOwnerUnknown: '本地所有者身份未知，档案未更改。请恢复所有者登录后再试。',
  rejectMemorySeatMismatch: '某个记忆目录属于其他工位，档案未保存。请把记忆目录指回本工位后再试。',
  rejectWakeTemplateMissing: '该工位没有唤醒模板，唤醒操作未执行。请在档案中补上唤醒模板后再试。',
  rejectBatchExplicitSeatsRequired: '批量操作必须逐个写明工位，未开任何窗。请把全部或通配选择改成明确的工位列表。',
  rejectBatchLimitExceeded: '批量数量超过配置上限，未开任何窗。请拆成较小的列表分别提交。',
  rejectCacheEvidenceUnavailable: '该工位的缓存证据不可用，缓存操作未执行。请刷新工位观测后再试。',
  rejectCacheExpired: '工位缓存已过期，缓存操作未执行。请刷新档案后再试。',
  rejectCachePrefixChanged: '缓存前缀已变化，缓存操作未执行。请刷新档案后按当前前缀重试。',
  rejectMaintenanceBusy: '该工位的缓存维护已在进行，本次操作未执行。请待其结束后再试。',
  rejectRenewalUncertain: '缓存续期没有在已知状态下结束，不能视为已生效。请刷新并核对工位后再试。',
  rejectSubagentRenewalExpired: '子代理缓存续期已过期，未生效。请刷新工位后重新续期。',
  rejectSubagentContextLimit: '已达到子代理上下文上限，操作未执行。请减小子代理上下文或提高档案上限后再试。',
  rejectEvidenceUnavailable: '该工位有窗口状态未知，档案未更改。请先在会话列表打开该窗让它恢复，再重试。',
  rejectPolling: '该工位正在轮询，本次操作未执行。请待轮询结束后再试。',
  rejectSleepLimitExceeded: '请求的睡眠时长超过该工位允许值，未执行。请缩短睡眠时长后再试。',
  rejectGateDenied: '工位门禁拒绝了该操作，未作任何更改。请查看该工位的门禁结果，待其放行后再试。',
  rejectAuditUnavailable: '该操作的审计记录不可用，未执行。请恢复审计存储后再试。',
  rejectCheckpointUnavailable: '某个检查点文件不可用，档案操作未执行。请恢复该检查点文件后再试。',
  rejectCheckpointChanged: '某个检查点文件已变化，档案操作未执行。请核对检查点后再试。',
  rejectCheckpointBudgetExceeded: '检查点预算已超限，操作未执行。请减少检查点工作量后再试。',
  rejectBudgetUnverifiable: '工位预算无法核验，操作未执行。请恢复预算证据后再试。',
  rejectBudgetFull: '工位预算已满，操作未执行。请释放预算或待其恢复后再试。',
  rejectBudgetStopped: '工位预算已停止，操作未执行。请恢复预算后再试。',
  rejectSourceNotFound: '找不到导入源文件，未导入任何内容。请选择一个存在的宿主文件并重新预览。',
  rejectSourceAuthenticationFailed: '导入源未能通过鉴权，未导入任何内容。请恢复对该源的访问并重新预览。',
  rejectSourcePayloadTooLarge: '导入源超过配置大小上限，未导入任何内容。请换一个较小的源并重新预览。',
  rejectSourceTimestampInvalid: '导入源的时间戳无效，未导入任何内容。请修正源的时钟或文件时间后再预览。',
  rejectCallbackAuthenticationFailed: '回调未能通过鉴权，档案操作未执行。请恢复回调凭据后再试。',
  rejectCallbackProtocolError: '回调响应不符合预期协议，操作未执行。请待回调端点修正后再试。',
  rejectOpenCreateFailed: '工位窗口未能创建，未开窗。请核对工位定义后再试。',
  rejectOpenConfigurationFailed: '工位窗口配置被拒绝，未开窗。请修正开窗配置后再试。',
  rejectOpeningFailed: '工位开窗失败，未开窗。请核对开窗句、文件和模型后再试。',
  rejectOpeningOwnerLost: '本次开窗的所有者已不可用，未开窗。请恢复该所有者后再试。',
  rejectSessionIdConflict: '该窗口身份已被占用，档案操作未执行。请刷新窗口列表后再试。',
  rejectReplacementOpenFailed: '替换窗口未能打开，当前窗口保持原样。请核对开窗配置后再试。',
  rejectReplacementFirstTurnFailed: '替换窗口在首轮即失败，未保留该替换。请核对开窗内容后再试。',
  rejectReplacementCleanupFailed: '替换清理失败，工位留待核对。请刷新窗口列表并处理残留窗口后再试。',
  rejectWaitIdConflict: '该等待身份已被占用，未创建等待。请刷新后重新提交等待。',
  rejectWaitObjectNotFound: '等待的对象已不存在，未创建等待。请刷新档案并改选当前对象。',
  rejectWaitObjectUnauthorized: '等待的对象未授权给该工位，未创建等待。请改选该工位可访问的对象。',
  rejectTicketNotFound: '引用的工单未找到，档案操作未执行。请刷新工单引用后再试。',
  rejectTicketCancelled: '引用的工单已取消，档案操作未执行。请改选未取消的工单后再试。',
  rejectReportNotFound: '引用的报告未找到，档案操作未执行。请刷新报告引用后再试。',
  rejectReportRevoked: '引用的报告已撤销，档案操作未执行。请改选当前有效的报告后再试。',
  rejectCausalDepthExceeded: '该操作会使工位工作嵌套超过允许深度，未执行。请减少嵌套交接层数后再试。',
  rejectRuleSelfLoop: '某条开窗规则指向自身，档案未保存。请去掉自引用规则后再试。',
  rejectQueryCursorInvalid: '窗口列表游标已变化，查询未继续。请刷新窗口列表后重新开始。',
  rejectExportEventConflict: '导出与已记录的事件冲突，未写入。请刷新后重新导出当前范围。',
  rejectWorktreeClientLimit: '该工位的客户端工作树已达策略上限，未再创建。请关闭一个或提高档案上限后再试。',
  rejectWorktreeUnverified: '工作树未能核验，档案操作未执行。请检查工作树策略后再试。',
  rejectUnknown: '未知错误（{code}）。请刷新后再试。',
}

/**
 * Locale key for a known seat refusal, or undefined when the code is not in the seat table.
 * @param code Seat refusal code.
 * @returns The corresponding locale key, or undefined for an unknown code.
 */
export function rejectionCopy(code: string): ProfileKey | undefined {
  return ({ 'seat-not-found': 'rejectSeatNotFound', 'seat-already-open': 'rejectSeatAlreadyOpen', 'seat-choice-required': 'rejectSeatChoiceRequired', 'cross-node-unsupported': 'rejectCrossNodeUnsupported', 'import-preview-stale': 'rejectImportPreviewStale', 'import-conflict': 'rejectImportConflict', 'import-source-authoritative': 'rejectImportSourceAuthoritative', 'seat-store-authoritative': 'rejectSeatStoreAuthoritative', 'invalid-definition': 'rejectInvalidDefinition', 'invalid-request': 'rejectInvalidRequest', 'unsupported-schema-version': 'rejectUnsupportedSchemaVersion', 'revision-conflict': 'rejectRevisionConflict', 'operation-id-conflict': 'rejectOperationIdConflict', 'event-id-conflict': 'rejectEventIdConflict', 'unauthorized': 'rejectUnauthorized', 'unavailable': 'rejectUnavailable', 'disabled': 'rejectDisabled', 'engine-store-corrupt': 'rejectEngineStoreCorrupt', 'session-not-found': 'rejectSessionNotFound', 'session-busy': 'rejectSessionBusy', 'state-conflict': 'rejectStateConflict', 'owner-unknown': 'rejectOwnerUnknown', 'memory-seat-mismatch': 'rejectMemorySeatMismatch', 'wake-template-missing': 'rejectWakeTemplateMissing', 'batch-explicit-seats-required': 'rejectBatchExplicitSeatsRequired', 'batch-limit-exceeded': 'rejectBatchLimitExceeded', 'cache-evidence-unavailable': 'rejectCacheEvidenceUnavailable', 'cache-expired': 'rejectCacheExpired', 'cache-prefix-changed': 'rejectCachePrefixChanged', 'maintenance-busy': 'rejectMaintenanceBusy', 'renewal-uncertain': 'rejectRenewalUncertain', 'subagent-renewal-expired': 'rejectSubagentRenewalExpired', 'subagent-context-limit': 'rejectSubagentContextLimit', 'evidence-unavailable': 'rejectEvidenceUnavailable', 'polling': 'rejectPolling', 'sleep-limit-exceeded': 'rejectSleepLimitExceeded', 'gate-denied': 'rejectGateDenied', 'audit-unavailable': 'rejectAuditUnavailable', 'checkpoint-unavailable': 'rejectCheckpointUnavailable', 'checkpoint-changed': 'rejectCheckpointChanged', 'checkpoint-budget-exceeded': 'rejectCheckpointBudgetExceeded', 'budget-unverifiable': 'rejectBudgetUnverifiable', 'budget-full': 'rejectBudgetFull', 'budget-stopped': 'rejectBudgetStopped', 'source-not-found': 'rejectSourceNotFound', 'source-authentication-failed': 'rejectSourceAuthenticationFailed', 'source-payload-too-large': 'rejectSourcePayloadTooLarge', 'source-timestamp-invalid': 'rejectSourceTimestampInvalid', 'callback-authentication-failed': 'rejectCallbackAuthenticationFailed', 'callback-protocol-error': 'rejectCallbackProtocolError', 'open-create-failed': 'rejectOpenCreateFailed', 'open-configuration-failed': 'rejectOpenConfigurationFailed', 'opening-failed': 'rejectOpeningFailed', 'opening-owner-lost': 'rejectOpeningOwnerLost', 'session-id-conflict': 'rejectSessionIdConflict', 'replacement-open-failed': 'rejectReplacementOpenFailed', 'replacement-first-turn-failed': 'rejectReplacementFirstTurnFailed', 'replacement-cleanup-failed': 'rejectReplacementCleanupFailed', 'wait-id-conflict': 'rejectWaitIdConflict', 'wait-object-not-found': 'rejectWaitObjectNotFound', 'wait-object-unauthorized': 'rejectWaitObjectUnauthorized', 'ticket-not-found': 'rejectTicketNotFound', 'ticket-cancelled': 'rejectTicketCancelled', 'report-not-found': 'rejectReportNotFound', 'report-revoked': 'rejectReportRevoked', 'causal-depth-exceeded': 'rejectCausalDepthExceeded', 'rule-self-loop': 'rejectRuleSelfLoop', 'query-cursor-invalid': 'rejectQueryCursorInvalid', 'export-event-conflict': 'rejectExportEventConflict', 'worktree-client-limit': 'rejectWorktreeClientLimit', 'worktree-unverified': 'rejectWorktreeUnverified' } as const satisfies Record<string, ProfileKey>)[code]
}
