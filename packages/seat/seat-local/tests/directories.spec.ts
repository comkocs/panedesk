import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SeatName, SeatPrincipalId } from '@panedesk/dsh-seat'
import { DirectoryAdmission } from '../src/directory-admission.ts'
import { subscriptionFiles } from '../src/subscriptions.ts'
import { definition, seat } from './fixtures.ts'

const roots: string[] = []
const principal = 'principal-a' as SeatPrincipalId
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() { const root = await mkdtemp(join(tmpdir(), 'seat-directories-')); roots.push(root); return root }

describe('directory admission', () => {
  it('returns all three choices before create and returns a usable command for headless callers', async () => {
    const root = await setup(), admission = new DirectoryAdmission(10)
    const definitions = [definition(root)]
    const result = await admission.resolve({ cwd: root, seat: 'seat-b' as SeatName, interactive: true }, principal, definitions)
    expect(result).toEqual({ status: 'choice-required', candidates: [seat], choices: ['open-seat', 'traditional', 'cancel'],
      alternative: "panedesk --profile seat open --seat 'seat-a'" })
    const headless = await admission.resolve({ cwd: root, interactive: false }, principal, definitions)
    expect(headless).toEqual(result)
    expect(await admission.resolve({ cwd: root, seat, interactive: false }, principal, definitions)).toEqual({ status: 'allowed', identity: 'seat', seat })
  })

  it('lists shared owners and binds traditional confirmation to one principal and one creation', async () => {
    const root = await setup(), admission = new DirectoryAdmission(10)
    const definitions = [definition(root), definition(root, { seat: 'seat-b' as SeatName })]
    const result = await admission.resolve({ cwd: root, interactive: true }, principal, definitions)
    expect(result).toMatchObject({ candidates: ['seat-a', 'seat-b'], choices: ['open-seat', 'traditional', 'cancel'] })
    const confirmation = await admission.confirm(root, principal, definitions, { kind: 'traditional' })
    const request = { cwd: root, confirmation, interactive: true }
    expect(await admission.resolve(request, principal, definitions)).toEqual({ status: 'allowed', identity: 'free' })
    expect(await admission.resolve(request, principal, definitions)).toMatchObject({ status: 'rejected', error: { code: 'seat-choice-required' } })
    const wrongPrincipal = await admission.confirm(root, principal, definitions, { kind: 'traditional' })
    expect(await admission.resolve({ ...request, confirmation: wrongPrincipal }, 'principal-b' as SeatPrincipalId, definitions)).toMatchObject({ status: 'rejected' })
    expect(definitions.map(item => item.seat)).toEqual(['seat-a', 'seat-b'])
  })

  it('admits an unowned directory as free and rejects changed candidate revisions', async () => {
    const root = await setup(), admission = new DirectoryAdmission(10)
    const owned = join(root, 'owned'); await mkdir(owned)
    const definitions = [definition(owned)]
    expect(await admission.resolve({ cwd: root, interactive: false }, principal, definitions)).toEqual({ status: 'allowed', identity: 'free' })
    const confirmation = await admission.confirm(owned, principal, definitions, { kind: 'open-seat', seat })
    expect(await admission.resolve({ cwd: owned, confirmation, interactive: true }, principal, [definition(owned, { revision: 2 })])).toMatchObject({ status: 'rejected' })
  })

  it.skipIf(process.platform === 'win32')('refuses foreign requested paths without treating foreign catalog roots as local owners', async () => {
    const root = await setup(), admission = new DirectoryAdmission(10)
    const definitions = [definition('C:\\work\\seat-a')]
    expect(await admission.resolve({ cwd: root, interactive: false }, principal, definitions)).toEqual({ status: 'allowed', identity: 'free' })
    expect(await admission.resolve({ cwd: 'C:\\work\\seat-a', interactive: false }, principal, definitions)).toMatchObject({
      status: 'rejected', error: { code: 'invalid-definition', effectState: 'none' },
    })
  })

  it('deduplicates discovered, opening and configured subscriptions per session', async () => {
    const root = await setup()
    const rule = join(root, 'rule.md'), extra = join(root, 'extra.md')
    expect(await subscriptionFiles(definition(root, { opening: { kind: 'file', path: rule },
      openingInstructionFiles: [rule], subscriptions: [extra, rule] }), [rule])).toEqual([rule, extra])
  })
})
