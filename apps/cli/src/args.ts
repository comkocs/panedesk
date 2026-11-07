/**
 * Commander adapter for the `panedesk` (short: `pdesk`) command line.
 *
 * The launcher parses only what it owns — which profile to boot, which extra
 * patch overlays to apply, and the config dumps — and hands **everything after
 * its own flags** to the booted tree verbatim, where injected app plugins parse
 * their own flag families and print their own `--help` (see
 * `@panedesk/dsh-cmdline`). Launcher flags therefore come first: the first
 * token this parser does not recognize starts the inner arguments, so
 * `panedesk --profile tui --resume abc` boots the tui profile with `--resume abc`,
 * and `panedesk --profile web -h` prints the web app's help, not this one's.
 *
 * `panedesk <name>` abbreviates `panedesk --profile <name>`; `plugin` manages a
 * profile's plugin dependencies by forwarding to pnpm. Without a profile the
 * launcher boots {@link DEFAULT_PROFILE}, so `panedesk "fix the tests"` runs one
 * task on the slim preset: a first token containing whitespace is a task, never
 * a profile name, which keeps the shorthand decision free of filesystem lookups.
 * @module panedesk/args
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'

/** Command name printed in help and diagnostics; `pdesk` is the same binary. */
export const CLI_NAME = 'panedesk'

/** Profile booted when the invocation names none: Panedesk's slim one-shot preset. */
export const DEFAULT_PROFILE = 'slim'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  /** Runtime-only attribution supplied before profile plugins mount. */
  ledgerIdentity?: { seat?: string; window?: string; taskId?: string }
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
  patches: string[]
}

/** Print declared plugin schemas without mounting the profile. */
interface DumpConfigSchemaInvocation {
  mode: 'dump-config-schema'
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  patches: string[]
}

/** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** Raw pnpm arguments, verbatim. */
  args: string[]
}

/** Configure a model provider route into the home patch layer. */
interface InitInvocation {
  mode: 'init'
  /** Raw init arguments, parsed by the init command itself. */
  args: string[]
}

/** The resolved `dsh` invocation. Help, version, and errors exit inside {@link parseDshArgs}. */
export type DshInvocation = ProfileInvocation | DumpConfigInvocation | DumpConfigSchemaInvocation | PluginInvocation | InitInvocation

/** Launcher flags for profile boot and configuration dumps. */
interface BootOptions {
  seat?: string
  window?: string
  taskId?: string
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
  dumpConfigSchema?: boolean
  fromDefaultProfile?: string
}

/**
 * Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
 * variadic — a variadic `--patch` would swallow the inner arguments.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

function selectProfile(value: string, previous?: string): string {
  if (previous !== undefined) throw new InvalidArgumentError('select a profile only once')
  return value
}

function rejectElectronProfile(program: Command, profile: string): void {
  if (profile.toLowerCase() === 'desktop') {
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
  }
}

/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Presets:
  slim (default)   minimal one-shot preset installed with the launcher
  full             full headless composition (needs @panedesk/full installed)

Examples:
  panedesk web                                   boot the web profile (same as: panedesk --profile web)
  panedesk rescue --from-default-profile web
                                            recreate rescue from the shipped web template, then boot it
  panedesk headless "run the tests"              answer one task, print the result, and exit
  panedesk tui --patch ./extra.yml               boot a custom profile with one extra overlay
  panedesk tui --resume <session>                arguments after the launcher flags reach the app
  panedesk web --help                            the web app's own flags and help
  panedesk plugin --profile tui add <package>    install a plugin into the tui profile
  panedesk "run the tests"                       answer one task on the slim preset, print the result, and exit
  panedesk --json "run the tests"                the same, printing newline-delimited JSON events
  panedesk full "run the tests"                  the same task on the full preset (same as: panedesk --profile full ...)
  panedesk --patch ./provider.yml "task"         add one overlay (e.g. a model provider) to the default preset
  panedesk full --help                           the booted app's own flags and help
  pdesk ...                                      short name for panedesk
`

/**
 * Resolve a boot or dump invocation from the launcher flags and the leftover
 * inner arguments.
 * @param program - the command whose options were parsed.
 * @param profile - the profile these flags boot.
 * @param options - the launcher flags commander collected.
 * @param args - the leftover arguments, in argv order.
 * @returns the resolved invocation.
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): DshInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.fromDefaultProfile === '') program.error('error: --from-default-profile needs a name')
  if ((profile === 'slim' || profile === 'full') && options.fromDefaultProfile !== undefined
    && options.fromDefaultProfile !== profile) {
    program.error(`error: cannot replace preset "${profile}" with template "${options.fromDefaultProfile}"; choose a different target name, e.g. panedesk rescue --from-default-profile ${options.fromDefaultProfile}`)
  }
  const dumps = [options.dumpConfig, options.dumpDefaultConfig, options.dumpConfigSchema].filter(Boolean)
  const ledgerIdentity = {
    ...options.seat === undefined ? {} : { seat: options.seat },
    ...options.window === undefined ? {} : { window: options.window },
    ...options.taskId === undefined ? {} : { taskId: options.taskId },
  }
  if (Object.values(ledgerIdentity).some(value => value.trim().length === 0)) program.error('error: identity labels must not be empty')
  const hasIdentity = Object.keys(ledgerIdentity).length > 0
  if (dumps.length === 0) {
    return { mode: 'profile', profile, fromDefaultProfile: options.fromDefaultProfile, patches, args,
      ...hasIdentity ? { ledgerIdentity } : {} }
  }
  if (hasIdentity) program.error('error: config dumps take no runtime identity labels')
  if (dumps.length > 1) {
    program.error('error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  if (options.dumpConfigSchema === true) {
    return { mode: 'dump-config-schema', profile, fromDefaultProfile: options.fromDefaultProfile, patches }
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, fromDefaultProfile: options.fromDefaultProfile, defaultOnly, patches }
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @param manageDesktopProfile - permit Desktop's installed carrier to manage its reserved profile's plugins.
 * @returns the resolved invocation.
 */
