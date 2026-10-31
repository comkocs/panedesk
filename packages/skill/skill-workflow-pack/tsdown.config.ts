/** Copy the single maintained workflow pack into the published skill payload. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  copy: [{ from: '../../../templates/workflow-pack', to: 'lib' }],
})
