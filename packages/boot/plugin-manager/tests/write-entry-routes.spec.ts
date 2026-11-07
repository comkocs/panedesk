/** Inventory of local file/process tools, with separate owner and application-managed writes. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { collectToolCatalog } from '../../../../scripts/gen-tool-catalog.ts'
import { pendingAdmissionEvidence } from './admission-evidence.ts'

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
  ['packages/fs/fs-sandbox/src/index.ts', ['super.writeText(await this.checkedTarget', 'super.editText(await this.checkedTarget', 'protected-host-path']],
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

const readOnly = [
  ['@panedesk/dsh-tool-fs', 'read', 'packages/fs/tool-fs/src/read.ts',
    'read cannot write a protected input through extra model arguments'],
  ['@panedesk/dsh-tool-jobs', 'job_list', 'packages/jobs/tool-jobs/src/index.ts',
    'job_list cannot write a protected input through extra model arguments'],
  ['@panedesk/dsh-tool-jobs', 'job_output', 'packages/jobs/tool-jobs/src/index.ts',
    'job_output cannot write a protected input through extra model arguments'],
  ['@panedesk/dsh-tool-cordis', 'cordis_inspect_list', 'packages/extensions/tool-cordis/src/index.ts',
    'cordis_inspect_list cannot write a protected input through extra model arguments'],
  ['@panedesk/dsh-tool-goal', 'get_goal', 'packages/goal/tool-goal/src/index.ts',
    'get_goal cannot write protected inputs or append goal state through extra model arguments'],
] as const

function executionProofs(text: string): Set<string> {
  const source = ts.createSourceFile('tool-admission-coverage.spec.ts', text, ts.ScriptTarget.Latest, true)
  const tests = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === 'it')
      || (ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
        && ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === 'it'
        && ['each', 'for'].includes(node.expression.expression.name.text)))) {
      const [name, optionsOrBody, configuredBody] = node.arguments
      const body = optionsOrBody !== undefined && ts.isObjectLiteralExpression(optionsOrBody)
        ? configuredBody : optionsOrBody
      if (name !== undefined && ts.isStringLiteral(name) && body !== undefined
        && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) tests.add(name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return tests
}

function missingExecutionProofs(tests: ReadonlySet<string>): string[] {
  return readOnly.flatMap(([, name, , proof]) => tests.has(proof) ? [] : [`${name}: ${proof}`])
}

it('requires an executable test for every explicit read-only declaration', () => {
  const path = join(repository, 'packages/boot/plugin-manager/tests/tool-admission-coverage.spec.ts')
  const tests = executionProofs(readFileSync(path, 'utf8'))
  expect(missingExecutionProofs(tests)).toEqual([])
  for (const [, name, path] of readOnly) {
    expect(declarations(readFileSync(join(repository, path), 'utf8'), join(repository, path)))
      .toContain(`${path}:${name}`)
  }
})

it('rejects a read-only declaration when its executable proof is removed or skipped', () => {
  const path = join(repository, 'packages/boot/plugin-manager/tests/tool-admission-coverage.spec.ts')
  const text = readFileSync(path, 'utf8')
  for (const [, name, , proof] of readOnly) {
    const withoutProof = text.replace(`it('${proof}'`, `it.skip('${proof}'`)
    expect(missingExecutionProofs(executionProofs(withoutProof))).toContain(`${name}: ${proof}`)
  }
})

type WriteCategory = 'A' | 'B' | 'C' | 'D' | 'E'

interface ToolClassification {
  pkg: string
  names: readonly string[]
  category: WriteCategory
  evidence: string
  /** Admission source for A/B, fixed storage owner for C, provider for D. */
  owner: string
}

