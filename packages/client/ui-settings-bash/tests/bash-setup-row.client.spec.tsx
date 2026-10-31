// @vitest-environment jsdom
import type { GlobalStandardProps } from '@panedesk/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, makeTranslate } from '@panedesk/dsh-client-test-runtime'
import type { BashSetupStatus } from '@panedesk/dsh-host-bash-setup/types'
import { BashSetupRow } from '../src/client/BashSetupRow.tsx'
import type { BashSetupRowInjected } from '../src/client/BashSetupRow.tsx'
import { en, zh } from '../src/client/locales.ts'
// Type-only: pulls the LocaleNamespaceMap merge so PropsLocale<'settings.bashSetup'> yields `t`.
import type {} from '../src/client/index.ts'

// Global standard kit stubs: none of these hooks are consumed by the row.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unusedHook = (() => { throw new Error('unused by the bash setup row') }) as never
const kit = {
  useSessions: unusedHook, useSessionStatus: unusedHook,
  usePanelInfo, useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
  ...allowAllAccess,
}

/** Scripted face: a fixed read plus call-recording writes answering with the post-write facts. */
type ScriptedFace = BashSetupRowInjected & { enableCalls: string[]; disableCalls: number[] }

function face(initial: BashSetupStatus, afterWrite: BashSetupStatus): ScriptedFace {
  const enableCalls: string[] = []
  const disableCalls: number[] = []
  return {
    enableCalls, disableCalls,
    read: () => Promise.resolve(initial),
    enable: (bashPath) => { enableCalls.push(bashPath); return Promise.resolve(afterWrite) },
    disable: () => { disableCalls.push(disableCalls.length); return Promise.resolve(afterWrite) },
  }
}

