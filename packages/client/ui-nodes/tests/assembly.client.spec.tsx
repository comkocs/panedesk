// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished } from 'vitest'
import { RemoteMock, ok } from '@panedesk/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, webApp } from '@panedesk/dsh-client-test-runtime/src/assembly/index.ts'
import { en, zh } from '../src/client/locales.ts'

it.each([['en', en], ['zh', zh]] as const)('opens node settings in the shipped composition in %s without an initial entry', async (language, labels) => {
  const locale = { ns: 'locale', schema: {}, value: { preference: language }, base: {}, user: {},
    autoGenerate: true, applies: 'live' as const, secrets: [], revision: 1 }
  const welcome = { ...locale, ns: 'ui-settings-general', value: { welcomeNoticeVersion: '2026-09-28.1' } }
  const mock = RemoteMock.create().load(remoteDefaultResponses)
    .unary('settings/describe', ok({ writable: true, hasDocument: false, namespaces: [locale, welcome] }))
    .unary('settings/mutate', ok(locale))
    .unary('bashSetup/status', ok({ platform: 'linux' }))
    .unary('nodes/read', ok({ view: { nodes: [], callbacks: [], callbacksAvailable: false, callbacksComplete: false,
      sourceOperations: [], sourceAvailable: false }, refreshIntervalMs: 10000 }))
  const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
  onTestFinished(() => client.dispose())
  await act(async () => { client.ctx.locale.setLocale(language) })
  expect(screen.queryByRole('button', { name: labels.title })).toBeNull()
  expect(mock.log.calls('nodes/read')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'Account menu' : '账号菜单' }))
  fireEvent.click(screen.getByRole('menuitem', { name: language === 'en' ? 'Settings' : '设置' }))
  fireEvent.click(await screen.findByRole('button', { name: labels.title }))
  await waitFor(() => { expect(screen.getByRole('heading', { name: labels.title })).toBeTruthy() })
  await waitFor(() => { expect(screen.getByText(labels.callbacksUnavailable)).toBeTruthy() })
  expect(screen.getByText(labels.remoteOnly)).toBeTruthy()
  expect(mock.log.calls('nodes/read').length).toBeGreaterThan(0)
  expect(mock.log.unmatched()).toEqual([])
}, 60000)
