/**
 * `pdesk init`: compose one model provider route and write it to the home
 * patch layer (`$PANEDESK_HOME/cordis.patch.yml`), keeping the key itself out
 * of every written byte — the patch references the key by environment-variable
 * name only, and a key typed at the terminal lands in the owner-only
 * credentials document (`$PANEDESK_HOME/.credentials.yaml`) with the same
 * name. Terminal input of the key is never echoed, no log or output line
 * carries the value, and an existing home patch moves to a timestamped backup
 * before the rewrite.
 * @module panedesk/init
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import {
  CREDENTIALS_DOC_FILENAME,
  renderCredentialsRefUpdate,
  updateHomeProviderPatch,
  type ProviderRoute,
} from '@panedesk/dsh-app-boot'

/** Terminal surface for prompts; injectable for tests and scripts. */
export interface InitIo {
  /** Write one line of progress or prompt text. */
  write(text: string): void
  /** Ask one echoed question and return the trimmed answer. */
  question(prompt: string): Promise<string>
  /** Ask one question whose answer must not echo; returns the untrimmed secret. */
  secret(prompt: string): Promise<string>
}

/** Windows owner-only file operations, injected so tests can stand in for the native binding. */
export interface InitWindowsSecurity {
  /** Replace the DACL of a newly and exclusively created empty object with the current user only. */
  secureOwnerOnly(path: string): void
  /** Write-through move within one volume; returns the Win32 error number, zero on success. */
  replaceOwnerOnly(source: string, target: string): number
}

/** Injection points for `runInit`; production defaults read the real terminal and platform. */
export interface InitOptions {
  /** Terminal surface; defaults to the process terminal. */
  io?: InitIo
  /** Windows owner-only seam; defaults to the native binding on win32. */
  windowsSecurity?: InitWindowsSecurity
  /** Platform gate for the owner-only write path; defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

/** The protocol menu `pdesk init` offers, in display order. */
const API_CHOICES: readonly { key: string; label: string }[] = [
  { key: 'anthropic-messages', label: 'Anthropic Messages' },
  { key: 'openai-completions', label: 'OpenAI Chat Completions' },
  { key: 'openai-responses', label: 'OpenAI Responses' },
]

/** Answer attempts per menu before giving up. */
const MAX_ATTEMPTS = 5

/** Collected flag values; missing ones are asked for interactively. */
interface InitFlags {
  api?: string
  baseURL?: string
  model?: string
  provider?: string
  apiKeyEnv?: string
  storeKey?: string
}

/**
 * Parse the init flag family: every option takes one value except none here
 * being boolean. Unknown or valueless flags reject with usage text.
 * @param argv - arguments after `init`.
 * @returns the collected flags.
 */
function parseInitFlags(argv: readonly string[]): InitFlags {
  const flags: InitFlags = {}
  const values: (keyof InitFlags)[] = ['api', 'baseURL', 'model', 'provider', 'apiKeyEnv', 'storeKey']
  const spellings: Record<string, keyof InitFlags> = {
    '--api': 'api', '--base-url': 'baseURL', '--model': 'model',
    '--provider': 'provider', '--api-key-env': 'apiKeyEnv', '--store-key': 'storeKey',
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = flag === undefined ? undefined : spellings[flag]
    if (field === undefined) throw new Error(`panedesk: init: unknown or misplaced argument ${JSON.stringify(flag ?? '')}; expected pairs of ${values.map(name => `--${name} <value>`).join(', ')}`)
    const value = argv[index + 1]
    if (value === undefined || value === '') throw new Error(`panedesk: init: ${flag} needs a value`)
    flags[field] = value
  }
  return flags
}

/** Ask once; an empty answer takes `fallback`, anything else must pass `accept`. */
async function askOnce(io: InitIo, prompt: string, accept: (answer: string) => string | undefined, fallback?: string): Promise<string> {
  const answer = await io.question(prompt)
  if (answer.trim().length === 0 && fallback !== undefined) return fallback
  const complaint = accept(answer)
  if (complaint !== undefined) throw new Error(`panedesk: init: ${complaint}`)
  return answer.trim()
}

/** Non-empty without surrounding whitespace. */
function required(value: string, field: string): string | undefined {
  return value.trim().length === 0 ? `${field} must not be empty` : undefined
}

/** http(s) URL as the provider adapters require. */
function httpUrl(value: string, field: string): string | undefined {
  if (required(value, field) !== undefined) return `${field} must not be empty`
  return /^https?:\/\/\S+$/.test(value.trim()) ? undefined : `${field} must be an http(s) URL (got ${JSON.stringify(value.trim())})`
}

/** Protocol key from the menu. */
function apiChoice(value: string): string | undefined {
  return API_CHOICES.some(choice => choice.key === value.trim())
    ? undefined
    : `unknown api ${JSON.stringify(value.trim())}; choose ${API_CHOICES.map(choice => choice.key).join(', ')}`
}

/** Route key usable as a providers dict key and inside identifiers. */
function routeKey(value: string, field: string): string | undefined {
  if (required(value, field) !== undefined) return `${field} must not be empty`
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value.trim()) ? undefined : `${field} must start with a letter and use letters, digits, - and _ only`
}