const probed: BashSetupStatus = {
  platform: 'win32',
  probe: { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', source: 'program-files' },
}
const committed: BashSetupStatus = {
  platform: 'win32',
  probe: { bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe', source: 'program-files' },
  config: { enabled: true, bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
}

afterEach(cleanup)

describe('BashSetupRow', () => {
  it('keeps the probe unwritten until the confirmation click commits it (zh)', async () => {
    const f = face(probed, committed)
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={f.read} enable={f.enable} disable={f.disable} />)
    expect((await screen.findByText(/C:.Program Files.Git.bin.bash.exe/)).textContent).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(screen.getByText(zh['probe.hint'])).toBeTruthy()
    // The probe alone writes nothing: the confirmation click is the write trigger.
    expect(f.enableCalls).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: zh['probe.write'] }))
    expect(f.enableCalls).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe'])
    await waitFor(() => { expect(screen.getByText(zh['committed.restart'])).toBeTruthy() })
  })

  it('commits the probed executable on click and reports the committed state (en)', async () => {
    let finish!: (facts: BashSetupStatus) => void
    const enable = vi.fn(() => new Promise<BashSetupStatus>((resolve) => { finish = resolve }))
    render(<BashSetupRow {...kit} t={makeTranslate(en)} read={() => Promise.resolve(probed)}
      enable={enable} disable={() => Promise.resolve(probed)} />)
    expect(await screen.findByText(en['probe.found'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['probe.write'] }))
    // The write stays pending: the button shows its busy copy and blocks repeats.
    expect(screen.getByRole('button', { name: en['probe.busy'] })).toBeTruthy()
    finish(committed)
    await waitFor(() => { expect(screen.getByText(en['committed.title'])).toBeTruthy() })
    expect(screen.getByText(en['committed.restart'])).toBeTruthy()
  })

  it('carries the install instructions when no installation is found (zh)', async () => {
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={() => Promise.resolve({ platform: 'win32' })}
      enable={() => Promise.resolve(probed)} disable={() => Promise.resolve(probed)} />)
    expect(await screen.findByText(zh['notFound.title'])).toBeTruthy()
    expect(screen.getByText(zh['notFound.step1'])).toBeTruthy()
    expect(screen.getByText(zh['notFound.step2'])).toBeTruthy()
    expect(screen.getByText(zh['notFound.step3'])).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('carries the same instructions in English (en)', async () => {
    render(<BashSetupRow {...kit} t={makeTranslate(en)} read={() => Promise.resolve({ platform: 'win32' })}
      enable={() => Promise.resolve(probed)} disable={() => Promise.resolve(probed)} />)
    expect(await screen.findByText(en['notFound.title'])).toBeTruthy()
    expect(screen.getByText(en['notFound.step1'])).toBeTruthy()
    expect(screen.getByText(en['notFound.step3'])).toBeTruthy()
  })

  it('restores the platform default from the committed state (zh)', async () => {
    let finish!: (facts: BashSetupStatus) => void
    const disable = vi.fn(() => new Promise<BashSetupStatus>((resolve) => { finish = resolve }))
    const f = face(committed, probed)
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={f.read} enable={f.enable} disable={disable} />)
    expect(await screen.findByText(zh['committed.title'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['committed.disable'] }))
    expect(disable).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: zh['committed.busy'] })).toBeTruthy()
    finish(probed)
    await waitFor(() => { expect(screen.getByText(zh['probe.found'])).toBeTruthy() })
  })

  it('reports the environment override as the already-selected Bash and offers no write (en)', async () => {
    const overridden: BashSetupStatus = { platform: 'win32', envOverride: 'D:\\tools\\bash.exe' }
    render(<BashSetupRow {...kit} t={makeTranslate(en)} read={() => Promise.resolve(overridden)}
      enable={() => Promise.resolve(overridden)} disable={() => Promise.resolve(overridden)} />)
    expect(await screen.findByText(en['env.title'])).toBeTruthy()
    expect(screen.getByText(/D:.tools.bash.exe/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('states it only applies to Windows hosts elsewhere (zh)', async () => {
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={() => Promise.resolve({ platform: 'linux' })}
      enable={() => Promise.resolve(probed)} disable={() => Promise.resolve(probed)} />)
    expect(await screen.findByText(zh.unsupported)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('recovers from a failed check through the retry action (zh)', async () => {
    const f = face(probed, committed)
    let broken = true
    const read = () => broken ? Promise.reject(new Error('down')) : f.read()
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={read} enable={f.enable} disable={f.disable} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.retry })).toBeTruthy()
    broken = false
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(screen.getByText(zh['probe.found'])).toBeTruthy() })
  })

  it('reports a failed confirmation write without losing the probe (en)', async () => {
    const enable = vi.fn(() => Promise.reject(new Error('denied')))
    render(<BashSetupRow {...kit} t={makeTranslate(en)} read={() => Promise.resolve(probed)} enable={enable}
      disable={() => Promise.resolve(probed)} />)
    fireEvent.click(await screen.findByRole('button', { name: en['probe.write'] }))
    await waitFor(() => { expect(screen.getByText(en['probe.failed'])).toBeTruthy() })
    expect(screen.getByText(en['probe.found'])).toBeTruthy()
  })

  it('reports a failed restore without losing the committed state (zh)', async () => {
    const disable = vi.fn(() => Promise.reject(new Error('denied')))
    render(<BashSetupRow {...kit} t={makeTranslate(zh)} read={() => Promise.resolve(committed)}
      enable={() => Promise.resolve(committed)} disable={disable} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['committed.disable'] }))
    await waitFor(() => { expect(screen.getByText(zh['committed.failed'])).toBeTruthy() })
    expect(screen.getByText(zh['committed.title'])).toBeTruthy()
  })

  it('ignores a read that settles after the row unmounts (en)', async () => {
    let settle!: (facts: BashSetupStatus) => void
    const read = () => new Promise<BashSetupStatus>((resolve) => { settle = resolve })
    const { unmount } = render(<BashSetupRow {...kit} t={makeTranslate(en)} read={read}
      enable={() => Promise.resolve(probed)} disable={() => Promise.resolve(probed)} />)
    unmount()
    settle(probed)
    expect(document.body.textContent).toBe('')
  })
})
