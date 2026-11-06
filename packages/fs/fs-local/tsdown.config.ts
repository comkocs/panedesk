import { existsSync } from 'node:fs'
import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'lib',
  format: ['esm'],
  fixedExtension: false,
  clean: false,
  entry: ['lib/types/index.js', 'lib/types/win32-handle-worker.js',
    ...existsSync(new URL('./src/win32-write-backend.ts', import.meta.url)) ? ['lib/types/win32-write-backend.js'] : []],
})
