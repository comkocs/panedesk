/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; flock uses stable Node-API with separate Linux libc builds.
 * Node headers come from the Node installation running this script.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    'host-addon-only': { type: 'boolean' },
    target: { type: 'string' },
    zig: { type: 'string' },
    'node-api-headers': { type: 'string' },
    'output-dir': { type: 'string' },
    'temporary-dir': { type: 'string' },
  },
  allowPositionals: false,
})
const hostAddonOnly = values['host-addon-only'] === true
const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  flock: 'packages/entry/src/flock.c',
  'windows-private-files': 'packages/entry/src/windows-private-files.c',
}

interface Binary {
  tool: string
  kind: string
  path: string
  napi?: number
  libc?: string
}

if (values.target !== undefined) {
  if (values.target !== 'win32-x64' || process.platform !== 'linux') {
    throw new Error('build: cross compilation supports only win32-x64 from Linux')
  }
  if (hostAddonOnly || !values.zig || !values['node-api-headers'] || !values['output-dir'] || !values['temporary-dir']) {
    throw new Error('build: cross compilation requires --zig, --node-api-headers, --output-dir and --temporary-dir without --host-addon-only')
  }
  const zig = resolve(values.zig)
  const api = resolve(values['node-api-headers'])
  const destination = resolve(values['output-dir'])
  const temporaryRoot = resolve(values['temporary-dir'])
  const spec = JSON.parse(readFileSync(join(root, 'packages/win32-x64/prebuilds.json'), 'utf8')) as { platform: string; binaries: Binary[] }
  if (spec.platform !== values.target || spec.binaries.length !== 1) {
    throw new Error('build: unexpected Windows x64 prebuild metadata')
  }
  const binary = spec.binaries[0]
  if (binary?.tool !== 'windows-private-files' || binary.kind !== 'node-api' || binary.napi !== 8 || binary.path !== 'bin/system.node') {
    throw new Error('build: unsupported Windows x64 binary declaration')
  }
  for (const file of ['include/node_api.h', 'def/node_api.def']) {
    if (!existsSync(join(api, file))) throw new Error(`build: node-api-headers missing ${file}`)
  }
  mkdirSync(temporaryRoot, { recursive: true })
  const temporary = mkdtempSync(join(temporaryRoot, 'cross-build-'))
  const output = join(destination, binary.path)
  mkdirSync(dirname(output), { recursive: true })
  const run = (args: string[]): void => {
    const result = spawnSync(zig, args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('build: Zig failed for Windows x64')
  }
  try {
    const library = join(temporary, 'node.lib')
    run(['dlltool', '-m', 'i386:x86-64', '-d', join(api, 'def/node_api.def'), '-D', 'node.exe', '-l', library])
    const pending = join(temporary, 'system.node')
    run(['cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-shared', '-DNAPI_VERSION=8', '-I', join(api, 'include'), join(root, 'packages/entry/src/windows-private-files.c'),
      library, '-ladvapi32', '-o', pending])
    renameSync(pending, output)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  console.log(`build: built ${values.target}/${binary.path}`)
  process.exit(0)
}
if (values.zig !== undefined || values['node-api-headers'] !== undefined || values['output-dir'] !== undefined || values['temporary-dir'] !== undefined) {
  throw new Error('build: cross compilation options require --target win32-x64')
}

if (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'win32') {
  if (hostAddonOnly) process.exit(0)
  throw new Error('build: system binaries are built on Linux, macOS or Windows; no native target for this host')
}
const host = `${process.platform}-${process.arch}`
const libc = process.platform === 'linux'
  ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
  : undefined
const headers = resolve(dirname(process.execPath), '../include/node')
let built = 0

for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name)
  const metadata = join(dir, 'prebuilds.json')
  if (!existsSync(metadata)) continue
  const spec = JSON.parse(readFileSync(metadata, 'utf8')) as { platform: string; binaries: Binary[] }
  if (spec.platform !== host) continue

  for (const binary of spec.binaries) {
    if (hostAddonOnly && (binary.kind !== 'node-api' || (binary.libc !== undefined && binary.libc !== libc))) continue
    const source = sources[binary.tool]
    if (source === undefined) throw new Error(`build: unknown tool ${binary.tool}`)
    const output = join(dir, binary.path)
    mkdirSync(dirname(output), { recursive: true })
    let compiler: string
    let flags: string[]

    if (process.platform === 'win32' && binary.kind === 'node-api' && binary.tool === 'windows-private-files' && binary.napi === 8) {
      const windowsHeaders = join(dirname(process.execPath), 'include', 'node')
      const windowsLibrary = join(dirname(process.execPath), 'node.lib')
      if (!existsSync(join(windowsHeaders, 'node_api.h')) || !existsSync(windowsLibrary)) {
        throw new Error('build: Windows requires include/node headers and node.lib beside node.exe')
      }
      compiler = 'cl.exe'
      flags = ['/nologo', '/O2', '/W4', '/WX', '/LD', '/DNAPI_VERSION=8', `/I${windowsHeaders}`]
    } else if (binary.kind === 'static-musl' && process.platform === 'linux' && binary.tool === 'landlock-run') {
      compiler = 'musl-gcc'
      flags = ['-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-static', '-s']
    } else if (binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8) {
      if (!existsSync(join(headers, 'node_api.h'))) {
        throw new Error(`build: Node-API headers missing at ${headers}; use a Node installation with development headers`)
      }
      compiler = process.platform === 'linux' && binary.libc === 'musl' ? 'musl-gcc' : 'cc'
      flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers]
      if (process.platform === 'darwin') {
        if (binary.libc !== undefined) throw new Error('build: macOS flock does not select a Linux libc')
        flags.push('-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0')
      } else {
        if (binary.libc !== 'glibc' && binary.libc !== 'musl') {
          throw new Error('build: Linux flock must select glibc or musl')
        }
        flags.push('-shared')
      }
    } else {
      throw new Error(`build: unsupported ${binary.tool}/${binary.kind} target on ${host}`)
    }

    mkdirSync(join(root, '.release'), { recursive: true })
    const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
    try {
      const pending = join(temporary, basename(output))
      const args = process.platform === 'win32'
        ? [...flags, `/Fo${join(temporary, 'system.obj')}`, join(root, source), '/link', `/OUT:${pending}`,
          join(dirname(process.execPath), 'node.lib'), 'advapi32.lib']
        : [...flags, '-o', pending, join(root, source)]
      const result = spawnSync(compiler, args, { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`build: ${compiler} failed for ${binary.path}`)
      // Readers never see a truncated addon when source checks build concurrently.
      renameSync(pending, output)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    console.log(`build: built ${basename(dir)}/${binary.path}`)
    built++
  }
}
if (built === 0) throw new Error(`build: no declared binaries for ${host}`)
