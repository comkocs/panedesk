/**
 * Dangerous-removal check shared by the bash and PowerShell tools: before a
 * command runs, find `rm`-style removals whose target is a filesystem root, a
 * system, home or workspace directory (or contains one), comes from a command
 * substitution, or uses a variable that can expand to nothing.
 */
import { homedir, tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Why one removal was stopped, for the model and for the approval prompt. */
export interface RemovalHazard {
  /** English reason, sent to the model. */
  readonly en: string
  /** Chinese reason, shown in the approval prompt. */
  readonly zh: string
}

const REMOVERS = {
  bash: new Set(['rm', 'rmdir']),
  pwsh: new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'remove-item']),
}
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time'])
/** Variables that are never empty here, with the value the shell sees. */
function knownValue(name: string, cwd: string): string | undefined {
  const upper = name.toUpperCase()
  if (upper === 'HOME' || upper === 'USERPROFILE') return homedir()
  if (upper === 'PWD') return cwd
  if (upper === 'TMPDIR' || upper === 'TEMP' || upper === 'TMP') return process.env[upper] ?? tmpdir()
  return undefined
}
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/opt', '/proc', '/sbin', '/srv', '/sys', '/usr', '/var',
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata', 'c:/users']

/** Split on unquoted `;`, `&&`, `||`, `|`, `&` and newlines, outside `$(...)`. */
function segments(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      current += ch
      continue
    }
    if (ch === '\'' || ch === '"') quote = ch
    else if (ch === '$' && command[i + 1] === '(') depth++
    else if (ch === ')' && depth > 0) depth--
    else if (depth === 0 && (ch === ';' || ch === '|' || ch === '&' || ch === '\n')) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** Whitespace-split words, keeping their quotes so expansion rules stay visible. */
function words(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  let depth = 0
  for (const ch of segment) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
    } else if (ch === '\'' || ch === '"') quote = ch
    else if (ch === '(' && current.endsWith('$')) depth++
    else if (ch === ')' && depth > 0) depth--
    else if (depth === 0 && /\s/.test(ch)) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/** Removal targets of one segment, or none when it is not a removal. */
function targets(segment: string, shell: 'bash' | 'pwsh'): string[] {
  const list = words(segment.trim())
  while (list.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]!) || PREFIXES.has(list[0]!))) list.shift()
  const head = list.shift()?.replace(/^[({]+/, '')
  if (head === undefined) return []
  const name = head.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
  if (!REMOVERS[shell].has(name)) return []
  const out: string[] = []
  let literal = false
  for (let i = 0; i < list.length; i++) {
    const word = list[i]!.replace(/^([^(]*)[)}]+$/, '$1')
    // Redirections name output files, not removal targets.
    if (/^\d*[<>]/.test(word)) { if (/^\d*[<>]+&?$/.test(word)) i++; continue }
    if (literal || !word.startsWith('-')) { out.push(word); continue }
    if (shell === 'bash' && word === '--') { literal = true; continue }
    if (shell === 'pwsh') {
      const param = word.slice(1).toLowerCase()
      if (param === 'path' || param === 'literalpath') { if (list[i + 1] !== undefined) out.push(list[++i]!); continue }
      if (['include', 'exclude', 'filter', 'credential', 'stream'].includes(param)) i++
    }
  }
  return out.flatMap(word => shell === 'pwsh' ? word.split(',') : [word]).filter(word => word !== '')
}

