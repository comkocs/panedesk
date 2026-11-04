/** Host session discovery does not connect to the discovered sockets. */
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import { canonicalPath } from '@panedesk/dsh-sandbox'

/**
 * Directories whose host session sockets must not enter a mount sandbox.
 * @returns Canonical directories, including explicit host environment overrides.
 */
export function sessionSocketDirectories(): string[] {
  const uid = userInfo().uid
  return [...new Set([
    '/run/screen', `/run/user/${uid}`, `/tmp/tmux-${uid}`, '/tmp/.X11-unix',
    ...[process.env.TMUX_TMPDIR, process.env.XDG_RUNTIME_DIR]
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
  ].map(canonicalPath))].sort((a, b) => a.length - b.length)
}

/**
 * Detect the documented Landlock-only session risk without opening a socket.
 * @returns Whether a conventional user session location exists.
 */
export function hasHostSessionSockets(): boolean {
  const { uid, username } = userInfo()
  return [
    `/tmp/tmux-${uid}`, `/run/screen/S-${username}`, `/run/user/${uid}/bus`,
    ...[process.env.TMUX_TMPDIR].filter((path): path is string => path !== undefined && isAbsolute(path)),
  ].some(path => existsSync(path))
}

/**
 * Environment edits applied inside bubblewrap, after all caller environment merging.
 * @returns Bubblewrap unset and set arguments; runtime and temp paths are private mounts.
 */
export function sessionEnvironmentArgs(): string[] {
  return [
    ...['TMUX', 'TMUX_TMPDIR', 'STY', 'DBUS_SESSION_BUS_ADDRESS', 'DBUS_SESSION_BUS_PID',
      'DBUS_SESSION_BUS_WINDOWID', 'DISPLAY', 'WAYLAND_DISPLAY', 'PULSE_SERVER', 'PULSE_COOKIE',
      'PIPEWIRE_REMOTE', 'SESSION_MANAGER'].flatMap(key => ['--unsetenv', key]),
    '--setenv', 'XDG_RUNTIME_DIR', `/run/user/${userInfo().uid}`,
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp',
  ]
}
