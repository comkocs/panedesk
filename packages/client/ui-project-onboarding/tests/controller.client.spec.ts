/** Revision, persistence, and lifetime checks for workspace preferences. */
import { describe, expect, it, vi } from 'vitest'
import { ProjectPreferencesController } from '../src/client/controller.ts'
import type { SettingsNamespaceView } from '@panedesk/dsh-settings/types'
import type { ProjectSelection } from '../src/types.ts'

function namespace(projects: Record<string, ProjectSelection> = {}, revision = 0): SettingsNamespaceView {
  return { ns: 'ui-project-onboarding', schema: {}, value: { projects: Object.fromEntries(Object.entries(projects).map(([path, choice]) => [path, { ...choice }])) }, revision,
    applies: 'live', autoGenerate: false, secrets: [] }
}

function fixture(writable = true) {
  let current = namespace()
  const select = vi.fn(async (path: string, choice: ProjectSelection, revision: number) => {
    expect(revision).toBe(current.revision)
    const previous = current.value
    if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Invalid fixture')
    const projects = previous.projects
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) throw new Error('Invalid projects')
    current = { ...current, revision: revision + 1, value: { projects: { ...projects, [path]: { ...choice } } } }
    return { ok: true, value: current }
  })
  const describe = vi.fn(async () => ({ ok: true, value: { writable, hasDocument: true, namespaces: [current] } }))
  const controller = new ProjectPreferencesController({ describe, select })
  return { controller, select, describe }
}

describe('project preferences', () => {
  it('discards an older read and reloads a settings notification after a pending write', async () => {
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<typeof f.describe>>) => void
    f.describe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const older = f.controller.load()
    await f.controller.load()
    finish({ ok: true, value: { writable: false, hasDocument: true, namespaces: [namespace({}, 99)] } })
    await older
    expect(f.controller.state.getSnapshot()).toMatchObject({ writable: true, revision: 0 })
    let release!: () => void
    const original = f.select.getMockImplementation()!
    f.select.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve })
      return original(...args)
    })
    const saving = f.controller.select('/project', 'auto')
    await f.controller.load()
    expect(f.describe).toHaveBeenCalledTimes(2)
    release()
    expect(await saving).toBe(true)
    expect(f.describe).toHaveBeenCalledTimes(3)
    expect(f.controller.state.getSnapshot()).toMatchObject({ status: 'ready', projects: { '/project': { mode: 'auto', chosen: true } } })
  })

  it('persists a first choice and later mode changes without crossing workspace paths', async () => {
    const { controller, select } = fixture()
    await controller.load()
    expect(controller.state.getSnapshot().projects).toEqual({})
    expect(await controller.select('/project-one', 'remind')).toBe(true)
    await controller.load()
    expect(controller.state.getSnapshot().projects['/project-one']).toEqual({ mode: 'remind', chosen: true })
    expect(await controller.select('/project-two', 'auto')).toBe(true)
    expect(await controller.select('/project-one', 'off')).toBe(true)
    expect(controller.state.getSnapshot().projects).toEqual({ '/project-one': { mode: 'off', chosen: true }, '/project-two': { mode: 'auto', chosen: true } })
    expect(select).toHaveBeenCalledTimes(3)
  })

  it('does not mark a refused selection chosen or write read-only settings', async () => {
    const { controller, select } = fixture()
    await controller.load()
    select.mockRejectedValueOnce(new Error('Write refused'))
    expect(await controller.select('/project', 'auto')).toBe(false)
    expect(controller.state.getSnapshot()).toMatchObject({ projects: {}, error: true, saved: false })
    const readOnly = fixture(false)
    await readOnly.controller.load()
    expect(await readOnly.controller.select('/project', 'auto')).toBe(false)
    expect(readOnly.select).not.toHaveBeenCalled()
  })

  it('retains structured compensation outcomes without marking a failed save chosen', async () => {
    const outcomes = [{ projectId: 'project-a', status: 'restored' }, { projectId: 'project-b', status: 'conflict' },
      { projectId: 'project-c', status: 'failed' }]
    const controller = new ProjectPreferencesController({
      describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } }),
      select: async () => ({ ok: false, error: { message: 'Review policies', code: 'project-opening/compensation', details: { outcomes } } }),
    })
    await controller.load()
    expect(await controller.select('/project', 'auto')).toBe(false)
    expect(controller.state.getSnapshot()).toMatchObject({ projects: {}, error: true, saved: false, compensation: outcomes })
  })

  it('does not publish a read after disposal', async () => {
    let finish!: (value: { ok: boolean; value: { writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] } }) => void
    const controller = new ProjectPreferencesController({
      describe: () => new Promise((resolve) => { finish = resolve }), select: async () => ({ ok: false }),
    })
    const reading = controller.load()
    const before = controller.state.getSnapshot()
    controller.dispose()
    finish({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await reading
    expect(controller.state.getSnapshot()).toBe(before)
  })
})
