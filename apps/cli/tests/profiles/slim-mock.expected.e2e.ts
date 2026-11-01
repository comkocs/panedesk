/** Keyless smoke of the public slim launcher, real file tool, and clean one-shot shutdown. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@panedesk/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixtures = new URL('./slim/fixtures/', import.meta.url)
const guard = fileURLToPath(new URL('network-guard.mjs', fixtures))
const task = 'Read message.txt exactly once and report its contents.'
const answer = 'Read complete: SLIM_FILE_CONTENT'

type JsonRow = Record<string, unknown>

function rows(text: string): JsonRow[] {
  return text.trim().split('\n').map(line => JSON.parse(line) as JsonRow)
}

describe('slim mock agent loop', () => {
  it('reads one fixture through the public slim launcher and exits without network access', async () => {
    const result = await runLoaderSmoke({
      label: 'slim mock agent loop', binScript, tsconfigPath, sourceImport: 'tsx/esm',
      tempDirPrefix: 'slim-mock-', configPath: '',
      binArgs: ['--profile', 'slim', '--patch', './mock.patch.json', '--json', task],
      env: {
        PANEDESK_TELEMETRY_DISABLED: '1',
        PANEDESK_TOOLS_MODE: undefined,
        DEEPSEEK_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined,
        DSH_SNAPSHOT_FILE: undefined, DSH_SNAPSHOT_OVERRIDE: undefined, DSH_SNAPSHOT_CHILD_FILES: undefined,
        NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
        SLIM_SMOKE_NETWORK_LOG: './network.json',
      },
      prepare: async (cwd) => {
        await writeFile(join(cwd, 'message.txt'), await readFile(new URL('message.txt', fixtures)))
        await writeFile(join(cwd, 'mock.patch.json'), JSON.stringify([
          { id: 'agent-default-model', config: { provider: 'slim-replay', model: 'slim-mock' } },
          { insert: [{ id: 'slim-smoke-replay', name: fileURLToPath(new URL('replay-observer.ts', fixtures)), config: {
            file: fileURLToPath(new URL('session.v4.jsonl', fixtures)),
            overrideFile: fileURLToPath(new URL('replay.override.json', fixtures)),
            requestsFile: join(cwd, 'requests.json'),
            providers: [{ id: 'slim-replay', models: [{ id: 'slim-mock', contextWindow: 32768 }] }],
          } }] },
        ]))
      },
      inspect: async (cwd) => {
        const evidence = JSON.parse(await readFile(join(cwd, 'requests.json'), 'utf8')) as {
          path: string
          requests: Array<{ provider: string; model: string; messages: JsonRow[] }>
        }
        expect(evidence.path).toBe('llm/stream')
        expect(evidence.requests).toHaveLength(2)
        expect(evidence.requests.map(request => [request.provider, request.model]))
          .toEqual([['slim-replay', 'slim-mock'], ['slim-replay', 'slim-mock']])
        expect(JSON.stringify(evidence.requests[0]?.messages)).toContain(task)
        expect(evidence.requests[0]?.messages.filter(message =>
          message.role === 'user' && JSON.stringify(message).includes(task))).toHaveLength(1)
        expect(evidence.requests[0]?.messages.filter(message => message.role === 'tool')).toHaveLength(0)
        const tools = evidence.requests[1]?.messages.filter(message => message.role === 'tool')
        expect(tools).toHaveLength(1)
        expect(JSON.stringify(tools)).toContain('SLIM_FILE_CONTENT')
        expect(await readFile(join(cwd, 'message.txt'), 'utf8')).toBe('SLIM_FILE_CONTENT\n')
        expect(JSON.parse(await readFile(join(cwd, 'network.json'), 'utf8'))).toEqual({ attempts: [] })
      },
    })
    const events = rows(result.stdout)
    expect(events[0]).toMatchObject({ type: 'session' })
    expect(events.filter(event => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', callId: 'slim-read', tool: 'read', input: { file_path: 'message.txt' } },
    ])
    const results = events.filter(event => event.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ callId: 'slim-read', status: 'completed' })
    expect(results[0]?.result).toContain('SLIM_FILE_CONTENT')
    expect(events.filter(event => event.type === 'final')).toEqual([{ type: 'final', text: answer }])
    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(events.filter(event => event.type === 'status' && event.phase === 'turn_end'))
      .toMatchObject([{ reason: { kind: 'completed' } }])
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('rejects a socket connection before it can reach the network', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'slim-network-guard-'))
    try {
      const log = join(cwd, 'network.json')
      const result = await execa(process.execPath, ['--import', guard, '--input-type=module', '-e',
        "import net from 'node:net'; net.connect({host: 'localhost', port: 9})"], {
        cwd, env: { NODE_OPTIONS: '', SLIM_SMOKE_NETWORK_LOG: log }, reject: false,
      })
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('slim smoke forbids network access: socket.connect')
      expect(JSON.parse(await readFile(log, 'utf8'))).toEqual({ attempts: ['socket.connect'] })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
