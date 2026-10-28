/** Deterministic child-process model and tool for default-profile accounting regressions. */
import { writeFileSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import type { Context } from '@panedesk/cordis'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'
import { defineTool } from '@panedesk/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'

export const name = 'default-accounting-fixture'
export const inject = ['llm', 'tools']

class AccountingAdapter extends MockAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const path = process.env.DSH_ACCOUNTING_MARKER
    if (path === undefined) throw new Error('Accounting marker is not configured')
    await appendFile(`${path}.requests`, `${JSON.stringify({ sessionId: options.sessionId, purpose: options.purpose })}\n`)
    yield* super.stream(options)
  }
}

/** Register a local scripted transport and a tool that leaves an owned execution marker.
 * @param ctx - child runtime with real model and tool services.
 */
export function apply(ctx: Context): void {
  const adapter = new AccountingAdapter([
    toolCallResponse('sdk-probe', 'ledger_probe', {}), textResponse('SDK accounting complete'),
  ])
  ctx.on('tools/result', (exec, result) => {
    const path = process.env.DSH_ACCOUNTING_MARKER
    if (path !== undefined && exec.name === 'ledger_probe') writeFileSync(`${path}.result`, JSON.stringify(result))
  })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ledger_probe', description: 'Write the isolated accounting execution marker.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const path = process.env.DSH_ACCOUNTING_MARKER
      if (path === undefined) throw new Error('Accounting marker is not configured')
      await writeFile(path, 'executed\n')
      return 'executed'
    },
  })))
}
