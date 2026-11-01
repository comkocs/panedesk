/**
 * Home-layer file updates for `pdesk init`: merge provider route rows into the
 * home patch list with a timestamped backup, and render the version-1
 * credentials document with one stored reference. Both helpers rewrite the
 * whole file as data, so the previous bytes survive at the backup path the
 * patch helper returns; neither helper ever embeds a secret value in the patch
 * or in a failure message.
 * @module panedesk/init-files
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@panedesk/cordis-plugin-include'
import { writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { PROFILE_PATCH_FILENAME } from './profile.ts'

/** The model route `pdesk init` composes: one provider profile plus the default route. */
export interface ProviderRoute {
  /** Protocol key from the llm-pi-ai provider schema (`anthropic-messages`, `openai-completions`, `openai-responses`). */
  api: string
  /** Endpoint root the provider adapter requests (`https://host/v1`). */
  baseURL: string
  /** Environment-variable name the runtime resolves the key from; never the key value. */
  apiKeyEnv: string
  /** Provider route key in the `llm-pi-ai` providers dict. */
  provider: string
  /** Model id the default route selects. */
  model: string
}

/** Home patch filename inside the harness home (`cordis.patch.yml`). */
export const HOME_PATCH_FILENAME = PROFILE_PATCH_FILENAME

/**
 * The patch rows `pdesk init` owns: a `llm-pi-ai` provider profile keyed by
 * {@link ProviderRoute.provider} and an `agent-default-model` route selecting
 * it. Field set mirrors `examples/providers/openai-chat.yml`; the provider
 * schema's defaults fill every field the rows omit.
 * @param route - the composed route.
 * @returns the two patch entries, in application order.
 */
export function providerPatchEntries(route: ProviderRoute): PatchOptions[] {
  return [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [route.provider]: {
            api: route.api,
            baseURL: route.baseURL,
            apiKeyEnv: route.apiKeyEnv,
            models: [{ id: route.model, name: route.model, input: ['text'] }],
          },
        },
      },
    },
    { id: 'agent-default-model', config: { provider: route.provider, model: route.model } },
  ]
}

/** Outcome of one home patch update. */
export interface HomePatchUpdate {
  /** Timestamped backup holding the previous bytes, or undefined when the patch was absent. */
  backupPath: string | undefined
  /** The rewritten patch path. */
  patchPath: string
}

/**
 * Replace the init-owned rows in the home patch list: entries whose `id`
 * matches a row in {@link providerPatchEntries} are removed, the new rows are
 * appended, and every other entry survives as data. An existing patch first
 * moves to `<path>.bak-<unix-ms>[-<ordinal>]` (the `sanitizeProfile` backup
 * naming), so re-running `pdesk init` never loses the prior overlay. The
 * rewritten file carries a header naming the managed rows; comments outside
 * that header do not survive the data round trip.
 * @param binName - diagnostic prefix for parse failures.
 * @param home - harness home whose patch file to update.
 * @param route - the composed route.
 * @returns the backup path, when one was created, and the patch path.
 * @throws when the existing file is not a patch list; the file is then restored from the backup.
 */
export async function updateHomeProviderPatch(binName: string, home: string, route: ProviderRoute): Promise<HomePatchUpdate> {
  const patchPath = join(home, HOME_PATCH_FILENAME)
  let backupPath: string | undefined
  let existing: PatchOptions[] = []
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    if (text.trim().length > 0) {
      const loaded: unknown = loadYaml(text, { schema: entryListSchema })
      if (!Array.isArray(loaded)) {
        throw new Error(`${binName}: ${patchPath} is not a patch list (top-level YAML array); fix or remove it, then re-run init`)
      }
      existing = loaded as PatchOptions[]
    }
    backupPath = backupWithTimestamp(patchPath)
  }
  const managed = new Set(providerPatchEntries(route).map(entry => entry.id))
  const merged = [...existing.filter(entry => entry.id === undefined || !managed.has(entry.id)), ...providerPatchEntries(route)]
  const header = `# ${binName} init manages the llm-pi-ai and agent-default-model rows; other entries are preserved.\n`
  const body = dumpYaml(merged, { schema: entryListSchema, lineWidth: 100, noRefs: true })
  await writeFileAtomic(patchPath, `${header}${body}`, { mode: 0o644, dirMode: 0o755 })
  return { backupPath, patchPath }
}

/** Move the file aside under the `sanitizeProfile` backup naming, dodging collisions. */
function backupWithTimestamp(patchPath: string): string {
  const base = `${patchPath}.bak-${Date.now()}`
  let backupPath = base
  let ordinal = 0
  while (existsSync(backupPath)) backupPath = `${base}-${++ordinal}`
  renameSync(patchPath, backupPath)
  return backupPath
}

/** Credentials-document filename inside the harness home. */
export const CREDENTIALS_DOC_FILENAME = '.credentials.yaml'

/** Credentials document layout version written and accepted here. */
export const CREDENTIALS_DOC_VERSION = 1

/**
 * Render the credentials document with one stored reference set: `refs.<name>`
 * becomes `value`, every other reference and record survives, and the
 * `version: 1` marker stays. The dumper quotes the value, so any secret
 * spelling round-trips; callers must keep the rendered text out of logs.
 * @param text - the current document text, or undefined when none exists.
 * @param filename - path quoted in failure messages.
 * @param name - POSIX-identifier reference name (the `apiKeyEnv` value).
 * @param value - the non-empty secret to store.
 * @returns the complete next document text.
 * @throws when the existing text is not a version-1 credentials document.
 */
export function renderCredentialsRefUpdate(text: string | undefined, filename: string, name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`${filename}: reference name ${JSON.stringify(name)} is not a POSIX identifier`)
  }
  if (value.length === 0) throw new TypeError(`${filename}: reference ${name} must not be empty`)
  let document: Record<string, unknown>
  if (text !== undefined && text.trim().length > 0) {
    const loaded: unknown = loadYaml(text)
    if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
      throw new TypeError(`${filename}: must be a mapping`)
    }
    document = { ...loaded as Record<string, unknown> }
    if (document['version'] !== CREDENTIALS_DOC_VERSION) {
      throw new Error(`${filename}: declares version ${JSON.stringify(document['version'])}; expected ${CREDENTIALS_DOC_VERSION}`)
    }
    const refs = document['refs']
    if (refs !== undefined && (typeof refs !== 'object' || refs === null || Array.isArray(refs))) {
      throw new TypeError(`${filename}: "refs" must be a mapping`)
    }
    document['refs'] = { ...(refs ?? {}), [name]: value }
  } else {
    document = { version: CREDENTIALS_DOC_VERSION, refs: { [name]: value } }
  }
  return dumpYaml(document, { lineWidth: 100 })
}
