/** Bound-seat roots reach durable model input through a Loader-mounted instruction plugin. */
import { expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Instructions from '@panedesk/dsh-agent-instructions'
import { createUserMessage } from '@panedesk/dsh-llm'
import { localHost } from './local-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'

it('loads and refreshes three additional-root instruction files for the bound session', async () => {
  const f = await localHost()
  try {
    const extra = join(f.root, 'additional')
    await mkdir(extra)
    vi.stubEnv('PANEDESK_HOME', join(f.root, 'absent-home'))
    vi.stubEnv('PANEDESK_AGENTS_HOME', join(f.root, 'absent-agents'))
    const names = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']
    for (const name of names) await writeFile(join(extra, name), `ROOT_BEFORE_${name}`)
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' },
      defaults: { directories: [{ path: f.root, startup: true }, { path: extra, startup: false }] } })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row), expectedRevision: 0,
      operationId: operation('instruction-import') })
    f.ctx.loader.builtins.instructions = Instructions
    await f.load('instructions.yml', [{ name: 'cordis:instructions', config: {
      maxBytes: 65536, includeSessionWorkspaceRoots: true, refreshIntervalMs: 10,
    } }])
    const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', operationId: operation('instruction-open') })
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    const agent = f.ctx.agents.get(opened.sessionId)!
    await expect.poll(() => f.model.requests.length).toBe(1)
    await agent.whenIdle()
    for (const name of names) expect(JSON.stringify(f.model.requests[0])).toContain(`ROOT_BEFORE_${name}`)
    for (const name of names) await writeFile(join(extra, name), `ROOT_AFTER_${name}`)
    await expect.poll(() => JSON.stringify(agent.inbox.nextStep)).toContain('ROOT_AFTER_CLAUDE.local.md')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with refreshed workspace guidance.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(f.model.requests).toHaveLength(2)
    for (const name of names) expect(JSON.stringify(f.model.requests[1])).toContain(`ROOT_AFTER_${name}`)
    await f.ctx.sessions.flush(agent.session)
    const persisted = await f.ctx.sessionQuery.readSession(agent.id)
    for (const name of names) expect(JSON.stringify(persisted.events)).toContain(`ROOT_AFTER_${name}`)
  } finally { vi.unstubAllEnvs(); await f.close() }
}, 20000)
