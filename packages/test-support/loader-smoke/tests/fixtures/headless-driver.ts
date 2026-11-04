#!/usr/bin/env node
/** Snapshot-only Loader driver: stream one fixture turn as canonical JSONL. */

import { fileURLToPath } from 'node:url'
import type { Context, FiberState } from '@panedesk/cordis'
import { installFailLoud, loadEnv, resolveConfigPath } from '@panedesk/dsh-app-boot'
import { runFixtureTurn } from '@panedesk/dsh-loader-smoke'
import type { SessionEvent } from '@panedesk/dsh-session'
import { bootProductionProfile } from './production-profile.ts'

const NAME = 'headless-test-driver'
const REQUIRED_ENTRY_ENV = 'DSH_LOADER_SMOKE_REQUIRED_ENTRY_ID'
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
const startupFailure = Promise.withResolvers<{ error: unknown }>()
try {
  loadEnv(NAME)
  ctx = await bootProductionProfile({
    binName: NAME,
    profile: 'headless',
    prepare: (scope) => {
      scope.on('agent-loop/config-start-failed', ({ error }) => { startupFailure.resolve({ error }) })
    },
    overlayPaths: [resolveConfigPath(configPath, undefined), fileURLToPath(new URL('./cache-disabled.patch.yml', import.meta.url))],
  })
  const requiredEntryId = process.env[REQUIRED_ENTRY_ENV]
  if (requiredEntryId !== undefined) {
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === requiredEntryId)
    if (entry === undefined) throw new Error(`${NAME}: required fixture entry not found: ${requiredEntryId}`)
    if (entry.fiber === undefined) throw new Error(`${NAME}: required fixture entry failed to import: ${requiredEntryId}`)
    await entry.fiber.await()
    if (entry.fiber.state !== FIBER_ACTIVE) {
      throw new Error(`${NAME}: required fixture entry did not activate: ${requiredEntryId}`)
    }
  }
  if (ctx.get('agents')?.roots().length === 0) {
    for (const entry of ctx.loader.entries()) {
      if (entry.fiber?.state === FIBER_FAILED) await entry.fiber.await()
    }
  }
  const result = await Promise.race([startupFailure.promise, runFixtureTurn(ctx, {
    task: taskParts.join(' '),
    onEvent: (sessionId: string, event: SessionEvent) => {
      process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
    },
  })])
  if ('error' in result) throw result.error
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
