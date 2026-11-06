import { expect, it } from 'vitest'
import { captureReplacementMetadata, type ReplacementMetadataApi } from '../src/win32-replacement-metadata.ts'

function fixture(old: number, stage: number) {
  const written: number[] = []
  const api: ReplacementMetadataApi = {
    basic(token) { const result = Buffer.alloc(40); result.writeUInt32LE(token === 1 ? old : stage, 32); return result },
    resourceAttributes: () => false, enterpriseProtected: () => false, compression: () => 0, streams: () => [],
    setCompression() {}, writeStream() {}, setBasic(_token, value) { written.push(value.readUInt32LE(32)) },
  }
  return { run: () => { captureReplacementMetadata(api, 1)(2) }, written }
}

it.each([[2, 32, 34], [4, 32, 36], [32, 128, 32], [32, 32, 32]])('merges observed attributes %i / %i to %i', (old, stage, result) => {
  const f = fixture(old, stage); f.run(); expect(f.written).toEqual([result])
})
it.each([[6, 32], [34, 34], [128, 128], [32, 2], [0, 32]])('refuses unobserved attributes %i / %i before metadata writes', (old, stage) => {
  const f = fixture(old, stage)
  expect(f.run).toThrow(/Unverified file attribute combination.*未核实的文件属性组合/)
  expect(f.written).toEqual([])
})
