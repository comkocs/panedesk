import { describe, expect, it } from 'vitest'
import type { SeatDefinition } from '@panedesk/dsh-seat'
import { parseDefinition, resolveSeat } from '../src/schema.ts'
import { isNativePath, pathKey, pathStyle } from '../src/paths.ts'
import { catalogs, definition } from './fixtures.ts'
import { digest } from '../src/store.ts'

const pathFields = (value: string): Partial<SeatDefinition>[] => [
  { directories: [{ path: value, startup: true }] }, { memoryDirectories: [value] },
  { openingInstructionFiles: [value] }, { subscriptions: [value] },
  { checkpointFiles: [{ path: value, section: 'Rules', maxBytes: 100, required: true }] },
  { opening: { kind: 'file', path: value } }, { wakeTemplate: { kind: 'file', path: value } },
  { source: { sourcePath: value, sourceFileHash: digest('source'), rowHash: digest('row'), mappingHash: digest('mapping'),
    columnHashes: {}, baseline: {}, authority: 'import-source' } },
]

describe('catalog path styles', () => {
  it.each(['/srv/seat-a', 'C:\\work\\seat-a', 'C:/work/seat-a', '\\\\host-a\\share-a\\seat-a', '//host-a/share-a/seat-a'])(
    'accepts absolute catalog paths independently of the importing host: %s', (value) => {
      for (const fields of pathFields(value)) expect(parseDefinition(definition('/srv/seat-a', fields))).not.toHaveProperty('status')
    })

  it.each(['work/seat-a', 'C:work', '\\work', ''])('rejects relative catalog paths without changing diagnostics: %s', (value) => {
    for (const fields of pathFields(value)) {
      const result = parseDefinition(definition('/srv/seat-a', fields))
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid-definition' } })
      if ('status' in result && value !== '') expect(result.error.message).toMatch(/Expected an absolute path|Text references require absolute paths\./)
    }
  })

  it('deduplicates Windows separators and case without conflating POSIX paths', () => {
    const parse = (paths: string[]) => parseDefinition(definition(paths[0]!, {
      directories: paths.map((path, index) => ({ path, startup: index === 0 })),
    }))
    expect(parse(['C:\\a', 'c:/a'])).toMatchObject({ status: 'rejected' })
    expect(parse(['\\\\HOST-A\\Share-A\\a', '//host-a/share-a/a'])).toMatchObject({ status: 'rejected' })
    expect(parse(['/a/../a', '/a'])).toMatchObject({ status: 'rejected' })
    expect(parse(['/a', 'C:\\a'])).not.toHaveProperty('status')
    expect(parse(['/A', '/a'])).not.toHaveProperty('status')
    expect(pathKey('C:\\a')).not.toBe(pathKey('/a'))
  })

  it('uses explicit Windows platform stubs without accepting drive-relative paths', () => {
    expect(isNativePath('C:/work/seat-a', 'win32')).toBe(true)
    expect(isNativePath('\\\\host-a\\share-a', 'win32')).toBe(true)
    expect(isNativePath('/srv/seat-a', 'win32')).toBe(false)
    expect(isNativePath('C:/work/seat-a', 'posix')).toBe(false)
    expect(pathStyle('C:work')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('checks node ownership before native execution paths and excludes source metadata', async () => {
    const foreign = definition('C:\\work\\seat-a', { node: 'node-b' })
    expect(await resolveSeat(foreign, catalogs('/srv/seat-a'))).toMatchObject({ error: { code: 'cross-node-unsupported' } })
    for (const fields of pathFields('C:\\work\\seat-a').slice(0, -1)) {
      expect(await resolveSeat(definition('/srv/seat-a', fields), catalogs('/srv/seat-a'))).toMatchObject({
        status: 'rejected', error: { code: 'invalid-definition', effectState: 'none',
          alternative: 'Edit the definition to use absolute paths native to its owning node.' },
      })
    }
    expect(await resolveSeat(definition('/srv/seat-a', pathFields('C:\\work\\seat-a').at(-1)), catalogs('/srv/seat-a'))).not.toHaveProperty('status')
    expect(await resolveSeat(definition('/srv/seat-a'), catalogs('/srv/seat-a'))).not.toHaveProperty('status')
  })
})
