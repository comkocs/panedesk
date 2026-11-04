/** The generated catalog retains the asynchronous protected workspace grant API. */
import { expect, it } from 'vitest'
import { SERVICE_API, EVENT_API, TYPE_API, INHERITED_CTX_API } from '../src/api-catalog.ts'

it('ships generated services, events, types and inherited context declarations', () => {
  expect(SERVICE_API.length).toBeGreaterThan(0)
  expect(EVENT_API.length).toBeGreaterThan(0)
  expect(TYPE_API.length).toBeGreaterThan(0)
  expect(INHERITED_CTX_API.length).toBeGreaterThan(0)
  expect(JSON.stringify(SERVICE_API)).toContain('Capture completion when protected workspace inputs must be recorded')
})
