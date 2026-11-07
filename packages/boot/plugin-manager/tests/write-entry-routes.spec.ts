/** Inventory of local file/process tools, with separate owner and application-managed writes. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const groups = ['packages/fs', 'packages/shell', 'packages/terminal', 'packages/ptc-runtime', 'packages/core/tools', 'packages/seat/tool-seat', 'packages/boot/plugin-manager', 'packages/skill/tool-workspace-dependencies']

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'lib', 'dist', 'tests'].includes(entry.name) || entry.isSymbolicLink()) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') && path.includes('/src/') ? [path] : []
  })
}

function declarations(text: string, path: string): string[] {
  // This exact source exports fixtures, not product tool registrations.
  if (relative(repository, path) === 'packages/core/tools/src/testing.ts') return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineTool') {
      const object = node.arguments[0]
      if (object === undefined || !ts.isObjectLiteralExpression(object)) throw new Error(`Unregistered tool factory: ${path}`)
      const name = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'name')
      if (name === undefined || !ts.isPropertyAssignment(name)) throw new Error(`Missing tool name: ${path}`)
      names.push(ts.isStringLiteral(name.initializer) ? name.initializer.text : name.initializer.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names.map(name => `${relative(repository, path)}:${name}`).sort()
}

const registered = [
  'packages/core/tools/src/ptc.ts:RUN_CODE_NAME',
  'packages/boot/plugin-manager/src/tools.ts:plugin_manager',
  'packages/seat/tool-seat/src/directories.ts:seat_directories',
  'packages/seat/tool-seat/src/directories.ts:seat_read',
  'packages/seat/tool-seat/src/directories.ts:seat_write',
  'packages/seat/tool-seat/src/directories.ts:seat_edit',
  'packages/seat/tool-seat/src/report.ts:seat_report',
  'packages/seat/tool-seat/src/report.ts:seat_revoke_report',
  'packages/seat/tool-seat/src/wait.ts:seat_wait',
  'packages/seat/tool-seat/src/wait.ts:seat_cancel_wait',
  'packages/seat/tool-seat/src/windows.ts:seat_windows',
  'packages/seat/tool-seat/src/windows.ts:seat_open',
  'packages/seat/tool-seat/src/windows.ts:`seat_${action}`',
  'packages/seat/tool-seat/src/windows.ts:seat_wake',
  'packages/skill/tool-workspace-dependencies/src/index.ts:load_workspace_dependencies',
  'packages/fs/tool-fs-search/src/glob.ts:glob',
  'packages/fs/tool-fs-search/src/grep.ts:grep',
  'packages/fs/tool-fs/src/edit.ts:edit',
  'packages/fs/tool-fs/src/read-image.ts:read_image',
  'packages/fs/tool-fs/src/read.ts:read',
  'packages/fs/tool-fs/src/write.ts:write',
  'packages/fs/tool-str-replace-editor/src/index.ts:str_replace_editor',
  'packages/shell/tool-bash-persistent/src/index.ts:bash',
  'packages/shell/tool-bash/src/index.ts:bash',
  'packages/shell/tool-pwsh-persistent/src/index.ts:pwsh',
  'packages/shell/tool-pwsh/src/index.ts:pwsh',
].sort()

it('rejects newly declared local model tools until their write route is registered', () => {
  const discovered = groups.flatMap(group => sources(join(repository, group)))
    .flatMap(path => declarations(readFileSync(path, 'utf8'), path)).sort()
  expect(discovered).toEqual(registered)
  const injected = declarations("defineTool({name:'unregistered_write', execute(){}})", join(repository, 'packages/fs/tool-fs/src', 'new.ts'))
  expect([...discovered, ...injected].sort()).not.toEqual(registered)
})

const routes = [
  ['packages/fs/tool-fs/src/write.ts', ['ctx.fs.writeText', 'sandbox.resolvePolicy', 'sandbox.refreshPolicy']],
  ['packages/fs/tool-fs/src/edit.ts', ['ctx.fs.editText', 'sandbox.resolvePolicy', 'sandbox.refreshPolicy']],
  ['packages/fs/tool-str-replace-editor/src/index.ts', ['ctx.fs.writeText', 'policy.resolve']],
  ['packages/fs/tool-fs-search/src/search-core.ts', ['ctx.sandboxPolicy.resolve', 'sandbox.confine', 'argv: confined', 'ctx.subprocess.spawn']],
  ['packages/fs/fs-sandbox/src/index.ts', ['super.writeText(await this.checkedTarget', 'super.editText(await this.checkedTarget']],
  ['packages/shell/tool-bash/src/index.ts', ['sandboxPolicy?.resolve', 'ctx.shell.execute']],
  ['packages/shell/tool-pwsh/src/index.ts', ['sandboxPolicy?.resolve', 'ctx.shell.execute']],
  ['packages/shell/bash-sandbox/src/index.ts', ['this.ctx.sandbox.confine', 'return prepared']],
  ['packages/shell/pwsh-sandbox/src/index.ts', ['this.ctx.sandbox.confine', 'return prepared']],
  ['packages/shell/tool-bash-persistent/src/index.ts', ['ctx.terminals']],
  ['packages/shell/tool-pwsh-persistent/src/index.ts', ['ctx.terminals']],
  ['packages/terminal/terminal-bash/src/index.ts', ['sandbox.confine', 'this.spawnTerminal', 'assertInputPolicy']],
  ['packages/terminal/terminal-bash/src/session.ts', ['this.assertInputPolicy?.()', 'this.terminal.write(input)']],
  ['packages/ptc-runtime/ptc-runtime-node/src/index.ts', ['this.ctx.sandbox.confine', 'argv: confined?.argv ?? argv']],
  ['packages/ptc-runtime/ptc-runtime-node/src/persistent.ts', ['sandbox.confine']],
  ['packages/core/tools/src/ptc.ts', ['functions', 'runtime.run']],
  ['packages/seat/seat-local/src/directories.ts', ['this.fs.writeText', 'this.fs.editText', 'context.admitWrite']],
  ['packages/seat/tool-seat/src/directories.ts', ['directories.write', 'directories.edit']],
  ['packages/boot/plugin-manager/src/tools.ts', ['ownerOnly: true', "outcome !== 'allowed-once'", 'approver.request']],
  ['packages/lsp/lsp-stdio/src/index.ts', ['this.ctx.sandboxPolicy.resolve', 'sandbox.confine', 'spec => ctx.subprocess.spawn(spec)']],
  ['packages/experimental/tool-worktree/src/index.ts', ['ctx.worktrees.create(exec.agent, args, exec.signal)']],
  ['packages/experimental/worktree/src/index.ts', ['this.ctx.sandboxPolicy.resolve({ session: agent.session })', 'runCommand(this.ctx, this.config, policy']],
  ['packages/experimental/worktree/src/process.ts', ['ctx.sandbox.confine(command, { ...policy, mode: policy.mode }', 'ctx.subprocess.spawn']],
] as const

it.each(routes)('retains the registered admission route in %s', (path, required) => {
  const source = readFileSync(join(repository, path), 'utf8')
  for (const token of required) expect(source, `${path}: ${token}`).toContain(token)
})

it('records the application-managed runtime installer separately from confined file tools', () => {
  const source = readFileSync(join(repository, 'packages/skill/tool-workspace-dependencies/src/index.ts'), 'utf8')
  expect(source).toContain('parameters: {}')
  expect(source).toContain('installPrimaryRuntime(config.source, config.root)')
})

it('keeps direct host filesystem and child-process APIs out of local model file tools', () => {
  for (const path of registered.filter(path => path.startsWith('packages/fs/')).map(path => path.slice(0, path.lastIndexOf(':')))) {
    const source = ts.createSourceFile(path, readFileSync(join(repository, path), 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      expect(['node:fs', 'node:fs/promises', 'fs', 'fs/promises', 'node:child_process', 'child_process'], dirname(path)).not.toContain(statement.moduleSpecifier.text)
    }
  }
})
