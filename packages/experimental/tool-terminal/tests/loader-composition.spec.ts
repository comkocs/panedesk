import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { provideWorkingDirectoryFixture, unsupportedInbox } from '@panedesk/dsh-agent-loop-testkit'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { ToolCallId } from '@panedesk/dsh-llm'
import { Session, SessionId } from '@panedesk/dsh-session'
import AgentRegistry from '@panedesk/dsh-agent'
import type { Agent } from '@panedesk/dsh-agent'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import TerminalSessionService from '@panedesk/dsh-terminal'
import SandboxProvider from '@panedesk/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@panedesk/dsh-sandbox'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import LocalSubprocessRuntime from '@panedesk/dsh-subprocess-local'
import * as TerminalLocal from '@panedesk/dsh-terminal-bash'
import * as ToolPty from '@panedesk/dsh-tool-terminal'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@panedesk/dsh-agent'",
      "- name: '@panedesk/dsh-system-prompt'",
      "- name: '@panedesk/dsh-tools'",
      "- name: '@panedesk/dsh-terminal'",
      "- name: '@panedesk/dsh-test-sandbox'",
      "- name: '@panedesk/dsh-session-projection'",
      "- name: '@panedesk/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@panedesk/dsh-subprocess-local'",
      "- name: '@panedesk/dsh-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@panedesk/dsh-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()

    provideWorkingDirectoryFixture(context)
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@panedesk/dsh-agent', AgentRegistry],
      ['@panedesk/dsh-system-prompt', SystemPrompt],
      ['@panedesk/dsh-tools', ToolRuntime],
      ['@panedesk/dsh-terminal', TerminalSessionService],
      ['@panedesk/dsh-test-sandbox', PassthroughSandbox],
      ['@panedesk/dsh-session-projection', SessionProjectionRegistry],
      ['@panedesk/dsh-sandbox-policy', SandboxPolicyService],
      ['@panedesk/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@panedesk/dsh-terminal-bash', TerminalLocal],
      ['@panedesk/dsh-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = await agent(context)
    const signal = new AbortController().signal
    const spawn = await context.tools.execute({
      signal, callId: ToolCallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await context.tools.execute({
      signal, callId: ToolCallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await context.tools.execute({
      signal, callId: ToolCallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
