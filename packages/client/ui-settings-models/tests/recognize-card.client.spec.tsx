// @vitest-environment jsdom
/**
 * The provider card asks the route for models and probes a hand-typed id.
 * Both calls go through the operations stand-in; no provider is contacted.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RecognizeModels } from '../src/client/RecognizeModels.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SECRET = 'sk-live-secret-value-0001'

function operations(calls: { provider: string }[]): ModelsOperations {
  return {
    storeCredential: async () => undefined,
    removeCredential: async () => undefined,
    writeSettings: async () => ({ kind: 'refused', message: 'unused' }),
    discoverModels: async (_ns, request) => {
      calls.push({ provider: request.provider ?? '' })
      return {
        kind: 'found',
        models: [
          { id: 'old', createdAt: 1 },
          { id: 'mid', createdAt: 2 },
          { id: 'new', createdAt: 4 },
          { id: 'newer', createdAt: 3 },
        ],
      }
    },
    probeModel: async (_provider, model) => (
      model === 'hand-typed'
        ? { ok: false, message: `rejected ${SECRET} for ${model}` }
        : { ok: true }
    ),
  }
}

describe('RecognizeModels card', () => {
  it.each([
    { locale: 'en', copy: en, recognize: 'Recognize models', adopt: 'Add selected', saved: 'Selected models were added.' },
    { locale: 'zh', copy: zh, recognize: '识别模型', adopt: '添加所选', saved: '已添加所选模型。' },
  ])('adopts the current checklist and reports success in $locale', async ({ copy, recognize, adopt, saved }) => {
    const adopted: string[][] = []
    render(<RecognizeModels settingsNs="models" provider="openai" operations={operations([])} t={key => copy[key]} disabled={false} onAdopt={async (models) => { adopted.push(models.map(model => model.id)); return undefined }} />)
    fireEvent.click(screen.getByRole('button', { name: recognize }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'old' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'mid' }))
    fireEvent.click(screen.getByRole('button', { name: adopt }))
    expect(await screen.findByText(saved)).toBeTruthy()
    expect(adopted).toEqual([['new', 'newer', 'old']])
  })

  it('contains rejected discovery and probe promises', async () => {
    const base = operations([])
    render(<RecognizeModels settingsNs="models" provider="openai" operations={{ ...base, discoverModels: async () => { throw new Error('listing unavailable') }, probeModel: async () => { throw new Error('model refused') } }} t={key => en[key]} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recognize models' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Recognizing models failed: listing unavailable')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try once' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'The try failed: model refused')
  })

  it('checks the three newest models from each route stand-in', async () => {
    const calls: { provider: string }[] = []
    const shared = operations(calls)
    const { unmount } = render(
      <RecognizeModels settingsNs="models" provider="openai" operations={shared} t={key => en[key]} disabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    expect(await screen.findByRole('checkbox', { name: 'new' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'newer' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'mid' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'old' })).toHaveProperty('checked', false)
    unmount()

    render(
      <RecognizeModels settingsNs="models" provider="anthropic" operations={shared} t={key => en[key]} disabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    expect(await screen.findByRole('checkbox', { name: 'new' })).toBeTruthy()
    expect(calls.map(call => call.provider)).toEqual(['openai', 'anthropic'])
  })

  it('reports the probe refusal without the credential text', async () => {
    render(
      <RecognizeModels
        settingsNs="models"
        provider="openai"
        operations={operations([])}
        t={key => en[key]}
        disabled={false}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hand-typed' } })
    fireEvent.click(screen.getByRole('button', { name: en.tryOnce }))
    const status = await screen.findByRole('status')
    expect(status.textContent ?? '').toContain('hand-typed')
    expect(status.textContent ?? '').not.toContain(SECRET)
    expect(document.body.textContent ?? '').not.toContain(SECRET)
  })
})
