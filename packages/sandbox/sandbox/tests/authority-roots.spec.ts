/** Content exclusions name only the four host-owned mutable trees. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { authoritativeHomeTrees } from '@panedesk/dsh-sandbox'

it('lists messages alongside the existing host authorities without excluding their parents', () => {
  const home = join(process.cwd(), '.panedesk')
  expect(authoritativeHomeTrees(home)).toEqual([
    join(home, 'ledger'),
    join(home, 'sessions'),
    join(home, 'storages/session_projcache/sessions'),
    join(home, 'messages'),
  ])
})
