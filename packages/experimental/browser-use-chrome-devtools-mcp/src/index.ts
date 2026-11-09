/** Chromium inspection and automation through the pinned Chrome DevTools MCP server. @module */

import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@panedesk/cordis'
import Schema from '@panedesk/schemastery'
import { mountSessionMcp, validateBrowserMcpConfig } from '@panedesk/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@panedesk/dsh-working-directory'

/** Cordis identity for the Chrome DevTools MCP browser provider. */
export const name = 'experimental-browser-use-chrome-devtools-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Fixed Chromium launch or existing-browser attachment settings. */
export interface Config {
  enabled: Volatile<boolean>
  mode: 'launch' | 'attach'
  endpoint: Volatile<string>
  headless: boolean
  executablePath?: string
  toolCallTimeoutMs?: number
}

/** Settings edits apply to future Session connections; disabling blocks existing tool calls. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  mode: Schema.union(['launch', 'attach']).default('attach'),
  endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).default('http://localhost:9222').volatile(),
  headless: Schema.boolean().default(true),
  executablePath: Schema.string().pattern(/\S/u),
  toolCallTimeoutMs: Schema.number().min(1),
})

/**
 * Expose Chrome DevTools' upstream catalog through one MCP process per live Session.
 * Attached browsers remain externally owned; the server disables usage statistics.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode === 'attach') validateBrowserMcpConfig({ mode: 'attach', endpoint: config.endpoint.get() })
  const cli = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
  mountSessionMcp(ctx, {
    name: 'chrome-devtools-mcp',
    exclusive: config.mode === 'attach',
    enabled: () => config.enabled.get(),
    onStartupError: () => { ctx.logger.warn('Chrome DevTools MCP is unavailable; other tools remain available. Check the Chrome debugging address in Settings.') },
    command: process.execPath,
    args: () => {
      const args = [cli, '--no-usage-statistics']
      if (config.mode === 'attach') {
        const endpoint = config.endpoint.get()
        validateBrowserMcpConfig({ mode: 'attach', endpoint })
        args.push(/^wss?:/u.test(endpoint) ? '--ws-endpoint' : '--browser-url', endpoint)
      } else {
        args.push('--isolated', `--headless=${String(config.headless)}`)
        if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
      }
      return args
    },
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
