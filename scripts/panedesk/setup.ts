/**
 * One-command repository setup for the Panedesk CLI: frozen install, native
 * addon, host libraries, a CLI runtime-closure check, and the default profile
 * bootstrap — the smallest build that lets `pdesk` run the slim preset, not
 * the full repository build. Every step is idempotent, timed, and reported
 * with a bilingual reason and next step on failure.
 * @module panedesk/setup
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** Repository root this script builds. */
const ROOT = resolve(import.meta.dirname, '../..')

/** Progress and failure surface; injectable for tests. */
export interface SetupIo {
  /** Write one progress line. */
  write(text: string): void
}

/** One executable setup step with its failure guidance. */
export interface SetupStep {
  /** Short step name used in progress lines and failure reports. */
  label: string
  /** Executable to run. */
  command: string
  /** Arguments for {@link SetupStep.command}. */
  args: readonly string[]
  /** What this step builds, shown when it fails (English). */
  purpose: string
  /** 同步失败说明(中文)。 */
  purposeZh: string
  /** Next action to try when it fails (English). */
  next: string
  /** 失败后下一步(中文)。 */
  nextZh: string
}

/** Inputs for {@link plannedSetupSteps}. */
export interface SetupPlanOptions {
  /** Append the `pnpm link --global` step. */
  link: boolean
  /** Node binary for the CLI steps. */
  bin: string
  /** CLI entry script the closure steps run, relative to the repository root. */
  cliEntry: string
}

/**
 * List the setup steps in execution order. The plan is a pure value: running
 * setup twice plans the identical sequence, and each step is itself
 * idempotent, so re-running `pnpm run setup` is safe on an installed tree.
 * @param options - link flag and the CLI entry to exercise.
 * @returns the ordered steps.
 */
export function plannedSetupSteps(options: SetupPlanOptions): SetupStep[] {
  const steps: SetupStep[] = [
    {
      label: 'frozen install',
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      purpose: 'installs every workspace dependency exactly as locked',
      purposeZh: '按锁文件安装全部工作区依赖',
      next: 'check the pnpm error above; a changed pnpm-lock.yaml needs a clean checkout or a fresh lock commit',
      nextZh: '查看上方 pnpm 报错;锁文件不一致时需要干净检出或重新提交锁',
    },
    {
      label: 'native system addon',
      command: 'pnpm',
      args: ['run', 'build:native-system'],
      purpose: 'builds the native/system addon the sandbox and runtime load',
      purposeZh: '构建沙盒与运行时加载的 native/system 插件',
      next: 'install the C++ toolchain (a recent clang or gcc) and re-run pnpm run setup',
      nextZh: '安装 C++ 工具链(较新的 clang 或 gcc)后重跑 pnpm run setup',
    },
    {
      // This is the two-command preparation the README used to ask for by
      // hand: it compiles the host-referenced workspace libraries (TypeScript
      // emits plus the host bundle) that the CLI needs at runtime — without
      // them apps/cli/lib/bin.js and every @panedesk package it loads have no
      // built output to run.
      label: 'host libraries',
      command: 'pnpm',
      args: ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'host-libraries'],
      purpose: 'compiles the host-referenced libraries the CLI runs against (apps/cli/lib included)',
      purposeZh: '编译 CLI 运行所需的宿主引用库(含 apps/cli/lib)',
      next: 'check the TypeScript errors above; a clean tree should always compile',
      nextZh: '查看上方 TypeScript 报错;干净树应当总能编译',
    },
    {
      label: 'CLI closure check',
      command: options.bin,
      args: [options.cliEntry, '--version'],
      purpose: 'proves the CLI runtime closure is complete: the built entry starts and answers --version without the full repository build',
      purposeZh: '验证 CLI 运行闭包完整:构建出的入口能启动并应答 --version,而无需全量构建',
      next: 're-run pnpm run setup; if it persists, report the error above with your Node version',
      nextZh: '重跑 pnpm run setup;若仍失败,带上 Node 版本反馈上方错误',
    },
    {
      label: 'default profile bootstrap',
      command: options.bin,
      args: [options.cliEntry, '--profile', 'slim', '--dump-default-config'],
      purpose: 'bootstraps the default slim profile through the CLI first-start path (initProfile never touches an initialized profile)',
      purposeZh: '走 CLI 现有首启路径生成默认 slim profile(已初始化的不会被改动)',
      next: 'check the error above; a missing $PANEDESK_HOME or a locked profiles directory is the usual cause',
      nextZh: '查看上方错误;常见原因是 $PANEDESK_HOME 不可用或 profiles 目录被占用',
    },
  ]
  if (options.link) {
    steps.push({
      label: 'global link',
      command: 'pnpm',
      args: ['link', '--global'],
      purpose: 'links this checkout as the global pdesk/panedesk command',
      purposeZh: '把本检出链接为全局 pdesk/panedesk 命令',
      next: 'set PNPM_HOME so pnpm link --global can register the bin, then re-run with --link',
      nextZh: '先设置 PNPM_HOME 使 pnpm link --global 能注册命令,再带 --link 重跑',
    })
  }
  return steps
}

