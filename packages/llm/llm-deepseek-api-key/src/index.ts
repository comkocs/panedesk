/** API-key authentication and credential-gated discovery for the official DeepSeek route. */
import type { Context } from '@panedesk/cordis'
import { assertUsableApiKey, LlmError } from '@panedesk/dsh-llm'
import type {} from '@panedesk/cordis-plugin-loader'
import { launchEnvironmentOf } from '@panedesk/dsh-launch-environment'
import { registerDeepSeekProvider, catalogModelInfo } from '@panedesk/dsh-llm-deepseek'
import { Config, plainOptions, resolveAdapterOptions } from './config.ts'
import type { ResolvedDeepSeekOptions } from './config.ts'

export { Config, plainOptions, resolveAdapterOptions } from './config.ts'
export type { Options, ResolvedDeepSeekOptions } from './config.ts'
export const name = 'llm-deepseek-api-key'
export const inject = ['llm']

const PROVIDER = 'deepseek-official'

export function apply(ctx: Context, config: Config): void {
  const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery(settingsNs, async (_request, signal) => {
    const connection = options()
    const key = await resolveApiKey(connection)
    const baseURL = connection.baseURL.replace(/\/+$/u, '').replace(/\/anthropic$/u, '')
    const response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` }, ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new LlmError(`DeepSeek model discovery failed: HTTP ${response.status}`, 'DISCOVERY_FAILED')
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
      throw new LlmError('DeepSeek model discovery returned an invalid listing', 'DISCOVERY_FAILED')
    }
    return (body.data as unknown[]).flatMap(model => (
      model !== null && typeof model === 'object' && 'id' in model && typeof model.id === 'string'
        ? [{ id: model.id }] : []
    ))
  })
  registerDeepSeekProvider(ctx, PROVIDER, {
    options, providerName: 'DeepSeek',
    resolveAuth: async connection => ({ headers: { 'x-api-key': await resolveApiKey(connection) } }),
    discoverModels: async (provider) => {
      const connection = options()
      try { await resolveApiKey(connection) }
      catch (error) {
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return connection.models.map(model => catalogModelInfo(provider, model))
    },
  })
}
