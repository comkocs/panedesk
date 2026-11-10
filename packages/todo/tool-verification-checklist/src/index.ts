/**
 * Model-facing verification checklist. Each call appends a `verification/write`
 * snapshot of the whole list to the calling agent's session; the same requirement
 * title replaces its previous checklist, and the list stays across turns. A
 * non-agent caller has no owning session and is rejected.
 * @module @panedesk/dsh-tool-verification-checklist
 */

import type { Context } from '@panedesk/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@panedesk/dsh-tools'
import {
  VERIFICATION_CHECKLIST_CATEGORIES,
  type VerificationChecklistCategory,
  type VerificationChecklistItem,
  type VerificationChecklistSubmission,
} from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@panedesk/dsh-session-projection'
// The projection-key declaration lives in src/types.ts (its one home); this
// re-export projects the type face onto the package root.
export type * from './types.ts'

export const name = 'tool-verification-checklist'
export const inject = ['tools', 'sessionProjections']

const DESCRIPTION =
  'Submit the verification checklist for one requirement before you start. '
  + 'title: one sentence naming the requirement. '
  + 'items: each check has category (one of write, read, build, test-focused, test-full, mutation, client, ci, script, wait, model, other), '
  + 'note (one short line), and minutes (estimated minutes). '
  + 'Submitting again with the same title replaces that requirement. '
  + 'If there is nothing to verify, submit an empty items array. Submitting does not wait for approval.'

const categorySchema = zod.enum(VERIFICATION_CHECKLIST_CATEGORIES)

/** Wire payload schema of the `verificationChecklists` projection. */
const projectionSchema: ZodType<VerificationChecklistSubmission[]> = zod.array(zod.object({
  title: zod.string(),
  items: zod.array(zod.object({
    category: categorySchema,
    note: zod.string(),
    minutes: zod.number(),
  })),
}))

/**
 * Validate one submission and build its canonical form: a trimmed non-empty title,
 * trimmed non-empty notes, unique categories, and finite non-negative minutes.
 * @param raw - the model-supplied submission, already schema-checked.
 * @returns the canonical submission.
 */
function toSubmission(raw: { title: string; items: { category: string; note: string; minutes: number }[] }): VerificationChecklistSubmission {
  const title = raw.title.trim()
  if (title.length === 0) throw new Error('invalid verification checklist: `title` must be a non-empty string')
  const seen = new Set<string>()
  const items: VerificationChecklistItem[] = []
  for (const item of raw.items) {
    if (seen.has(item.category)) {
      throw new Error(`invalid verification checklist: duplicate category ${JSON.stringify(item.category)}`)
    }
    seen.add(item.category)
    const note = item.note.trim()
    if (note.length === 0) throw new Error('invalid verification checklist: `note` must be a non-empty string')
    if (!Number.isFinite(item.minutes) || item.minutes < 0) {
      throw new Error('invalid verification checklist: `minutes` must be a finite number of zero or more')
    }
    items.push({ category: item.category as VerificationChecklistCategory, note, minutes: item.minutes })
  }
  return { title, items }
}

/**
 * Register the `verification_checklist` tool and the `verificationChecklists` projection.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register<'verificationChecklists', VerificationChecklistSubmission[]>({
    key: 'verificationChecklists',
    stateSchema: projectionSchema,
    init: () => [],
    apply: (state, event) => event.type === 'verification/write' ? event.data.checklists : state,
    wire: { viewSchema: projectionSchema, view: state => state },
    stateVersion: 1,
  })
  ctx.tools.register(defineTool({
    name: 'verification_checklist',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: 'One sentence naming the requirement.' },
      items: {
        type: 'array',
        required: true,
        description: 'Planned checks for the requirement. Submit an empty array when there is nothing to verify.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: {
              type: 'string',
              required: true,
              enum: [...VERIFICATION_CHECKLIST_CATEGORIES],
              description: 'Activity category of the check: write, read, build, test-focused, test-full, mutation, client, ci, script, wait, model, or other.',
            },
            note: { type: 'string', required: true, description: 'One short line describing the check.' },
            minutes: { type: 'number', required: true, description: 'Estimated minutes for the check.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded verification checklist "${value.title}" with ${value.count} checks.`,
      }],
    },
    execute(args, exec) {
      const submission = toSubmission(args)
      if (!exec.agent) {
        throw new Error('verification_checklist requires an owning agent session')
      }
      const current = ctx.sessionProjections.stateOf(exec.agent.session, 'verificationChecklists') ?? []
      const checklists = [...current.filter(entry => entry.title !== submission.title), submission]
      exec.agent.session.append('verification/write', { checklists })
      return Promise.resolve({ title: submission.title, count: submission.items.length })
    },
    presentCall: args => ({ card: 'generic', title: 'Verification checklist', kind: 'other', rawInput: args }),
  }))
}