/** Options for {@link runSetup}; every input is injectable for tests. */
export interface RunSetupOptions {
  /** Prepared steps to execute; defaults to {@link plannedSetupSteps} on this checkout. */
  steps?: SetupStep[]
  /** Progress surface; defaults to stdout. */
  io?: SetupIo
  /** Step executor; defaults to running the step with inherited output. */
  runner?: SetupRunner
  /** Passed through to the default plan when {@link RunSetupOptions.steps} is omitted. */
  link?: boolean
}

/** Executes one step; the default runs the step command in the repository root. */
export interface SetupRunner {
  /** Run one step to completion.
   * @param step - the step to execute.
   * @throws when the step exits nonzero.
   */
  run(step: SetupStep): void | Promise<void>
}

/** Run the prepared steps serially, timing each and stopping at the first failure. */
export async function runSetup(options: RunSetupOptions = {}): Promise<number> {
  const io = options.io ?? { write: (text: string): void => { process.stdout.write(text) } }
  const steps = options.steps ?? plannedSetupSteps({ link: options.link ?? false, bin: process.execPath, cliEntry: 'apps/cli/lib/bin.js' })
  const runner = options.runner ?? {
    run: (step: SetupStep): void => {
      const result = spawnSync(step.command, [...step.args], { cwd: ROOT, stdio: 'inherit' })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0) throw new Error(`${step.label} exited with ${String(result.status ?? result.signal)}`)
    },
  }
  const started = Date.now()
  for (const step of steps) {
    const stepStart = Date.now()
    io.write(`[setup] ${step.label}: ${step.command} ${step.args.join(' ')}\n`)
    try {
      await runner.run(step)
    } catch (error) {
      io.write(`[setup] ${step.label} failed: ${step.purpose}; ${step.next}\n[setup] ${step.purposeZh};${step.nextZh}\n[setup] error: ${String(error instanceof Error ? error.message : error)}\n`)
      return 1
    }
    io.write(`[setup] ${step.label} done in ${Date.now() - stepStart}ms\n`)
  }
  io.write(`[setup] complete in ${Date.now() - started}ms; run "node apps/cli/lib/bin.js --help" to see the CLI\n[setup] 全部完成;运行 node apps/cli/lib/bin.js --help 查看 CLI\n`)
  return 0
}

/** Options for {@link bootstrapDefaultProfile}. */
export interface BootstrapOptions {
  /** Node binary to run the CLI entry with. */
  bin: string
  /** CLI entry script, relative to the repository root. */
  cliEntry: string
  /** Progress surface. */
  io: SetupIo
}

/**
 * Bootstrap the default profile by running the CLI's existing first-start
 * path (`--profile slim --dump-default-config` composes the profile, which
 * initializes `profiles/slim` on first use and rewrites nothing once it
 * exists). Re-running is a no-op on an initialized profile.
 * @param options - binaries and progress surface.
 * @throws when the CLI entry exits nonzero.
 */
export function bootstrapDefaultProfile(options: BootstrapOptions): void {
  const result = spawnSync(options.bin, [resolve(ROOT, options.cliEntry), '--profile', 'slim', '--dump-default-config'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`profile bootstrap exited with ${String(result.status ?? result.signal)}; run the same command directly to see the output / 退出码非零,请直接运行同一命令查看输出`)
  }
  options.io.write('[setup] default profile ready under $PANEDESK_HOME/profiles/slim / 默认 profile 已就绪\n')
}

if (import.meta.main) {
  const link = process.argv.includes('--link')
  process.exit(await runSetup({ link }))
}
