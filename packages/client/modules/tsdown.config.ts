import { clientBundle } from '../tsdown.client.ts'
import { clientBuildMetadata } from '../../../scripts/client-build-environment.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js'],
  {
    lib: {
      plugins: [{
        name: 'dsh-client-build-metadata',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-metadata.json',
            source: `${JSON.stringify(clientBuildMetadata(process.env))}\n`,
          })
        },
      }],
    },
  },
)
