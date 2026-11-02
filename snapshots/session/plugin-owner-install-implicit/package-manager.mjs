/** Offline pnpm process substitute used only by the owner-install session snapshots. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args[0] === 'config' && args[1] === 'get') {
  process.stdout.write('https://registry.npmjs.org/\n')
} else if (args[0] === 'view') {
  process.exitCode = 1
} else if (args[0] === 'add' && args[1] === 'owner-addon') {
  const dir = process.cwd()
  const bundle = join(dir, 'node_modules', 'owner-addon')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'owner-addon', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'owner-addon', name: './plugin.mjs' }] }]))
  writeFileSync(join(bundle, 'plugin.mjs'), 'export function apply(ctx) { ctx.provide("ownerAddonProbe", true) }\n')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, 'owner-addon': '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  process.stdout.write('Installed owner-addon\n')
} else {
  throw new Error(`Unexpected package operation: ${JSON.stringify(args)}`)
}
