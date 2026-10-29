import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { SessionEvent } from '@panedesk/dsh-session'
import { runLoaderSmoke } from '@panedesk/dsh-loader-smoke'

const fixtures = new URL('./fixtures/loader/', import.meta.url)

it('resolves an inherited parent selection inside a complete SDK child runtime', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '.sdk-cache-composition-'))
  const childHome = join(root, 'child')
  const childPatch = join(root, 'child.patch.yml')
  const parentPatch = join(root, 'parent.patch.yml')
  try {
    const childConfig = (await readFile(new URL('child.patch.yml', fixtures), 'utf8'))
      .replace("'./child-mock-llm.ts'", JSON.stringify(new URL('child-mock-llm.ts', fixtures).href))
    await writeFile(childPatch, `${childConfig}\n- id: llm-cache\n  config:\n    routes:\n      - provider: mock\n        modelFamily: openai\n        capability: openai-responses\n`)
    const parentConfig = (await readFile(new URL('dsh-sdk.patch.yml', fixtures), 'utf8'))
      .replace("'./mock-delegating-llm.ts'", JSON.stringify(new URL('mock-delegating-llm.ts', fixtures).href))
      .replace("'./scoped-tool-subagent.ts'", JSON.stringify(new URL('scoped-tool-subagent.ts', fixtures).href))
    await writeFile(parentPatch, `${parentConfig}\n- id: llm-cache\n  config:\n    policy:\n      retention: 5m\n    routes:\n      - provider: mock\n        modelFamily: anthropic\n        capability: anthropic\n`)
    await runLoaderSmoke({
      label: 'inherited SDK child cache',
      tempDirPrefix: 'cache-composition-workspace-',
      tempDirParent: root,
      binScript: fileURLToPath(new URL('driver.ts', fixtures)),
      libBinScript: fileURLToPath(new URL('driver.ts', fixtures)),
      configPath: parentPatch,
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
      processTimeoutMs: 120_000,
      env: {
        DSH_TEST_CHILD_HOME: childHome,
        DSH_TEST_CHILD_PATCHES: JSON.stringify([childPatch]),
      },
      inspect: async () => {
        async function logs(path: string): Promise<string[]> {
          const entries = await readdir(path, { withFileTypes: true })
          return (await Promise.all(entries.map(entry => entry.isDirectory() ? logs(join(path, entry.name))
            : Promise.resolve(entry.name.endsWith('.jsonl') ? [join(path, entry.name)] : [])))).flat()
        }
        const sessionLogs = await logs(join(childHome, 'sessions'))
        expect(sessionLogs).toHaveLength(1)
        const events: SessionEvent[] = (await readFile(sessionLogs[0]!, 'utf8')).trim().split('\n').slice(1)
          .map(line => JSON.parse(line) as SessionEvent)
        const header = events.find(event => event.type === 'request/header')
        expect(header?.type === 'request/header' ? header.data.header.config.cache?.retention : undefined).toBe('12h')
        const ledgerLogs = await logs(join(childHome, 'ledger'))
        const evidence = (await Promise.all(ledgerLogs.map(path => readFile(path, 'utf8')))).join('\n')
        expect(evidence).toContain('"retention":"12h"')
        expect(evidence).toContain('"ttlSeconds":43200')
        expect(evidence).toContain('"sessionPolicy":{"retention":"default"}')
      },
    })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 135_000)