// Evidence titles refer to executable cells, not callbacks with invented write effects.
const classifications: readonly ToolClassification[] = [
  { pkg: 'plugin-manager', names: ['plugin_manager'], category: 'C', owner: 'profileContext.dir; owner-approved management only', evidence: 'plugin_manager denies protected profile changes without an owner decision through the real Loader' },
  { pkg: 'plugin-market', names: ['plugin_market'], category: 'D', owner: 'PluginMarket HTTP indexes', evidence: 'plugin_market reads its HTTP index without a model-controlled write destination' },
  { pkg: 'mcp-resources', names: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'], category: 'D', owner: 'MCP request provider', evidence: '%s delegates resource reads without a model-controlled write destination' },
  { pkg: 'experimental-browser-use-stagehand-native', names: ['stagehand_act', 'stagehand_extract', 'stagehand_navigate', 'stagehand_observe', 'stagehand_screenshot', 'stagehand_tabs'], category: 'B', owner: 'browser acquisition requires a confined launcher', evidence: '%s confines browser acquisition before executing model instructions' },
  { pkg: 'tool-ask-user', names: ['ask_user_question'], category: 'D', owner: 'UserQuestions owner interaction', evidence: 'ask_user_question delegates a live caller question without filesystem writes' },
  { pkg: 'tools', names: ['run_code'], category: 'B', owner: 'packages/core/tools/src/ptc.ts', evidence: 'run_code denies a protected input through the real Node process sandbox' },
  { pkg: 'plan-mode', names: ['exit_plan_mode'], category: 'D', owner: 'UserQuestions owner review', evidence: 'exit_plan_mode delegates review without a model-controlled write destination' },
  { pkg: 'tool-bash', names: ['bash'], category: 'B', owner: 'packages/shell/tool-bash/src/index.ts', evidence: 'bash denies a protected input through the real local process sandbox' },
  { pkg: 'tool-present', names: ['present'], category: 'C', owner: 'Session persistence root; deliverables/presented', evidence: 'present retains protected input bytes while declaring a real delivery' },
  { pkg: 'tool-pwsh', names: ['pwsh'], category: 'B', owner: 'packages/shell/tool-pwsh/src/index.ts', evidence: 'pwsh denies a protected input through the real local process sandbox' },
  { pkg: 'tool-cordis', names: ['cordis_inspect_list'], category: 'E', owner: 'in-memory provider manifests', evidence: 'cordis_inspect_list cannot write a protected input through extra model arguments' },
  { pkg: 'tool-cordis', names: ['cordis_inspect_query'], category: 'D', owner: 'Cordis inspect host providers', evidence: 'cordis_inspect_query reads the real host service catalog without filesystem writes' },
  { pkg: 'tool-bash-persistent', names: ['bash'], category: 'B', owner: 'packages/shell/tool-bash-persistent/src/index.ts', evidence: '%s persistent executes through the real terminal backend' },
  { pkg: 'tool-pwsh-persistent', names: ['pwsh'], category: 'B', owner: 'packages/shell/tool-pwsh-persistent/src/index.ts', evidence: '%s persistent executes through the real terminal backend' },
  { pkg: 'tool-str-replace-editor', names: ['str_replace_editor'], category: 'A', owner: 'packages/fs/tool-str-replace-editor/src/index.ts', evidence: '%s denies a protected input through the real filesystem' },
  { pkg: 'tool-fs', names: ['edit', 'write'], category: 'A', owner: 'packages/fs/fs-sandbox/src/index.ts', evidence: '%s denies a protected input through the real filesystem' },
  { pkg: 'tool-fs', names: ['read'], category: 'E', owner: 'ctx.fs.readText', evidence: 'read cannot write a protected input through extra model arguments' },
  { pkg: 'tool-fs', names: ['read_image'], category: 'C', owner: 'AttachmentStore dshHome/content-addressed image storage', evidence: 'read_image stores attachments only under the configured application root' },
  { pkg: 'tool-fs-search', names: ['glob', 'grep'], category: 'B', owner: 'packages/fs/tool-fs-search/src/search-core.ts', evidence: '%s confines the search process and retains protected inputs' },
  { pkg: 'tool-terminal', names: ['terminal_open', 'terminal_send'], category: 'B', owner: 'packages/terminal/terminal-bash/src/index.ts', evidence: '%s denies protected writes through the real terminal backend' },
  { pkg: 'tool-terminal', names: ['terminal_list', 'terminal_read', 'terminal_signal', 'terminal_close'], category: 'E', owner: 'TerminalSessionService owned session controls', evidence: '%s only observes or controls the calling session terminal' },
  { pkg: 'tool-goal', names: ['create_goal', 'update_goal'], category: 'C', owner: 'Session persistence root; goal events', evidence: '%s stores authorized goal changes without model-controlled storage paths' },
  { pkg: 'tool-goal', names: ['get_goal'], category: 'E', owner: 'in-memory goal projection', evidence: 'get_goal cannot write protected inputs or append goal state through extra model arguments' },
  { pkg: 'tool-schedule', names: ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update'], category: 'C', owner: 'StorageDomain schedule state under configured storage root', evidence: '%s keeps schedule state under the configured application root' },
  { pkg: 'tool-lsp', names: ['lsp'], category: 'B', owner: 'packages/lsp/lsp-stdio/src/index.ts', evidence: 'lsp confines a real stdio server and retains protected inputs' },
  { pkg: 'tool-ralph', names: ['ralph'], category: 'B', owner: 'packages/ptc-runtime/ptc-runtime-node/src/index.ts', evidence: '%s retains protected inputs through the real PTC workflow engine' },
  { pkg: 'tool-seat-messages', names: ['seat_list_online'], category: 'C', owner: 'SeatEngine home and MessageDelivery dshHome mailbox', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat-messages', names: ['seat_send'], category: 'C', owner: 'MessageDelivery dshHome/messages/nodes; Session persistence root', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_renew', 'seat_replace'], category: 'C', owner: 'SeatLocal directory; SeatEngine home; StorageDomain root', evidence: '%s keeps seat state under configured application roots' },
  { pkg: 'tool-seat', names: ['seat_open'], category: 'C', owner: 'SeatEngine event root; MessageDelivery mailbox; Session persistence root', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_windows'], category: 'C', owner: 'SeatEngine home/ledger/engine/v1/nodeId/events; recovered Session persistence root', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_wake'], category: 'C', owner: 'MessageDelivery dshHome/messages/nodes; SeatEngine event root', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_close'], category: 'C', owner: 'SeatEngine event root; workspace StorageDomain; Session persistence root', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_wait', 'seat_cancel_wait'], category: 'C', owner: 'SeatEngine home/ledger/engine/v1/nodeId/events', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_rename'], category: 'C', owner: 'Session persistence root; StorageDomain seat_renames receipts', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_report', 'seat_revoke_report'], category: 'C', owner: 'SeatEngine home/ledger/engine/v1/nodeId/events', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_directories', 'seat_read'], category: 'E', owner: 'SeatDirectoryService roots/read', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-seat', names: ['seat_edit', 'seat_write'], category: 'A', owner: 'packages/seat/tool-seat/src/directories.ts', evidence: '%s protects profile inputs for a real prefilled seat window' },
  { pkg: 'tool-skill', names: ['skill'], category: 'D', owner: 'SkillRegistry filesystem provider', evidence: 'skill reads the filesystem provider without a model-controlled write destination' },
  { pkg: 'tool-session-query', names: ['session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace'], category: 'C', owner: 'SqliteSessionQueryEngine path; JsonlSessionPersistence root', evidence: '%s retains protected input bytes with the real SQLite and JSONL providers' },
  { pkg: 'tool-subagent', names: ['list_subagent_models'], category: 'D', owner: 'LlmAdapter catalog methods', evidence: 'list_subagent_models uses read-only catalog defaults (exact: %s)' },
  { pkg: 'tool-subagent', names: ['subagent'], category: 'C', owner: 'AgentLoop session persistence root', evidence: '%s creates application sessions without model-controlled storage paths' },
  { pkg: 'tool-subagent-control', names: ['list_agents'], category: 'E', owner: 'SessionQuery read-only observations; in-memory subagent catalog projections', evidence: '%s controls %s children with application-owned storage' },
  { pkg: 'tool-subagent-control', names: ['interrupt_agent', 'send_message'], category: 'C', owner: 'AgentLoop session persistence root', evidence: '%s controls %s children with application-owned storage' },
  { pkg: 'tool-jobs', names: ['job_kill'], category: 'E', owner: 'LocalJobRegistry exact session ownership', evidence: 'job_kill only cancels jobs owned by the calling session' },
  { pkg: 'tool-jobs', names: ['job_list'], category: 'E', owner: 'LocalJobRegistry in-memory view', evidence: 'job_list cannot write a protected input through extra model arguments' },
  { pkg: 'tool-jobs', names: ['job_output'], category: 'E', owner: 'LocalJobRegistry in-memory output', evidence: 'job_output cannot write a protected input through extra model arguments' },
  { pkg: 'experimental-tool-agent-team', names: ['interrupt_agent', 'send_message'], category: 'C', owner: 'AgentLoop session persistence root; team domain events', evidence: '%s controls %s children with application-owned storage' },
  { pkg: 'experimental-tool-agent-team', names: ['list_agents', 'wait_agent'], category: 'E', owner: 'Team projection and in-memory activity waiters', evidence: '%s observes team state without appending events or starting processes' },
  { pkg: 'experimental-tool-agent-team', names: ['spawn_teammate'], category: 'C', owner: 'AgentLoop session persistence root; team membership events', evidence: '%s creates application sessions without model-controlled storage paths' },
  { pkg: 'experimental-tool-agent-team', names: ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'], category: 'C', owner: 'AgentLoop session persistence root; team task events', evidence: '%s keeps team task state under the configured session root' },
  { pkg: 'tool-todo', names: ['todo_write'], category: 'C', owner: 'Session persistence root; todo events', evidence: 'todo_write retains protected input bytes while appending its domain event' },
  { pkg: 'tool-working-directory', names: ['working_directory'], category: 'C', owner: 'Session persistence root; cwd event does not relocate storage', evidence: 'working_directory retains protected input bytes while changing its domain state' },
  { pkg: 'experimental-tool-worktree', names: ['create_worktree'], category: 'B', owner: 'packages/experimental/tool-worktree/src/index.ts', evidence: 'create_worktree confines commands for a live caller' },
  { pkg: 'tool-workflow', names: ['workflow'], category: 'B', owner: 'packages/ptc-runtime/ptc-runtime-node/src/index.ts', evidence: '%s retains protected inputs through the real PTC workflow engine' },
  { pkg: 'tool-workspace-dependencies', names: ['load_workspace_dependencies'], category: 'C', owner: 'Owner-configured source and root; root.previous recovery directory', evidence: 'load_workspace_dependencies ignores model installation paths and sources' },
  { pkg: 'tool-web', names: ['web_fetch', 'web_search'], category: 'D', owner: 'WebRuntime HTTP/search providers', evidence: '%s delegates retrieval without a model-controlled write destination' },
]

