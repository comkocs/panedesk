/** Read-only, user-facing confinement diagnostics; no Agent or model is created. */
import type { Context } from '@panedesk/cordis'
import type { ProtectedInputEnforcement, SandboxPolicy } from '@panedesk/dsh-sandbox'
import type {} from '@panedesk/dsh-sandbox-policy'

const messages = {
  en: {
    fallback: (count: number) => `${count} ${count === 1 ? 'input' : 'inputs'} protected by host fallback`,
    unrestricted: 'Sandbox confinement is disabled by the selected permission mode.',
    unavailable: 'The sandbox provider cannot inspect confinement without changing write grants.',
    policyMissing: 'Sandbox policy is unavailable; check the profile composition.',
  },
  zh: {
    fallback: (count: number) => `${count} 项由宿主兜底`,
    unrestricted: '所选权限模式已关闭沙盒约束。',
    unavailable: '沙盒提供者不支持在不改变写授权的情况下查询约束状态。',
    policyMissing: '沙盒策略不可用，请检查配置组合。',
  },
}

/**
 * Inspect the deployment policy without granting workspace access or producing executable argv.
 * @param ctx Fully loaded application context.
 * @param locale User-selected diagnostic language.
 * @returns Complete protected-input inventory and backend completeness.
 */
export function sandboxStatus(ctx: Context, locale: 'en' | 'zh'): {
  type: 'sandbox-status'
  mode: SandboxPolicy['mode'] | 'danger-full-access'
  enforcement: 'full' | 'partial' | 'unconfined'
  hostFallbackCount: number
  message: string
  protectedInputs: readonly ProtectedInputEnforcement[]
} {
  const text = messages[locale]
  const policy = ctx.get('sandboxPolicy')?.resolve()
  if (policy === undefined) throw new Error(text.policyMissing)
  if (policy.mode === 'danger-full-access') {
    return { type: 'sandbox-status', mode: policy.mode, enforcement: 'unconfined', hostFallbackCount: 0, message: text.unrestricted, protectedInputs: [] }
  }
  const provider = ctx.get('sandbox')
  if (provider?.inspect === undefined) throw new Error(text.unavailable)
  const status = provider.inspect({ ...policy, mode: policy.mode })
  const protectedInputs = status.protectedInputs ?? []
  const hostFallbackCount = protectedInputs.filter(input => input.enforcement === 'host-fallback').length
  return { type: 'sandbox-status', mode: policy.mode, enforcement: status.enforcement, hostFallbackCount, message: text.fallback(hostFallbackCount), protectedInputs }
}
