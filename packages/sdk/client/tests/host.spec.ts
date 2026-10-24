import { describe, expect, it, vi } from 'vitest'
import { HostClient, decodeNamespaces } from '../src/host.ts'
import { SdkProtocolError } from '../src/client.ts'

describe('host query client', () => {
  it('accepts legacy handshakes and validates namespace versions', () => {
    expect(decodeNamespaces(undefined)).toBeUndefined()
    expect(decodeNamespaces([{ namespace: 'example', version: '1' }])).toEqual([{ namespace: 'example', version: '1' }])
    for (const value of [true, [{ namespace: '', version: '1' }], [{ namespace: 'example', version: '1' }, { namespace: 'example', version: '2' }]]) {
      expect(() => decodeNamespaces(value)).toThrow(SdkProtocolError)
    }
  })
  it('preserves stale node evidence and empty advancing authorization pages', async () => {
    const node = { nodeId: 'node-a', nodeName: 'node-a', reachable: false, linkState: 'stale',
      observedAt: '2026-01-01T00:00:00Z', status: null, capabilities: [], safeReason: 'unavailable' }
    const cursor = { nodeId: 'node-a' as never, sequence: 4, effectIndex: 1 }
    const page = { facts: [], complete: false, watermark: 9, nextCursor: cursor, legacyAttribution: 'legacy-unknown' }
    const request = vi.fn().mockResolvedValueOnce([node]).mockResolvedValueOnce(null).mockResolvedValueOnce(page)
    const host = new HostClient(request)
    expect(await host.listNodes()).toEqual([node])
    expect(await host.nodeStatus('node-b')).toBeNull()
    expect(await host.queryAuthorizations({ limit: 3, cursor })).toEqual(page)
    expect(request).toHaveBeenLastCalledWith('authorizations/query', { limit: 3, cursor })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('rejects corrupt nested evidence and never retries', async () => {
    const request = vi.fn().mockResolvedValue({ facts: [], complete: false, watermark: 2,
      nextCursor: { nodeId: 'node-a', sequence: -1, effectIndex: 0 }, legacyAttribution: 'none' })
    const host = new HostClient(request)
    await expect(host.queryAuthorizations({ limit: 1 })).rejects.toThrow(SdkProtocolError)
    request.mockResolvedValue({ status: 'rejected' })
    await expect(host.queryAuthorizations({ limit: 1 })).rejects.toThrow(SdkProtocolError)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
