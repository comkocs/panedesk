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

function operations(
  calls: { provider: string; baseURL?: string; api?: string }[],
  models: { id: string; createdAt?: number }[] = [
    { id: 'old', createdAt: 1 },
    { id: 'mid', createdAt: 2 },
    { id: 'new', createdAt: 4 },
    { id: 'newer', createdAt: 3 },
  ],
): ModelsOperations {
  return {
    storeCredential: async () => undefined,
    removeCredential: async () => undefined,
    writeSettings: async () => ({ kind: 'refused', message: 'unused' }),
    discoverModels: async (_ns, request) => {
      calls.push({
        provider: request.provider ?? '',
        ...request.baseURL === undefined ? {} : { baseURL: request.baseURL },
        ...request.api === undefined ? {} : { api: request.api },
      })
      return { kind: 'found', models }
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
    { locale: 'en', copy: en, recognize: 'Recognize models', adopt: 'Add selected', saved: 'Added 2 models. They are available in new conversations.' },
    { locale: 'zh', copy: zh, recognize: '识别模型', adopt: '添加所选', saved: '已添加 2 个模型，新建会话时即可选用。' },
  ])('adopts the current checklist and reports success in $locale', async ({ copy, recognize, adopt, saved }) => {
    const adopted: string[][] = []
    render(<RecognizeModels settingsNs="models" provider="openai" operations={operations([])} t={key => copy[key]} disabled={false} onAdopt={async (models) => { adopted.push(models.map(model => model.id)); return undefined }} />)
    fireEvent.click(screen.getByRole('button', { name: recognize }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'old' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'mid' }))
    fireEvent.click(screen.getByRole('button', { name: adopt }))
    expect(await screen.findByText(saved)).toBeTruthy()
    expect(adopted).toEqual([['new', 'newer']])
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

  it('checks the newest two models of each family from each route stand-in', async () => {
    const calls: { provider: string }[] = []
    const shared = operations(calls)
    const { unmount } = render(
      <RecognizeModels settingsNs="models" provider="openai" operations={shared} t={key => en[key]} disabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    expect(await screen.findByRole('checkbox', { name: 'new' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'newer' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'mid' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: 'old' })).toHaveProperty('checked', true)
    unmount()

    render(
      <RecognizeModels settingsNs="models" provider="anthropic" operations={shared} t={key => en[key]} disabled={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    expect(await screen.findByRole('checkbox', { name: 'new' })).toBeTruthy()
    expect(calls.map(call => call.provider)).toEqual(['openai', 'anthropic'])
  })

  it('asks discovery with the route endpoint and protocol already configured', async () => {
    const calls: { provider: string; baseURL?: string; api?: string }[] = []
    render(
      <RecognizeModels
        settingsNs="models"
        provider="acme-gateway"
        endpoint={{ baseURL: 'https://gateway.acme.example/v1', api: 'anthropic-messages' }}
        operations={operations(calls)}
        t={key => en[key]}
        disabled={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    await screen.findByRole('checkbox', { name: 'new' })
    expect(calls).toEqual([{
      provider: 'acme-gateway', baseURL: 'https://gateway.acme.example/v1', api: 'anthropic-messages',
    }])
  })

  it('omits a blank endpoint and a missing protocol from the discovery request', async () => {
    const calls: { provider: string; baseURL?: string; api?: string }[] = []
    render(
      <RecognizeModels
        settingsNs="models"
        provider="acme-gateway"
        endpoint={{ baseURL: '' }}
        operations={operations(calls)}
        t={key => en[key]}
        disabled={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.recognize }))
    await screen.findByRole('checkbox', { name: 'new' })
    expect(calls).toEqual([{ provider: 'acme-gateway' }])
  })

  it.each([
    {
      locale: 'en',
      copy: en,
      guide: 'Click “Recognize models” to read every model this provider offers. Check the ones you want, then click “Add selected” to make them available in conversations.',
      lead: 'The newest 2 models in each family are checked (5 in all). Add or remove checks, then click “Add selected” below to confirm.',
      order: 'The list is ordered by the creation time the provider reported.',
      saved: 'Added 5 models. They are available in new conversations.',
    },
    {
      locale: 'zh',
      copy: zh,
      guide: '点「识别模型」读取这个提供商的全部模型，勾选后点「添加所选」，就能在会话里选用。',
      lead: '已为每个系列勾选最新的 2 个（共 5 个）。可增减勾选，确认后点下方「添加所选」。',
      order: '列表按提供商报告的创建时间排序。',
      saved: '已添加 5 个模型，新建会话时即可选用。',
    },
  ])('guides an empty card, names the real check count, and lists without bullets in $locale', async ({ copy, guide, lead, order, saved }) => {
    const adopted: string[][] = []
    render(
      <RecognizeModels
        settingsNs="models"
        provider="gpt"
        modelCount={0}
        operations={operations([], [
          { id: 'gpt-6.1-sol', createdAt: 6 },
          { id: 'gpt-6-sol', createdAt: 5 },
          { id: 'gpt-5.5-sol', createdAt: 4 },
          { id: 'gpt-6-astra', createdAt: 3 },
          { id: 'claude-opus-5-5', createdAt: 2 },
          { id: 'claude-opus-5', createdAt: 1 },
        ])}
        t={key => copy[key]}
        disabled={false}
        onAdopt={async (models) => { adopted.push(models.map(model => model.id)); return undefined }}
      />,
    )
    expect(screen.getByText(guide)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: copy.recognize }))
    expect(await screen.findByText(lead)).toBeTruthy()
    expect(screen.getByText(order).className).toContain('modelCatalogMeta')
    expect(screen.queryByText(guide)).toBeNull()
    const list = screen.getByRole('list')
    expect(list.className).toContain('candidateList')
    expect(list.querySelectorAll(':scope > li')).toHaveLength(6)
    expect([...list.querySelectorAll(':scope > li')].every(item => item.className.includes('candidate'))).toBe(true)
    expect(screen.getAllByRole('checkbox').filter(box => (box as HTMLInputElement).checked)).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: copy.fetchAdopt }))
    expect(await screen.findByText(saved)).toBeTruthy()
    expect(adopted[0]).toHaveLength(5)
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
