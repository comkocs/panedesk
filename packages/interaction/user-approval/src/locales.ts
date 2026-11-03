/** Approval diagnostics distinguish owner decisions, transport failures, and failed grants. */
export const en = {
  ownerRejected: 'Owner rejected',
  unavailable: 'Approval channel unavailable',
  authorizationFailed: 'Approved but authorization failed:',
  ruleCheckFailed: 'Rule check failed:',
}

/** Chinese approval diagnostics use the English key set. */
export const zh = {
  ownerRejected: 'owner 拒',
  unavailable: '审批通道不可用',
  authorizationFailed: '已批准但授权失败:',
  ruleCheckFailed: '规则检查失败:',
} satisfies Record<keyof typeof en, string>
