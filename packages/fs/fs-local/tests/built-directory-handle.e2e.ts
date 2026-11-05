/** Built host filesystem operations retain directory anchors and refuse missing Linux capabilities. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const builtEntry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const execute = promisify(execFile)

it.skipIf(process.platform !== 'linux' || !existsSync(builtEntry))('anchors built Linux writes and refuses a host without O_DIRECTORY', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { registerHooks } from 'node:module'
    import { mkdtemp, readFile, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    const [entry, mode] = process.argv.slice(1)
    assert.notEqual(process.title, 'dsh-webworker')
    if (mode === 'missing') {
      const bridge = 'data:text/javascript,' + encodeURIComponent(\`
        import fs from 'node:fs'
        export * from 'node:fs'
        export default fs
        export const constants = { ...fs.constants }
        delete constants.O_DIRECTORY
      \`)
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === 'node:fs' && context.parentURL === pathToFileURL(entry).href) {
            return { url: bridge, shortCircuit: true }
          }
          return nextResolve(specifier, context)
        },
      })
    }
    const root = await mkdtemp(join(tmpdir(), 'built-directory-handle-'))
    try {
      let result
      try {
        const { Context } = await import('@panedesk/cordis')
        const { LocalFileSystem } = await import(pathToFileURL(entry).href)
        const ctx = new Context()
        const fiber = await ctx.plugin(LocalFileSystem, { cwd: root })
        try {
          const anchors = []
          ctx.fs.internals.inspectTemp = ({ stagingDir, tempPath }) => {
            anchors.push(stagingDir, tempPath)
          }
          const target = await ctx.fs.resolve('result.txt')
          await ctx.fs.writeText(target, 'anchored')
          result = { refused: false, anchors, content: await readFile(join(root, 'result.txt'), 'utf8') }
        } finally {
          await fiber.dispose()
        }
      } catch (error) {
        result = { refused: true, name: error.name, code: error.code, message: error.message }
      }
      console.log(JSON.stringify(result))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  `
  const host = await execute(process.execPath, ['--input-type=module', '-e', script, builtEntry, 'host'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000,
  })
  const anchored: unknown = JSON.parse(host.stdout.trim())
  assert(anchored !== null && typeof anchored === 'object')
  assert('refused' in anchored && 'content' in anchored && 'anchors' in anchored)
  expect(anchored.refused, host.stdout).toBe(false)
  expect(anchored.content).toBe('anchored')
  assert(Array.isArray(anchored.anchors))
  expect(anchored.anchors).toHaveLength(2)
  for (const anchor of anchored.anchors) expect(anchor).toMatch(/^\/proc\/self\/fd\/\d+\//)

  const missing = await execute(process.execPath, ['--input-type=module', '-e', script, builtEntry, 'missing'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000,
  })
  const refused: unknown = JSON.parse(missing.stdout.trim())
  assert(refused !== null && typeof refused === 'object')
  assert('refused' in refused && 'name' in refused && 'code' in refused && 'message' in refused)
  expect(refused.refused, missing.stdout).toBe(true)
  expect(refused.name).toBe('FsError')
  expect(refused.code).toBe('FS_IO_ERROR')
  expect(refused.message).toBe('Linux filesystem requires O_DIRECTORY; refusing to fall back to path-based operations. Use a runtime with directory-handle support.')
}, 70_000)
