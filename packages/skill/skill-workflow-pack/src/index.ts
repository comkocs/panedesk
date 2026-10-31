/** Bundled project-start guidance with portable workflow-pack resources. */
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@panedesk/dsh-skill'

/** Resource override for packaged deployments. */
export interface Config {
  /** Absolute directory containing getting-started.md and the complete pack. */
  assetRoot?: string
}

/** Validated deployment resource location. */
export const Config: z<Config> = z.object({ assetRoot: z.string().min(1) })
/** Loader plugin identity. */
export const name = 'skill-workflow-pack'
/** Registry receiving the bundled skill. */
export const inject = ['skills']

/** Register the first-window guide without running it or writing into projects.
 * @param ctx Context providing the skill registry.
 * @param config Optional deployment-owned resource location.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const root = config.assetRoot ?? fileURLToPath(new URL(
    import.meta.url.endsWith('/src/index.ts') ? '../../../../templates/workflow-pack/' : './workflow-pack/', import.meta.url))
  if (!isAbsolute(root)) throw new Error('skill-workflow-pack: assetRoot must be absolute')
  const directory = resolve(root)
  const locator = join(directory, 'getting-started.md')
  readFileSync(locator, 'utf8')
  for (const resource of ['entries.jsonl', 'tools/trim.py', 'profiles']) statSync(join(directory, resource))
  const candidate: SkillCandidate = {
    name: 'workflow-pack',
    description: 'Start a project by checking requirements and selecting a minimal collaboration rule set; read getting-started before generating any project files.',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-workflow-pack', source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator,
  }
  const provider: SkillProvider = {
    name: 'dsh-workflow-pack',
    list: () => Promise.resolve([candidate]),
    async get(selected, options) {
      const { rank: _rank, locator: _locator, ...summary } = selected
      return { ...summary, content: await readFile(locator, { encoding: 'utf8', signal: options.signal }) }
    },
  }
  ctx.skills.registerProvider(() => provider)
}