export function parseDshArgs(argv: readonly string[], version: string, manageDesktopProfile = false): DshInvocation {
  const first = argv[0]
  let resolved: DshInvocation | undefined
  // Annotated, not inferred: the actions below call back into `program`, and an
  // inferred type would be circular through its own chain.
  const program: Command = new Command()
  program
    .name(CLI_NAME)
    .version(version, '-V, --version', 'output the version number')
    .usage(`[[--profile] <name>] [options] [app-args...]\n       ${CLI_NAME} plugin --profile <name> <pnpm-args...>`)
    .description(`${CLI_NAME}: boot a Panedesk profile — an ordered stack of plugin-bundle patch layers under your own overrides. Without a profile it boots "${DEFAULT_PROFILE}".`)
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // The launcher's flags come first and end at the first token it does not
    // know; everything from there on belongs to the booted app, including
    // its -h. `panedesk -h` with no profile still prints this help, below.
    .helpOption(false)
    .helpCommand(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', `arguments for the booted profile's app (see: ${CLI_NAME} --profile <name> --help)`)
    .option('--profile <name>', `the profile under $PANEDESK_HOME/profiles to boot (default: ${DEFAULT_PROFILE})`, selectProfile)
    .option('--from-default-profile <name>', 'replace a custom profile with a fresh copy of a shipped profile template')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--seat <label>', 'runtime ledger seat label (overrides environment and settings)')
    .option('--window <label>', 'runtime ledger window label (overrides environment and settings)')
    .option('--task-id <label>', 'runtime ledger work item label (overrides environment and settings)')
    .option('--dump-config', 'print the composed profile tree and exit')
    .option('--dump-config-schema', 'print JSON Schema for profile entries and patches without mounting')
    .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // With the app owning -h, the launcher's own help is what a bare
      // `panedesk -h` (no profile named, help as the first leftover token) must
      // print, as does a bare `panedesk`. Anything else without a profile boots
      // the default preset with every token intact, so a later `--help` (after
      // app flags or `--`) reaches the app or the task text unchanged.
      if (options.profile === undefined) {
        const bare = args.length === 0 && options.patch === undefined && options.fromDefaultProfile === undefined
          && options.seat === undefined && options.window === undefined && options.taskId === undefined
          && options.dumpConfig !== true && options.dumpDefaultConfig !== true && options.dumpConfigSchema !== true
        if (bare || (options.fromDefaultProfile === undefined && (args[0] === '-h' || args[0] === '--help'))) program.help()
      }
      const profile = options.profile ?? DEFAULT_PROFILE
      if (profile === '') program.error('error: --profile needs a name')
      rejectElectronProfile(program, profile)
      resolved = resolveBoot(program, profile, options, args)
    })

  if (first === 'plugin') {
    const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
    plugin
      // Commander copies the launcher's disabled help option into subcommands. The
      // forwarder restores its own help and stops reading options at forwarded pnpm input.
      .helpOption('-h, --help', 'show this help')
      .passThroughOptions()
      .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)', selectProfile)
      .allowUnknownOption()
      .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
      .action((args: string[], options: { profile: string }) => {
        if (options.profile === '') program.error('error: --profile needs a name')
        if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)
        if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
        resolved = { mode: 'plugin', profile: options.profile.toLowerCase() === 'desktop' ? 'desktop' : options.profile, args }
      })
  }

  if (first === 'init') {
    const init = program.command('init').description('configure a model provider route: pick the API, endpoint, and model, then reference or store the key')
    init
      .helpOption('-h, --help', 'show this help')
      .passThroughOptions()
      .allowUnknownOption()
      .argument('[args...]', 'init flags, parsed by the init command (--api, --base-url, --model, --provider, --api-key-env, --store-key)')
      .action((args: string[]) => {
        resolved = { mode: 'init', args }
      })
  }

  try {
    // A leading token containing whitespace is a task for the default profile, not a profile name.
    const expanded = first !== undefined && !first.startsWith('-') && first !== 'plugin' && first !== 'init'
      && !/\s/.test(first)
      ? ['--profile', ...argv]
      : argv
    program.parse(expanded, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error(`${CLI_NAME}: no invocation resolved`)
  return resolved
}
