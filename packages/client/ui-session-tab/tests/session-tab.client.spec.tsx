// @vitest-environment jsdom
/** The session menu item, the pin, and the pin list. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@panedesk/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { OpenInRightMenuItemProps } from '../src/client/OpenInRightMenuItem.tsx'
import type { PinActionProps } from '../src/client/PinAction.tsx'
import type { SessionTabBodyProps } from '../src/client/SessionTabBody.tsx'
import { OpenInRightMenuItem } from '../src/client/OpenInRightMenuItem.tsx'
import { PinAction } from '../src/client/PinAction.tsx'
import type { SidebarRightTabInfo } from '@panedesk/dsh-client-ui-sidebar-right/client'
import { SessionTabBody } from '../src/client/SessionTabBody.tsx'
import { en, zh } from '../src/client/locales.ts'
import { addPin, removePin, readPins, browserPinStorage, PIN_STORAGE_KEY, type PinStorage } from '../src/client/pins.ts'

afterEach(cleanup)

const zhT = makeTranslate(zh)
const enT = makeTranslate(en)
const SESSION = 'session-1' as SessionId
type MessageId = PinActionProps['messageId']

function Body(props: Pick<SessionTabBodyProps, 't' | 'useTabInfo' | 'useResource' | 'SessionProvider' | 'renderSlot' | 'usePins' | 'jump'>) {
  return <SessionTabBody {...props as SessionTabBodyProps} />
}

function Action(props: Pick<PinActionProps, 't' | 'sessionId' | 'messageId' | 'usePins' | 'toggle'>) {
  return <PinAction {...props as PinActionProps} />
}

function Menu(props: Pick<OpenInRightMenuItemProps, 't' | 'sessionId' | 'displayTitle' | 'useShortcuts' | 'useMenuOpenState' | 'open'>) {
  return <OpenInRightMenuItem {...props as OpenInRightMenuItemProps} />
}

function memory(): PinStorage {
  const items = new Map<string, string>()
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value) },
  }
}

describe('session tab surfaces', () => {
  it.each([
    [zhT, '钉住的条目', '这个会话还没有钉住的条目', '正在打开会话', '钉住失败,没有保存', '钉住'],
    [enT, 'Pinned entries', 'This session has no pinned entries', 'Opening the session', 'Pinning failed; nothing was saved', 'Pin'],
  ] as const)('localizes the bookmark body and failed action', (t, title, empty, loading, failed, pin) => {
    const ui = render(<Body t={t}
      useTabInfo={() => ({ tab: { navigation: { params: { sessionId: SESSION } } } }) as SidebarRightTabInfo}
      useResource={() => ({ status: 'loading', value: undefined, failure: undefined })}
      SessionProvider={({ children }) => children} renderSlot={() => null}
      usePins={selector => selector({ status: 'empty' })} jump={() => false} />)
    expect(ui.getByText(title)).toBeTruthy()
    expect(ui.getByText(empty)).toBeTruthy()
    expect(ui.getByRole('status').textContent).toBe(loading)
    ui.unmount()
    const action = render(<Action t={t} sessionId={SESSION} messageId={'message' as MessageId}
      usePins={selector => selector({ status: 'empty' })} toggle={() => 'failed'} />)
    fireEvent.click(action.getByRole('button', { name: pin }))
    expect(action.getByRole('status').textContent).toBe(failed)
  })
  it('offers the Chinese menu label and says when three sessions are already open', () => {
    const open = vi.fn(() => false)
    const setOpen = vi.fn()
    const ui = render(<Menu sessionId={SESSION} displayTitle="" useShortcuts={selector => selector([])} useMenuOpenState={() => [true, setOpen]} open={open} t={zhT} />)
    fireEvent.click(ui.getByRole('menuitem', { name: '在右栏打开' }))
    expect(open).toHaveBeenCalledWith(SESSION)
    expect(ui.getByRole('status').textContent).toBe('主区加右栏最多三个会话,请先关闭一个')
    expect(setOpen).not.toHaveBeenCalled()
  })

  it('pins a message in English and says the pin stays after a restart', () => {
    const toggle = vi.fn()
      .mockReturnValueOnce('pinned')
      .mockReturnValueOnce('unpinned')
    const ui = render(<Action sessionId={SESSION} messageId={'message-1' as MessageId} usePins={selector => selector({ status: 'empty' })} toggle={toggle} t={enT} />)
    fireEvent.click(ui.getByRole('button', { name: 'Pin' }))
    expect(toggle).toHaveBeenCalledWith('message-1')
    ui.rerender(<Action sessionId={SESSION} messageId={'message-1' as MessageId} usePins={selector => selector({ status: 'ready', pins: [{ sessionId: SESSION, messageId: 'message-1', pinnedAt: 1 }] })} toggle={toggle} t={enT} />)
    expect(ui.getByRole('button', { pressed: true }).textContent).toContain('Unpin')
    expect(ui.getByRole('status').textContent).toBe('Pinned; it stays after a restart')
    fireEvent.click(ui.getByRole('button', { name: 'Unpin' }))
    ui.rerender(<Action sessionId={SESSION} messageId={'message-1' as MessageId} usePins={selector => selector({ status: 'empty' })} toggle={toggle} t={enT} />)
    expect(ui.getByRole('button', { pressed: false }).textContent).toContain('Pin')
    expect(ui.queryByText('Pinning failed; nothing was saved')).toBeNull()
  })

  it('lists a stored pin and jumps to the message it names', () => {
    const jump = vi.fn(() => true)
    const ui = render(<Body
      t={enT}
      useTabInfo={() => ({ tab: { navigation: { params: { sessionId: SESSION } } } }) as SidebarRightTabInfo}
      useResource={() => ({ status: 'loading', value: undefined, failure: undefined })}
      SessionProvider={({ children }) => children}
      renderSlot={() => null}
      usePins={selector => selector({ status: 'ready', pins: [{ sessionId: SESSION, messageId: 'message-9', pinnedAt: 1 }] })}
      jump={jump}
    />)
    fireEvent.click(ui.getByRole('button', { name: /Jump to this entry/ }))
    expect(jump).toHaveBeenCalledWith(ui.container.querySelector('[data-session-tab]'), 'message-9')
  })
})

describe('pin storage', () => {
  it('keeps browser localStorage pins across reader restart and isolates identical message IDs by session', () => {
    localStorage.clear()
    const first = browserPinStorage()
    expect(first).toBeDefined()
    addPin(first!, { sessionId: SESSION, messageId: 'same', pinnedAt: 5 })
    addPin(first!, { sessionId: 'other' as SessionId, messageId: 'same', pinnedAt: 6 })
    expect(readPins(browserPinStorage())).toEqual({ status: 'ready', pins: [
      { sessionId: SESSION, messageId: 'same', pinnedAt: 5 },
      { sessionId: 'other', messageId: 'same', pinnedAt: 6 },
    ] })
    removePin(first!, SESSION, 'same')
    expect(readPins(browserPinStorage())).toEqual({ status: 'ready', pins: [{ sessionId: 'other', messageId: 'same', pinnedAt: 6 }] })
    localStorage.clear()
  })

  it('does not overwrite damaged storage or claim a rejected write was saved', () => {
    const store = memory()
    store.setItem(PIN_STORAGE_KEY, '{"schemaVersion":1,"pins":false}')
    expect(readPins(store).status).toBe('error')
    expect(() => removePin(store, SESSION, 'message')).toThrow()
    expect(store.getItem(PIN_STORAGE_KEY)).toBe('{"schemaVersion":1,"pins":false}')
    const blocked: PinStorage = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(() => addPin(blocked, { sessionId: SESSION, messageId: 'message', pinnedAt: 1 })).toThrow('quota')
    expect(readPins(undefined)).toEqual({ status: 'unavailable' })
  })
  it('refuses an unsupported document version without replacing saved pins', () => {
    const store = memory()
    const raw = JSON.stringify({ schemaVersion: 2, pins: [{ sessionId: SESSION, messageId: 'future', pinnedAt: 5 }] })
    store.setItem(PIN_STORAGE_KEY, raw)
    expect(readPins(store).status).toBe('error')
    expect(() => addPin(store, { sessionId: SESSION, messageId: 'new', pinnedAt: 6 })).toThrow()
    expect(store.getItem(PIN_STORAGE_KEY)).toBe(raw)
  })

  it('keeps a pin after the reader is created again over the same storage', () => {
    const store = memory()
    addPin(store, { sessionId: SESSION, messageId: 'message-2', pinnedAt: 5 })
    const again = readPins(store)
    expect(again.status).toBe('ready')
    if (again.status === 'ready') expect(again.pins).toEqual([{ sessionId: SESSION, messageId: 'message-2', pinnedAt: 5 }])
  })
})
