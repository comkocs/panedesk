/** Read Claude Code MCP declarations without changing their source files. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function readConfig(file: string): Record<string, unknown> {
  try {
    return object(JSON.parse(readFileSync(file, 'utf8')))
  } catch (_unreadableConfig) {
    // Optional Claude Code sources never prevent startup.
    return {}
  }
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const replacement = process.env[name] ?? fallback
    if (replacement === undefined) throw new Error('Missing MCP environment variable')
    return replacement
  })
}

function strings(value: unknown): Record<string, string> {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new Error('Invalid MCP string map')
  }
  return Object.fromEntries(Object.entries(object(value)).map(([name, entry]) => {
    if (typeof entry !== 'string') throw new Error('Invalid MCP string value')
    return [name, expand(entry)]
  }))
}

type ClientConfig = { serverName: string } & (
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { transport: 'streamable-http' | 'sse'; url: string; headers: Record<string, string> }
)

/** One imported client input and the absolute path of its Claude Code configuration file. */
interface ClaudeMcpServer {
  readonly config: ClientConfig
  readonly sourceFile: string
}

/**
 * Read user, shared-project, and local-project MCP declarations, in ascending priority.
 * @param workspace - project directory captured by the launcher.
 * @param home - user home directory; defaults to the process user's home.
 * @returns usable client inputs with source paths; unreadable files and invalid entries contribute nothing.
 */
export function readClaudeMcpServers(workspace: string, home = homedir()): ClaudeMcpServer[] {
  workspace = resolve(workspace)
  const userFile = resolve(home, '.claude.json')
  const projectFile = resolve(workspace, '.mcp.json')
  const user = readConfig(userFile)
  const servers = new Map<string, ClaudeMcpServer>()
  for (const [sourceFile, declarations] of [
    [userFile, user['mcpServers']],
    [projectFile, readConfig(projectFile)['mcpServers']],
    [userFile, object(object(user['projects'])[workspace])['mcpServers']],
  ] as const) {
    for (const [name, value] of Object.entries(object(declarations))) {
      try {
        const entry = object(value)
        const serverName = /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name
          : `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 20) || 'server'}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
        let config: ClientConfig
        if (entry['type'] === 'http' || entry['type'] === 'sse') {
          if (typeof entry['url'] !== 'string') continue
          const url = expand(entry['url'])
          if (!['http:', 'https:'].includes(new URL(url).protocol)) continue
          config = { transport: entry['type'] === 'http' ? 'streamable-http' : 'sse', serverName, url, headers: strings(entry['headers']) }
        } else {
          if (entry['type'] !== undefined && entry['type'] !== 'stdio') continue
          if (typeof entry['command'] !== 'string') continue
          const command = expand(entry['command'])
          if (command.trim() === '') continue
          const args = entry['args'] ?? []
          if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) continue
          config = { transport: 'stdio', serverName, command, args: args.map(expand), env: strings(entry['env']), cwd: workspace }
        }
        servers.set(serverName, { config, sourceFile })
      } catch (_invalidServer) {
        // One malformed declaration does not hide other servers or block startup.
      }
    }
  }
  return [...servers.values()]
}
