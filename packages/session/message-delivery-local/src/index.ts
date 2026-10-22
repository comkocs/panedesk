/** Lease-backed local mailbox registration; delivery attaches to the same host lifecycle. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-agent'
import type {} from '@panedesk/dsh-session-persistence'
import type {} from '@panedesk/dsh-subprocess'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import { setTimeout as wait } from 'node:timers/promises'
import { FileMailbox } from './mailbox.ts'
import { NodeRegistry } from './registry.ts'
import { MailboxUnavailableError, privateDirectory } from './files.ts'
import { inspectWindowsAcl } from './windows-permissions.ts'

/** Explicit local storage and heartbeat limits. */
export interface Config {
  readonly dshHome?: string
  readonly nodeId: string
  readonly maxRecordBytes: number
  readonly lockTimeoutMs: number
  readonly lockRetryMs: number
  readonly scanIntervalMs: number
}

/** Local node registration plugin identity. */
export const name = 'message-delivery-local'
/** Only hosts with persistence may advertise owned Sessions. */
export const inject = { required: ['agents', 'sessionPersistence'], optional: ['subprocess'] }

/** Register already-leased Agents and remove registrations only after their release.
 * @param ctx - host lifecycle context.
 * @param config - explicit node storage configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const value of [config.maxRecordBytes, config.lockTimeoutMs, config.lockRetryMs, config.scanIntervalMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new MailboxUnavailableError('Mailbox limits must be positive integers')
  }
  if (config.scanIntervalMs > 1000) throw new MailboxUnavailableError('Mailbox scan interval must not exceed one second')
  const home = resolveDshHome(config.dshHome)
  await privateDirectory(home)
  if (process.platform === 'win32') await inspectWindowsAcl(home)
  const mailbox = new FileMailbox({ ...config, home })
  await mailbox.initialize()
  const subprocess = ctx.get('subprocess')
  const registry = new NodeRegistry(mailbox, subprocess ? pid => subprocess.readProcessIdentity(pid) : undefined)
  const tasks = new Set<Promise<void>>()
  const track = (work: Promise<void>): void => {
    const observed = work.catch((error: unknown) => { ctx.logger.error('Mailbox registration failed', error) })
    tasks.add(observed)
    void observed.then(() => { tasks.delete(observed) })
  }
  ctx.on('agent/created', async ({ agent }) => {
    await registry.register(agent.id, agent.status === 'running' ? 'busy' : 'idle')
  })
  ctx.on('agent/status', ({ agent, status }) => { track(registry.update(agent.id, status === 'running' ? 'busy' : 'idle')) })
  ctx.on('agent/ending', async ({ agent }) => { await registry.update(agent.id, 'closing') })
  ctx.on('agent/disposed', ({ agent }) => { track(registry.unregister(agent.id)) })
  ctx.effect(() => {
    const lifetime = new AbortController()
    const scanning = (async () => {
      while (!lifetime.signal.aborted) {
        try { await wait(config.scanIntervalMs, undefined, { signal: lifetime.signal }) } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') break
          throw error
        }
        await registry.heartbeat()
      }
    })()
    // Observe failure immediately; disposal still awaits the original task and reports it.
    void scanning.catch((error: unknown) => { ctx.logger.error('Mailbox heartbeat failed', error) })
    return async () => {
      lifetime.abort()
      await scanning
      await Promise.all([...tasks])
      await registry.dispose()
    }
  })
}