/** Native comparable form: forward slashes, `/c/x` as `c:/x`, lowercase on Windows. */
function comparable(path: string): string {
  let p = path.replace(/\\/g, '/')
  if (process.platform === 'win32') {
    const drive = /^\/(?:mnt\/)?([a-zA-Z])(\/|$)/.exec(p)
    if (drive !== null) p = `${drive[1]!}:/${p.slice(drive[0].length)}`
    p = p.toLowerCase()
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Absolute comparable path for a target written relative to `cwd`. */
function resolveTarget(target: string, cwd: string): string {
  const home = homedir()
  let p = target === '~' ? home : target.startsWith('~/') || target.startsWith('~\\') ? home + target.slice(1) : target
  p = comparable(p)
  const base = comparable(cwd)
  if (process.platform === 'win32') {
    const joined = /^[a-z]:\//.test(p) || /^[a-z]:$/.test(p) ? p : p.startsWith('/') ? `${base.slice(0, 2)}${p}` : `${base}/${p}`
    return comparable(win32.resolve(joined)).replace(/^([a-z]:)$/, '$1/')
  }
  return comparable(posix.resolve(base, p))
}

/** Whether `ancestor` is `path` or one of its parents. */
function contains(ancestor: string, path: string): boolean {
  if (ancestor === path) return true
  const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`
  return path.startsWith(prefix)
}

/** The hazard of one raw target word, if any. */
function hazard(word: string, shell: 'bash' | 'pwsh', cwd: string): RemovalHazard | undefined {
  if (word.includes('$(') || (shell === 'bash' && word.includes('`'))) {
    return {
      en: `the target \`${word}\` comes from a command substitution, so it cannot be checked before the command runs`,
      zh: `删除目标 \`${word}\` 来自命令替换,运行前无法核对`,
    }
  }
  let text = word
  if (shell === 'bash') {
    // Single-quoted text never expands; double-quoted and bare text do.
    const expanding = word.replace(/'[^']*'/g, '')
    for (const match of expanding.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1] ?? match[3]!
      const guarded = match[2] !== undefined && /^:?(?:\?|-.)/.test(match[2])
      const known = knownValue(name, cwd)
      if (!guarded && known === undefined) {
        return {
          en: `the target \`${word}\` uses \`$${name}\` without a \`:?\` guard; if it is empty or unset the command removes a parent directory`,
          zh: `删除目标 \`${word}\` 用了未加 \`:?\` 的变量 \`$${name}\`,变量为空时会删到上级目录`,
        }
      }
      if (known !== undefined) text = text.replace(match[0], known)
    }
  } else {
    // Single-quoted PowerShell text never expands.
    const variable = /\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(word.replace(/'[^']*'/g, ''))
    if (variable !== null) {
      const value = knownValue(variable[1]!, cwd)
      if (value === undefined) {
        return {
          en: `the target \`${word}\` uses the variable \`${variable[0]}\`; if it is empty the command removes a parent directory`,
          zh: `删除目标 \`${word}\` 用了变量 \`${variable[0]}\`,变量为空时会删到上级目录`,
        }
      }
      text = text.replace(variable[0], value)
    }
  }
  const literal = text.replace(/['"]/g, '')
  const base = literal.replace(/([\\/]|^)[^\\/]*[*?[][^\\/]*$/, '$1') || '.'
  const resolved = resolveTarget(base, cwd)
  const home = comparable(homedir())
  const workspace = comparable(cwd)
  const root = /^([a-z]:)?\/$/.test(resolved)
  if (root || contains(resolved, home) || contains(resolved, workspace) || SYSTEM_DIRS.includes(resolved)) {
    return {
      en: `the target \`${word}\` resolves to \`${resolved}\`, a drive root, system, home or workspace directory (or one that contains them)`,
      zh: `删除目标 \`${word}\` 解析为 \`${resolved}\`,是盘根、系统目录、用户目录或工作区(或包含它们)`,
    }
  }
  return undefined
}

/**
 * Find the first dangerous removal in one shell command.
 * @param command - the command text as the model wrote it.
 * @param shell - which shell's quoting and removal commands apply.
 * @param cwd - the absolute directory the command runs in.
 * @returns the reason the removal needs a person, or `undefined` when none is found.
 */
export function dangerousRemoval(command: string, shell: 'bash' | 'pwsh', cwd: string): RemovalHazard | undefined {
  for (const segment of segments(command)) {
    for (const target of targets(segment, shell)) {
      const found = hazard(target, shell, cwd)
      if (found !== undefined) return found
    }
  }
  return undefined
}