/** POSIX identifier for an environment-variable reference. */
function envName(value: string, field: string): string | undefined {
  if (required(value, field) !== undefined) return `${field} must not be empty`
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ? undefined : `${field} must be a POSIX identifier (letters, digits, underscore; not starting with a digit)`
}

/** Uppercase, underscore-safe default reference name derived from the route key. */
function defaultKeyName(provider: string): string {
  const stem = provider.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return `${stem.length > 0 ? stem : 'PROVIDER'}_API_KEY`
}

/** Provider route key suggested from the endpoint host, or the api label when parsing fails. */
function suggestProvider(baseURL: string, api: string): string {
  try {
    const host = new URL(baseURL).hostname
    const stem = host.replace(/^www\./, '').split('.')[0] ?? ''
    if (stem.length > 0 && /^[A-Za-z]/.test(stem)) return stem.toLowerCase()
  } catch {
    // The base URL was validated before this runs; keep the api label.
  }
  return api
}

/**
 * Run the init command: collect the route (flags first, then interactive
 * prompts for what is missing), optionally store the typed key in the
 * owner-only credentials document, and rewrite the home patch.
 * @param argv - arguments after `init`.
 * @param options - injection points; defaults read the real terminal.
 * @returns the process exit code: zero on success, one on invalid input or write failure.
 */
export async function runInit(argv: readonly string[], options: InitOptions = {}): Promise<number> {
  const io = options.io ?? createConsoleIo()
  const platform = options.platform ?? process.platform
  try {
    const flags = parseInitFlags(argv)
    if (flags.apiKeyEnv !== undefined && flags.storeKey !== undefined) {
      throw new Error('panedesk: init: --api-key-env and --store-key are mutually exclusive / 两者只能选一个')
    }
    const api = flags.api ?? await chooseApi(io)
    const complaint = apiChoice(api)
    if (complaint !== undefined) throw new Error(`panedesk: init: ${complaint}`)
    const baseURL = flags.baseURL ?? await askOnce(io, 'Base URL (e.g. https://api.example.com/v1) / 接口地址: ', value => httpUrl(value, 'base URL'))
    const model = flags.model ?? await askOnce(io, 'Model ID / 模型 ID: ', value => required(value, 'model ID'))
    const suggested = suggestProvider(baseURL, api)
    const provider = flags.provider ?? await askOnce(io, `Provider route key [${suggested}] / 路由键: `, value => routeKey(value, 'provider'), suggested)
    const apiKeyEnv = await collectKeyReference(io, flags, provider)
    if (apiKeyEnv.storedValue !== undefined) {
      await storeCredentialReference(resolveDshHome(), apiKeyEnv.name, apiKeyEnv.storedValue, platform, options.windowsSecurity)
      io.write('panedesk: init: stored the key in the owner-only credentials document (0600) / 密钥已存入仅当前用户可读的凭据件 (0600)')
    }
    const route: ProviderRoute = { api, baseURL: baseURL.trim(), apiKeyEnv: apiKeyEnv.name, provider: provider.trim(), model: model.trim() }
    const update = await updateHomeProviderPatch('panedesk', resolveDshHome(), route)
    if (update.backupPath !== undefined) io.write(`panedesk: init: backed up the previous home patch to ${update.backupPath} / 已备份原配置`)
    io.write(`panedesk: init: wrote ${update.patchPath} referencing ${apiKeyEnv.name}; run "panedesk --dump-config" to review it / 已写入,引用环境变量名`)
    return 0
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return 1
  }
}

/** The chosen key reference: a name only, plus the typed value when it must be stored. */
interface KeyReference {
  name: string
  storedValue: string | undefined
}

/** Ask for the key handling: an environment-variable name, or a typed value to store under a name. */
async function collectKeyReference(io: InitIo, flags: InitFlags, provider: string): Promise<KeyReference> {
  const fallback = defaultKeyName(provider)
  if (flags.apiKeyEnv !== undefined) {
    const complaint = envName(flags.apiKeyEnv, '--api-key-env')
    if (complaint !== undefined) throw new Error(`panedesk: init: ${complaint}`)
    return { name: flags.apiKeyEnv, storedValue: undefined }
  }
  if (flags.storeKey !== undefined) {
    const complaint = envName(flags.storeKey, '--store-key')
    if (complaint !== undefined) throw new Error(`panedesk: init: ${complaint}`)
    return { name: flags.storeKey, storedValue: await readSecret(io, fallback) }
  }
  const menu = 'API key: 1) reference an environment variable (recommended)  2) type it now and store it in the owner-only credentials document\n'
    + '密钥: 1) 只写环境变量名(推荐)  2) 现在输入并存入仅当前用户可读的凭据件 [1-2]: '
  const choice = (await io.question(menu)).trim()
  if (choice === '2') {
    return {
      name: await askOnce(io, `Reference name [${fallback}] / 存储名: `, value => envName(value, 'reference name'), fallback),
      storedValue: await readSecret(io, fallback),
    }
  }
  if (choice !== '' && choice !== '1') throw new Error(`panedesk: init: choose 1 or 2 (got ${JSON.stringify(choice)})`)
  return {
    name: await askOnce(io, `Environment variable name [${fallback}] / 环境变量名: `, value => envName(value, 'environment variable name'), fallback),
    storedValue: undefined,
  }
}

