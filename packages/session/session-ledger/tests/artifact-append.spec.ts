/** Durable artifact semantics across cached appends, restarts and independent source-mode writers. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '../src/index.ts'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { appendArtifact, ArtifactAppendCache, finishArtifact, JournalViewOwner, readJournalFacts } from '../src/journal.ts'
import { canonicalJson, digest } from '../src/index-store.ts'
import { callStart, options } from './fixtures.ts'

const roots: string[] = []
const pending: Promise<void>[] = []
const children: ReturnType<typeof spawn>[] = []
async function root() {
  const path = await mkdtemp(join(import.meta.dirname, '.artifact-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.allSettled(pending.splice(0))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
function writer(path: string, call: string, start: number, count: number, close = false): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  env.TSX_TSCONFIG_PATH = join(import.meta.dirname, '../../../../tsconfig.json')
  const child = spawn(process.execPath, ['--import', 'tsx/esm', join(import.meta.dirname, 'artifact-child.ts'), path, call, String(start), String(count), close ? 'close' : 'open'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(child)
  const done = new Promise<void>((resolve, reject) => {
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => { if (code === 0) resolve(); else reject(new Error(error)) })
  })
  pending.push(done)
  return done
}

it('retains equal replay, conflicting digests, closure and gap decisions with append hints', async () => {
  const path = await root()
  const cache = new ArtifactAppendCache()
  const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 0, content: '"original"' }
  const first = await appendArtifact(path, input, options, cache)
  expect(first.kind).toBe('appended')
  if (first.kind === 'conflict') throw new Error('Unexpected conflict')
  expect(await appendArtifact(path, input, options, cache)).toEqual({ kind: 'existing', reference: first.reference })
  expect(await appendArtifact(path, { ...input, content: '"changed"' }, options, cache)).toEqual({
    kind: 'conflict', key: { callId: input.callId, kind: input.kind, seq: 0 },
    existingDigest: digest(input.content), incomingDigest: digest('"changed"'),
  })
  await expect(appendArtifact(path, { ...input, seq: 2 }, options, cache)).rejects.toThrow('Artifact sequence must be contiguous')
  await finishArtifact(path, first.reference, options, cache)
  await expect(appendArtifact(path, { ...input, seq: 1 }, options, cache)).rejects.toThrow('Artifact stream is already closed')
  expect((await appendArtifact(path, input, options, cache)).kind).toBe('existing')
})

it('continues a stream after its writer process exits and detects a foreign closure', async () => {
  const path = await root()
  await writer(path, callStart.callId, 0, 2)
  const cache = new ArtifactAppendCache()
  const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 2, content: '{"seq":2}' }
  expect((await appendArtifact(path, input, options, cache)).kind).toBe('appended')
  await writer(path, callStart.callId, 3, 1, true)
  await expect(appendArtifact(path, { ...input, seq: 4 }, options, cache)).rejects.toThrow('Artifact stream is already closed')
})

it('rejects fragments beyond a closure in stream scans, snapshots, queries and imports', async () => {
  const home = await root()
  const ctx = new Context()
  try {
    const ledger = new JournalSessionLedger(ctx, { dshHome: home })
    await ledger.beginCall(callStart)
    const first = await ledger.appendArtifact({ callId: callStart.callId, kind: 'partial-response', seq: 0, content: '0' })
    if (first.kind === 'conflict') throw new Error('Unexpected conflict')
    await ledger.finishArtifact(first.reference)
    const node = join(home, 'ledger/v1', await ledger.nodeId())
    const directory = join(node, `artifacts/${digest(callStart.callId)}/partial-response/1`)
    await mkdir(directory)
    const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 1, content: '1' }
    const payload = { type: 'fragment', input }
    const text = canonicalJson(payload)
    await writeFile(join(directory, 'foreign.jsonl'), canonicalJson({ version: 1, bytes: Buffer.byteLength(text), digest: digest(text), payload }) + '\n')
    const message = 'Artifact closure does not reference the final durable fragment'
    await expect(ledger.snapshot()).rejects.toThrow(message)
    await expect(ledger.query({})).rejects.toThrow(message)
    await expect(ledger.importNode(node)).rejects.toThrow(message)
    await expect(appendArtifact(node, { ...input, seq: 2 }, options, new ArtifactAppendCache())).rejects.toThrow(message)
  } finally { await ctx.fiber.dispose() }
})

it.each(['open-runs', 'waits', 'latest-start'] as const)('rejects fragments beyond a closure through the %s hot reader', async (kind) => {
  const home = await root()
  const ctx = new Context()
  const viewOwner = new JournalViewOwner()
  try {
    const ledger = new JournalSessionLedger(ctx, { dshHome: home })
    await ledger.beginCall(callStart)
    const first = await ledger.appendArtifact({ callId: callStart.callId, kind: 'partial-response', seq: 0, content: '0' })
    if (first.kind === 'conflict') throw new Error('Unexpected conflict')
    await ledger.finishArtifact(first.reference)
    const node = join(home, 'ledger/v1', await ledger.nodeId())
    const selection = { kind, sessionId: callStart.sessionId, nodeId: callStart.nodeId,
      runId: callStart.runId, toolCallIds: [] }
    const read = () => readJournalFacts(node, { ...options, viewOwner }, selection)
    await read()
    const directory = join(node, `artifacts/${digest(callStart.callId)}/partial-response/1`)
    await mkdir(directory)
    const input = { callId: callStart.callId, kind: 'partial-response' as const, seq: 1, content: '1' }
    const payload = { type: 'fragment', input }
    const text = canonicalJson(payload)
    await writeFile(join(directory, 'foreign.jsonl'), canonicalJson({ version: 1, bytes: Buffer.byteLength(text), digest: digest(text), payload }) + '\n')
    const rejection = (error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error && error.constructor).toBe(Error)
      expect(error).toHaveProperty('message', 'Artifact closure does not reference the final durable fragment')
      expect(error).not.toHaveProperty('code')
    }
    await expect(ledger.snapshot()).rejects.toSatisfy((error: unknown) => { rejection(error); return true })
    await expect(read()).rejects.toSatisfy((error: unknown) => { rejection(error); return true })
    await expect(read()).rejects.toSatisfy((error: unknown) => { rejection(error); return true })
  } finally {
    viewOwner.dispose()
    await ctx.fiber.dispose()
  }
})

it('serializes two processes writing separate streams in the same root', async () => {
  const path = await root()
  await Promise.all([writer(path, 'stream-a', 0, 5), writer(path, 'stream-b', 0, 5)])
  for (const callId of ['stream-a', 'stream-b']) {
    const input = { callId: callId as typeof callStart.callId, kind: 'partial-response' as const, seq: 4, content: '{"seq":4}' }
    expect((await appendArtifact(path, input, options, new ArtifactAppendCache())).kind).toBe('existing')
  }
})
