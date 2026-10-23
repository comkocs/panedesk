/** Loader unload/reload retains no seat-owned listeners, timers or file descriptors. */
import { expect, it } from 'vitest'
import { createHook } from 'node:async_hooks'
import { setImmediate } from 'node:timers/promises'
import { readdir, readlink } from 'node:fs/promises'
import { createHost } from './fixtures/e2e-host.ts'

it('returns lifecycle counters to baseline across two seat profile reloads', async () => {
  const f = await createHost()
  const timers = new Map<number, { _destroyed?: boolean }>()
  const hook = createHook({ init(id, type, _trigger, resource) {
    if (type === 'Timeout') timers.set(id, resource)
  }, destroy(id) { timers.delete(id) } }).enable()
  const counters = async () => {
    await setImmediate()
    const descriptors = await readdir('/proc/self/fd')
    const targets = await Promise.all(descriptors.map(async (fd) => {
      try { return await readlink(`/proc/self/fd/${fd}`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
    }))
    return {
      listeners: Object.values(f.ctx.events._hooks).reduce((count, hooks) => count + hooks.length, 0),
      timers: [...timers.values()].filter(timer => !timer._destroyed).length,
      files: targets.filter(path => path.startsWith(f.root)).length,
      ready: f.ready.size,
    }
  }
  try {
    const before = await counters()
    for (let generation = 0; generation < 2; generation++) {
      await f.mount()
      const mounted = await counters()
      expect(mounted.listeners).toBeGreaterThan(before.listeners)
      expect(mounted.ready).toBe(before.ready + 1)
      expect(f.ctx.get('seatRemote')).toBeDefined()
      await f.unmount()
      expect(f.ctx.get('seats')).toBeUndefined()
      expect(f.ctx.get('seatEngine')).toBeUndefined()
      expect(f.ctx.get('seatGates')).toBeUndefined()
      const after = await counters()
      process.stdout.write(JSON.stringify({ generation, before, mounted, after }) + '\n')
      expect(after).toEqual(before)
    }
  } finally { hook.disable(); await f.close() }
}, 30000)