/** Read the secret once with no echo; the empty answer rejects. */
async function readSecret(io: InitIo, fallback: string): Promise<string> {
  const value = await io.secret('API key (input is not echoed) / 输入密钥(不回显): ')
  if (value.trim().length === 0) {
    io.write('panedesk: init: empty key; nothing was stored / 密钥为空,未存储; re-run init or export ' + fallback)
    throw new Error('panedesk: init: the typed key was empty')
  }
  return value
}

/** Menu default: the protocol key of the first choice. */
const DEFAULT_API_KEY = API_CHOICES[0]?.key ?? 'anthropic-messages'

/** Menu choice for the protocol, with the default option first. */
async function chooseApi(io: InitIo): Promise<string> {
  const menu = `API type / 接口类型:\n${API_CHOICES.map((choice, index) => `  ${index + 1}) ${choice.label} (${choice.key})`).join('\n')}\n[1-3]: `
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = (await io.question(menu)).trim()
    if (answer === '') return DEFAULT_API_KEY
    const index = Number(answer)
    const chosen = Number.isInteger(index) && index >= 1 && index <= API_CHOICES.length ? API_CHOICES[index - 1] : undefined
    if (chosen !== undefined) return chosen.key
  }
  throw new Error('panedesk: init: no valid API type chosen / 未选择有效接口类型')
}

/**
 * Store one reference in the credentials document at `0600` (POSIX) or behind
 * the Windows owner-only DACL seam: create the replacement exclusively, secure
 * it for the current user only, then move it over the target, so an existing
 * document is never left wider than the fresh inode.
 * @param home - harness home holding the credentials document.
 * @param name - reference name (POSIX identifier).
 * @param value - non-empty secret.
 * @param platform - injected platform gate.
 * @param windowsSecurity - injected Windows seam; required on win32.
 */
async function storeCredentialReference(
  home: string,
  name: string,
  value: string,
  platform: NodeJS.Platform,
  windowsSecurity: InitWindowsSecurity | undefined,
): Promise<void> {
  const filename = join(home, CREDENTIALS_DOC_FILENAME)
  const text = renderCredentialsRefUpdate(existsSync(filename) ? readFileSync(filename, 'utf8') : undefined, filename, name, value)
  await mkdir(home, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') {
    // 0600: a document holding secrets is never world-readable.
    await writeFileAtomic(filename, text, { mode: 0o600, dirMode: 0o700 })
    return
  }
  const binding = await import('@panedesk/node-addon-system/windows-private-files')
  const security: InitWindowsSecurity = windowsSecurity ?? {
    secureOwnerOnly: (path) => { binding.secureWindowsPrivatePath(path) },
    replaceOwnerOnly: (source, target) => binding.replaceWindowsPrivatePath(source, target),
  }
  const temp = join(home, `.${basename(filename)}.new-${randomBytes(8).toString('hex')}`)
  const handle = await open(temp, 'wx')
  try {
    security.secureOwnerOnly(temp)
    await handle.writeFile(text, 'utf8')
    await handle.close()
    const status = security.replaceOwnerOnly(temp, filename)
    if (status !== 0) throw new Error(`panedesk: init: Windows owner-only replacement exited with ${status}`)
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temp, { force: true })
    throw error
  }
}

/** Terminal adapter: echoed questions through readline, no-echo secrets through raw mode. */
export function createConsoleIo(): InitIo {
  return {
    write: (text) => { process.stdout.write(text) },
    question: async (prompt) => {
      const lines = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await new Promise<string>((resolve) => { lines.question(prompt, resolve) })
      } finally {
        lines.close()
      }
    },
    secret: async prompt => readTerminalSecret(prompt),
  }
}

/**
 * Read one line without echoing it: a TTY switches to raw mode and reads byte
 * by byte (Enter ends, Backspace edits, Ctrl-C aborts); a pipe or file reads
 * one plain line, where no echo exists to suppress.
 * @param prompt - the prompt text to show once.
 * @returns the typed line without the terminator.
 */
async function readTerminalSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin })
    const iterator = lines[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      return first.done ? '' : first.value
    } finally {
      lines.close()
    }
  }
  stdin.setRawMode(true)
  stdin.resume()
  const state = { interrupted: false }
  const bytes: number[] = []
  try {
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 0x0d || byte === 0x0a) {
            stdin.off('data', onData)
            resolve()
            return
          }
          if (byte === 0x03) {
            state.interrupted = true
            stdin.off('data', onData)
            process.stdout.write('\n')
            resolve()
            return
          }
          if (byte === 0x7f) bytes.pop()
          else bytes.push(byte)
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
  if (state.interrupted) throw new Error('panedesk: init: interrupted / 已中断')
  process.stdout.write('\n')
  return Buffer.from(bytes).toString('utf8')
}