function classifiedTools() {
  return classifications.flatMap(row => row.names.map(name => ({ ...row, key: `@panedesk/dsh-${row.pkg}:${name}` })))
}

it('classifies every emitted tool exactly once as A through E with executable evidence', async () => {
  const catalog = await collectToolCatalog()
  const emitted = catalog.flatMap(entry => entry.schemas.map(schema => `${entry.pkg}:${schema.name}`)).sort()
  const rows = classifiedTools()
  expect(rows.map(row => row.key).sort()).toEqual(emitted)
  expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  const proofs = executionProofs(readFileSync(join(repository, 'packages/boot/plugin-manager/tests/tool-admission-coverage.spec.ts'), 'utf8'))
  expect(rows.filter(row => !proofs.has(row.evidence)).map(row => row.key).sort())
    .toEqual(pendingAdmissionEvidence.map(row => row.key).sort())
  expect(pendingAdmissionEvidence.map(row => row.key.split(':')[1]).sort()).toEqual([
    'seat_renew', 'seat_replace', 'stagehand_act', 'stagehand_extract', 'stagehand_navigate',
    'stagehand_observe', 'stagehand_screenshot', 'stagehand_tabs',
  ])
  expect(pendingAdmissionEvidence.every(row => row.reason.length > 0)).toBe(true)
  const pending = new Set<string>(pendingAdmissionEvidence.map(row => row.key))
  const admissionSources = new Set<string>(routes.map(([path]) => path))
  expect(rows.filter(row => !pending.has(row.key) && (row.category === 'A' || row.category === 'B') && !admissionSources.has(row.owner))
    .map(row => `${row.key}: ${row.owner}`)).toEqual([])
})

it('does not infer evidence for unclassified tools or duplicate classifications', () => {
  const rows = classifiedTools()
  expect(rows.some(row => row.key === '@panedesk/dsh-tool-new:unregistered_write')).toBe(false)
  const duplicate = [...rows, rows[0]!]
  expect(new Set(duplicate.map(row => row.key)).size).not.toBe(duplicate.length)
})

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
