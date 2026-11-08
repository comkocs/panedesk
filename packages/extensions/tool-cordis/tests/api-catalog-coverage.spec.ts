/** The generated catalog includes every declaration category. */
import { expect, it } from 'vitest'
import { SERVICE_API, EVENT_API, TYPE_API, INHERITED_CTX_API } from '../src/api-catalog.ts'

it('ships generated services, events, types and inherited context declarations', () => {
  expect(SERVICE_API.length).toBeGreaterThan(0)
  expect(EVENT_API.length).toBeGreaterThan(0)
  expect(TYPE_API.length).toBeGreaterThan(0)
  expect(INHERITED_CTX_API.length).toBeGreaterThan(0)
})
