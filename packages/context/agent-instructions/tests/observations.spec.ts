/** Byte evidence is tied to successful tools and matching provider versions. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { agentEvents } from '@panedesk/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import { ToolCallId } from '@panedesk/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@panedesk/dsh-tools'
import * as ToolFs from '@panedesk/dsh-tool-fs'
import { installInstructionWriteObservations, observeInstructionBytes } from '../src/observations.ts'
import type { InstructionObservation } from '../src/events.ts'

let ctx: Context | undefined
let root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'instruction-observations-'))
  const context = ctx = new Context()
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(ToolFs)
  installInstructionWriteObservations(context, 1024)
  const driver = await mountAgentLoopTestHarness(context)
  const agent = await driver.create(SessionId('seat-a'), {}, { cwd: root })
  const path = join(root, 'AGENTS.md')
  await writeFile(path, 'original\r\n')
  const seen: InstructionObservation[] = []
  context.on('instructions/written', ({ file }) => { seen.push(file) })
  const settle = () => agentEvents(context, agent).serial('instructions/writes-settling', {})
  return { ctx: context, agent, path, seen, settle }
}

it('hashes raw CRLF bytes after successful write and edit, never normalized result text', async () => {
  const h = await setup()
  for (const [name, args, text] of [
    ['write', { content: 'new\r\n' }, 'new\r\n'],
    ['edit', { old_string: 'new', new_string: 'edited' }, 'edited\r\n'],
  ] as const) {
    const result = await h.ctx.tools.execute({ agent: h.agent, name, callId: ToolCallId(name),
      arguments: { file_path: h.path, ...args }, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    await h.settle()
    expect(h.seen.at(-1)).toMatchObject({ hash: createHash('sha256').update(text).digest('hex'), evidence: { status: 'available' } })
  }
  expect(h.seen).toHaveLength(2)
})

it('marks version-mismatch unavailable instead of hashing a competing write', async () => {
  const h = await setup()
  const target = await h.ctx.fs.resolve(h.path)
  const version = (await h.ctx.fs.stat(target))!.version
  await writeFile(h.path, 'external\n')
  expect(await observeInstructionBytes(h.ctx.fs, target, version, 1024)).toMatchObject({ hash: '', evidence: { status: 'unavailable', reason: 'version-mismatch' } })
})

it('marks read-unavailable when the version-qualified byte read fails', async () => {
  const h = await setup()
  const target = await h.ctx.fs.resolve(h.path)
  const version = (await h.ctx.fs.stat(target))!.version
  vi.spyOn(h.ctx.fs, 'readBytes').mockRejectedValueOnce(new Error('unreadable'))
  expect(await observeInstructionBytes(h.ctx.fs, target, version, 1024)).toMatchObject({ hash: '', evidence: { status: 'unavailable', reason: 'read-unavailable' } })
})

it('marks version-unavailable when no same-execution fs observation exists', async () => {
  const h = await setup()
  const exec: ToolExecution = { agent: h.agent, name: 'write', callId: ToolCallId('write'), rootCallId: ToolCallId('write'),
    token: Symbol('write') as ToolExecutionToken, arguments: { file_path: h.path }, signal: new AbortController().signal }
  h.ctx.emit('tools/result', exec, { isError: false, value: { after: 'normalized\n' }, content: [] })
  await h.settle()
  expect(h.seen).toEqual([{ path: h.path, hash: '', evidence: { status: 'unavailable', reason: 'version-unavailable' } }])
})

it('does not publish successful reads or failed writes as self-write evidence', async () => {
  const h = await setup()
  await h.ctx.tools.execute({ agent: h.agent, name: 'read', callId: ToolCallId('read'),
    arguments: { file_path: h.path }, signal: new AbortController().signal })
  const failed = await h.ctx.tools.execute({ agent: h.agent, name: 'edit', callId: ToolCallId('edit'),
    arguments: { file_path: h.path, old_string: 'absent', new_string: 'replacement' }, signal: new AbortController().signal })
  expect(failed.isError).toBe(true)
  await h.settle()
  expect(h.seen).toEqual([])
})
