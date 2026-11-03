import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs } from '../src/args.ts'

const parse = (argv: string[], manageDesktopProfile = false) => parseDshArgs(argv, '1.2.3', manageDesktopProfile)

/** Capture the process exit code while muting Commander's output. */
function exitCode(argv: string[], manageDesktopProfile = false): number {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    parse(argv, manageDesktopProfile)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return exit.mock.calls.at(-1)?.[0] as number
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseDshArgs', () => {
  it('routes explicit offline owner cleanup without booting a profile', () => {
    expect(parse(['cleanup-owner-labels', '--stopped', 'C:\\private']))
      .toEqual({ mode: 'cleanup-owner-labels', path: 'C:\\private' })
    expect(exitCode(['cleanup-owner-labels', 'C:\\private'])).toBe(1)
  })
  it('passes runtime identity labels separately from application arguments', () => {
    expect(parse(['--seat', 'seat-a', '--window', 'window-a', '--task-id', 'task-a', 'run the tests']))
      .toMatchObject({ mode: 'profile', profile: 'slim', ledgerIdentity: { seat: 'seat-a', window: 'window-a', taskId: 'task-a' }, args: ['run the tests'] })
    expect(parse(['web', '--seat', 'seat-a', '--help'])).toMatchObject({ ledgerIdentity: { seat: 'seat-a' }, args: ['--help'] })
    expect(exitCode(['--seat='])).toBe(1)
    expect(exitCode(['--seat', 'seat-a', '--dump-config'])).toBe(1)
  })

  it('routes profile boots and shorthand, handing the rest to the app', () => {
    expect(parse(['--profile', 'tui'])).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [] })
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--patch', 'b.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml', 'b.yml'], args: [] })
    expect(parse(['--profile', 'rescue', '--from-default-profile', 'web']))
      .toEqual({ mode: 'profile', profile: 'rescue', fromDefaultProfile: 'web', patches: [], args: [] })
    expect(parse(['web'])).toEqual({ mode: 'profile', profile: 'web', patches: [], args: [] })
    expect(parse(['web', '--patch', 'web.yml']))
      .toEqual({ mode: 'profile', profile: 'web', patches: ['web.yml'], args: [] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    // App flags, including its -h, and positionals reach the app verbatim.
    expect(parse(['--profile', 'tui', '--resume', 'abc']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: [], args: ['--resume', 'abc'] })
    expect(parse(['--profile', 'web', '-h']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['-h'] })
    expect(parse(['web', '--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag'] })
    expect(parse(['--profile', 'headless', 'run', 'the', 'tests']))
      .toEqual({ mode: 'profile', profile: 'headless', patches: [], args: ['run', 'the', 'tests'] })
    // Launcher flags placed after that boundary belong to the app too.
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--resume', 'b', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml'], args: ['--resume', 'b', '--patch', 'late.yml'] })
    expect(parse(['--profile', 'rescue', '--resume', 'abc', '--from-default-profile', 'web']))
      .toEqual({
        mode: 'profile',
        profile: 'rescue',
        patches: [],
        args: ['--resume', 'abc', '--from-default-profile', 'web'],
      })
    expect(parse(['web', '--from-default-profile', 'web']))
      .toEqual({ mode: 'profile', profile: 'web', fromDefaultProfile: 'web', patches: [], args: [] })
  })

  it.each(['slim', 'full', 'web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'tui', 'custom', 'run', 'help'])('expands %s without looking up profiles', (profile) => {
    for (const args of [
      [], ['task', 'words'], ['--help'], ['-h'], ['web'],
      ['--patch', 'a.yml', '--patch', 'b.yml'],
      ['--from-default-profile', profile, '--help'],
      ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema'],
      ['--patch', 'a.yml', '--resume', 'id', '--patch', 'late.yml'],
      ['--', '--help'], ['--', '--', 'task'],
      ['plugin'], ['--', 'plugin'],
    ]) {
      expect(parse([profile, ...args])).toEqual(parse(['--profile', profile, ...args]))
    }
  })

  it('reserves leading plugin for management and forwards later command names', () => {
    expect(parse(['--profile', 'plugin'])).toMatchObject({ mode: 'profile', profile: 'plugin' })
    expect(parse(['--profile', 'x', 'plugin', 'add', 'y']))
      .toMatchObject({ mode: 'profile', profile: 'x', args: ['plugin', 'add', 'y'] })
    expect(parse(['headless', 'web'])).toMatchObject({ profile: 'headless', args: ['web'] })
    // Without a profile the launcher boots the default preset, so these hand `tui` to the app.
    expect(parse(['--patch', 'a.yml', 'tui']))
      .toEqual({ mode: 'profile', profile: 'slim', patches: ['a.yml'], args: ['tui'] })
    expect(parse(['--', 'tui'])).toEqual({ mode: 'profile', profile: 'slim', patches: [], args: ['tui'] })
  })

  it.each([
    [''], ['desktop'], ['Desktop'], ['DESKTOP'],
    ['custom', '--patch='], ['custom', '--from-default-profile='],
    ['custom', '--dump-config', '--dump-default-config'],
    ['custom', '--dump-default-config', '--patch', 'a.yml'],
    ['custom', '--dump-config', 'task'],
  ])('rejects invalid shorthand %j', (...argv: string[]) => {
    expect(exitCode(argv)).toBe(1)
  })

  it.each(['-V', '--version'])('prints the launcher version for shorthand %s', (flag) => {
    expect(exitCode(['custom', flag])).toBe(0)
    expect(parse(['custom', 'task', flag])).toMatchObject({ args: ['task', flag] })
  })

  it.each([
    ['web', '--profile', 'tui'],
    ['--profile', 'web', '--profile', 'tui'],
    ['--profile=web', '--profile=web'],
    ['plugin', '--profile', 'web', '--profile', 'tui', 'add', 'x'],
  ])('rejects repeated profile selection %j', (...argv: string[]) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(exitCode(argv)).toBe(1)
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('select a profile only once')
  })

  it('forwards late profile options to the application', () => {
    expect(parse(['web', 'task', '--profile', 'tui']))
      .toMatchObject({ profile: 'web', args: ['task', '--profile', 'tui'] })
  })

  it('routes the plugin pnpm forwarder', () => {
    expect(parse(['plugin', '--profile', 'tui', 'add', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'remove', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['remove', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'why', '@panedesk/cordis']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['why', '@panedesk/cordis'] })
    // Unknown pnpm flags forward verbatim.
    expect(parse(['plugin', '--profile', 'tui', 'add', '--save-dev', 'x']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '--save-dev', 'x'] })
    // Options after the pnpm command belong to pnpm, including the forwarder's own names.
    expect(parse(['plugin', '--profile', 'tui', 'add', '--help']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '--help'] })
    expect(parse(['plugin', '--profile', 'tui', 'add', '-h', '--profile', 'x']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '-h', '--profile', 'x'] })
    // A leading pnpm option starts the forwarded arguments before the pnpm command.
    expect(parse(['plugin', '--profile', 'tui', '--filter', 'x', '--profile', 'y', 'add', 'z']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['--filter', 'x', '--profile', 'y', 'add', 'z'] })
    expect(exitCode(['plugin', 'add', 'x', '--profile', 'tui'])).toBe(1)
    expect(exitCode(['plugin', '--filter', 'x', 'add', '--profile', 'tui'])).toBe(1)
  })

  it.each([
    ['plugin', '--help'], ['plugin', '-h'], ['plugin', '--profile', 'tui', '--help'],
    ['plugin', '--profile', 'tui', '--filter', 'x', 'add', '--help'],
  ])('prints the plugin forwarder help for %j', (...argv: string[]) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(exitCode(argv)).toBe(0)
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Usage: panedesk plugin [options] [args...]')
  })

  it.each(['desktop', 'Desktop', 'DESKTOP'])('permits installed Desktop plugin commands for %s', (profile) => {
    expect(parse(['plugin', '--profile', profile, 'add', 'example-plugin'], true))
      .toEqual({ mode: 'plugin', profile: 'desktop', args: ['add', 'example-plugin'] })
    expect(exitCode(['plugin', '--profile', profile, 'add', 'example-plugin'])).toBe(1)
  })

  it.each([
    ['desktop'], ['--profile', 'Desktop'],
    ['desktop', '--dump-config'], ['DESKTOP', '--dump-default-config'],
    ['desktop', '--dump-config-schema'],
  ])('keeps Desktop boot and inspection reserved in its installed CLI: %j', (...argv: string[]) => {
    expect(exitCode(argv, true)).toBe(1)
  })

  it('routes profile and web config dumps', () => {
    expect(parse(['--profile', 'web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['--profile', 'web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
    expect(parse(['--profile', 'rescue', '--from-default-profile', 'web', '--dump-config']))
      .toEqual({
        mode: 'dump-config',
        profile: 'rescue',
        fromDefaultProfile: 'web',
        defaultOnly: false,
        patches: [],
      })
    expect(parse(['--profile', 'tui', '--dump-config', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: false, patches: ['x.yml'] })
    expect(parse(['web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
  })

  it('routes schema dumps with ordered overlays and explicit initialization', () => {
    expect(parse(['--profile', 'web', '--dump-config-schema']))
      .toEqual({ mode: 'dump-config-schema', profile: 'web', patches: [] })
    expect(parse(['rescue', '--from-default-profile', 'web', '--patch', 'first.yml', '--dump-config-schema', '--patch', 'second.json']))
      .toEqual({
        mode: 'dump-config-schema',
        profile: 'rescue',
        fromDefaultProfile: 'web',
        patches: ['first.yml', 'second.json'],
      })
    expect(parse(['web', '--port', '8080', '--dump-config-schema']))
      .toMatchObject({ mode: 'profile', args: ['--port', '8080', '--dump-config-schema'] })
  })

  it.each([
    ['--dump-config', '--dump-default-config'],
    ['--dump-config', '--dump-config-schema'],
    ['--dump-default-config', '--dump-config-schema'],
    ['--dump-config', '--dump-default-config', '--dump-config-schema'],
  ])('rejects competing dump flags %j', (...flags: string[]) => {
    expect(exitCode(['web', ...flags])).toBe(1)
    expect(exitCode(['--profile', 'web', ...flags.toReversed()])).toBe(1)
  })

  it.each([
    ['desktop', '--dump-config-schema'],
    ['--profile', 'Desktop', '--dump-config-schema'],
    ['web', '--dump-config-schema', 'task'],
    ['web', '--dump-config-schema', '--port', '8080'],
    ['web', '--dump-config-schema', '--help'],
    ['web', '--dump-config-schema', '--', '--patch', 'late.yml'],
    ['web', '--dump-config-schema', '--patch='],
    ['rescue', '--dump-config-schema', '--from-default-profile='],
  ])('rejects invalid schema dump inputs %j', (...argv: string[]) => {
    expect(exitCode(argv)).toBe(1)
  })

  it('rejects empty profiles and contradictory inputs', () => {
    expect(exitCode(['--profile', ''])).toBe(1)
    expect(exitCode([''])).toBe(1)
    expect(exitCode(['--profile', 'x', '--from-default-profile='])).toBe(1)
    expect(exitCode(['--profile', 'x', '--from-default-profile'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--patch='])).toBe(1)
    expect(exitCode(['--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--dump-default-config', '--patch', 'p.yml'])).toBe(1)
    expect(exitCode(['--dump-config', 'task'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-default-config', '--patch', 'p.yml'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', 'task'])).toBe(1)
    expect(exitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['web', '--dump-default-config', '--patch', 'w.yml'])).toBe(1)
    expect(exitCode(['web', '--patch='])).toBe(1)
    // A dump never runs app command-line providers, so it cannot show what
    // those flags would decide; printing a tree that differs from the same
    // invocation's boot would mislead.
    expect(exitCode(['web', '--dump-config', '--port', '8080'])).toBe(1)
    expect(exitCode(['--profile', 'web', '--dump-config', '-h'])).toBe(1)
    expect(exitCode(['plugin', 'add', 'x'])).toBe(1) // --profile required
    expect(exitCode(['plugin', '--profile', 'tui'])).toBe(1) // nothing to forward
    expect(exitCode(['plugin', '--profile', ''])).toBe(1)
    expect(exitCode(['--profile', 'desktop'])).toBe(1)
    expect(exitCode(['--profile', 'Desktop'])).toBe(1)
    expect(exitCode(['--profile', 'DESKTOP'])).toBe(1)
    expect(exitCode(['--profile', 'desktop', '--dump-config'])).toBe(1)
    expect(exitCode(['plugin', '--profile', 'desktop', 'add', 'x'])).toBe(1)
    expect(exitCode(['plugin', '--profile', 'Desktop', 'add', 'x'])).toBe(1)
  })

  it('treats unknown leading flags as app arguments for the default preset', () => {
    // Formerly "no profile" errors: the launcher hands them to the slim app, which owns their diagnostics.
    for (const argv of [['--config', 'c.yml'], ['-p', 'task'], ['--bogus']]) {
      expect(parse(argv)).toEqual({ mode: 'profile', profile: 'slim', patches: [], args: argv })
    }
    // A different template must not replace the default preset, even with later app arguments.
    expect(exitCode(['--from-default-profile', 'web', 'plugin', '--profile', 'x', 'add', 'y'])).toBe(1)
    // `plugin` behind launcher flags remains an app argument when the template matches.
    expect(parse(['--from-default-profile', 'slim', 'plugin', '--profile', 'x', 'add', 'y']))
      .toEqual({
        mode: 'profile',
        profile: 'slim',
        fromDefaultProfile: 'slim',
        patches: [],
        args: ['plugin', '--profile', 'x', 'add', 'y'],
      })
  })

  it('keeps its own help for an invocation with no app to hand it to', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(exitCode(['--help'])).toBe(0)
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain('help [command]')
    expect(exitCode(['-h'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})

describe('parseDshArgs default preset', () => {
  const slim = (args: string[], patches: string[] = []) => ({ mode: 'profile', profile: 'slim', patches, args })

  it('boots slim with a task as the only argument, including a non-ASCII one', () => {
    expect(parse(['只回复 OK'])).toEqual(slim(['只回复 OK']))
    expect(parse(['run the tests'])).toEqual(slim(['run the tests']))
    expect(parse(['run the tests', '--json'])).toEqual(slim(['run the tests', '--json']))
  })

  it('treats a first token containing whitespace as a task, never as a profile name', () => {
    // Even when it starts with a shipped profile name.
    expect(parse(['full run the tests'])).toEqual(slim(['full run the tests']))
    expect(parse(['web app'])).toEqual(slim(['web app']))
  })

  it('boots slim when only app flags precede the task', () => {
    expect(parse(['--json', 'task'])).toEqual(slim(['--json', 'task']))
    expect(parse(['--json'])).toEqual(slim(['--json']))
  })

  it('selects the full preset by name or flag', () => {
    expect(parse(['full', 'task'])).toEqual({ mode: 'profile', profile: 'full', patches: [], args: ['task'] })
    expect(parse(['--profile', 'full', 'task'])).toEqual({ mode: 'profile', profile: 'full', patches: [], args: ['task'] })
    expect(parse(['slim', 'task'])).toEqual(slim(['task']))
  })

  it('boots slim past a double dash or launcher overlays', () => {
    expect(parse(['--', 'tui'])).toEqual(slim(['tui']))
    expect(parse(['--patch', 'a.yml', 'tui'])).toEqual(slim(['tui'], ['a.yml']))
    expect(parse(['--patch', 'a.yml'])).toEqual(slim([], ['a.yml']))
    expect(parse(['--patch', 'a.yml', '--patch', 'b.yml', 'task'])).toEqual(slim(['task'], ['a.yml', 'b.yml']))
  })

  it.each([[], ['--help'], ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema']])(
    'rejects a different template for the default slim target with flags %j', (...flags: string[]) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      expect(exitCode(['--from-default-profile', 'web', ...flags])).toBe(1)
      const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(text).toContain('cannot replace preset "slim" with template "web"')
      expect(text).toContain('panedesk rescue --from-default-profile web')
      expect(text.trim().split('\n')).toHaveLength(1)
    },
  )

  it.each(['slim', 'full'])('rejects a different template for the explicit %s target in boot and dumps', (profile) => {
    for (const target of [[profile], ['--profile', profile]]) {
      for (const flags of [[], ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema']]) {
        expect(exitCode([...target, '--from-default-profile', 'web', ...flags])).toBe(1)
      }
    }
  })

  it.each(['slim', 'full'])('allows resetting the %s preset from its matching template in boot and dumps', (profile) => {
    const targets = [[profile], ['--profile', profile], ...(profile === 'slim' ? [[]] : [])]
    for (const target of targets) {
      for (const flags of [[], ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema']]) {
        expect(parse([...target, '--from-default-profile', profile, ...flags]))
          .toMatchObject({ profile, fromDefaultProfile: profile })
      }
    }
  })

  it('allows a different template for a custom target in boot and all dumps', () => {
    for (const flags of [[], ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema']]) {
      expect(parse(['rescue', '--from-default-profile', 'web', ...flags]))
        .toMatchObject({ profile: 'rescue', fromDefaultProfile: 'web' })
    }
  })

  it('points config dumps at slim when no profile is named', () => {
    expect(parse(['--dump-config'])).toEqual({ mode: 'dump-config', profile: 'slim', defaultOnly: false, patches: [] })
    expect(parse(['--dump-default-config'])).toEqual({ mode: 'dump-config', profile: 'slim', defaultOnly: true, patches: [] })
    expect(parse(['--dump-config-schema'])).toEqual({ mode: 'dump-config-schema', profile: 'slim', patches: [] })
    expect(parse(['--patch', 'x.yml', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'slim', defaultOnly: false, patches: ['x.yml'] })
  })

  it('hands a later --help or -h to the app unchanged when the first leftover token is not help', () => {
    expect(parse(['--json', '--', '--help'])).toEqual(slim(['--json', '--', '--help']))
    expect(parse(['--json', '--help'])).toEqual(slim(['--json', '--help']))
    expect(parse(['--json', '-h'])).toEqual(slim(['--json', '-h']))
    expect(parse(['run the tests', '--help'])).toEqual(slim(['run the tests', '--help']))
  })

  it('prints the launcher help and exits 0 for a bare invocation and for -h / --help', () => {
    for (const argv of [[], ['-h'], ['--help'], ['--', '--help'], ['--patch', 'a.yml', '-h']]) {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      expect(exitCode(argv), JSON.stringify(argv)).toBe(0)
      const text = stdout.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(text).toContain('Usage: panedesk')
      expect(text).toContain('slim (default)')
      expect(text).toContain('pdesk')
      expect(text).not.toContain('dsh ')
      vi.restoreAllMocks()
    }
  })

  it('hands -h after a profile to the booted app instead of printing launcher help', () => {
    expect(parse(['full', '-h'])).toEqual({ mode: 'profile', profile: 'full', patches: [], args: ['-h'] })
    expect(parse(['slim', '--help'])).toEqual(slim(['--help']))
  })
})
