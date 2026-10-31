import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/client/polling.js'], {
  lib: { entry: { index: 'lib/types/index.js', polling: 'lib/types/client/polling.js' } },
})
