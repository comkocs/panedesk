/** A loopback-only refusal page remains available when protected inputs prevent Web boot. */
import { createServer } from 'node:http'

const en = {
  stalled: 'Protected host input review stalled. Check storage responsiveness and restart; workspace write access remains denied.',
  refused: 'Protected host input review was refused. Restore the protected owner inputs and restart; workspace write access remains denied.',
}
const zh = {
  stalled: '受保护宿主输入复核卡住。请检查存储响应后重启；工作区写入仍被拒绝。',
  refused: '受保护宿主输入复核被拒绝。请恢复受保护的所有者输入后重启；工作区写入仍被拒绝。',
} satisfies Record<keyof typeof en, string>

/**
 * Keep a rejected Web launch visibly refused, without mounting plugins or exposing diagnostics and APIs.
 * @param error - Initial owner-record review failure; raw details remain on stderr only.
 * @param args - Web arguments; an explicit port is reused, otherwise the normal Web port is used.
 * @returns After a termination signal closes the refusal listener and all connections.
 */
export async function showInputReviewWebRefusal(error: unknown, args: readonly string[]): Promise<void> {
  const reason = error instanceof Error && error.message.includes('review stalled') ? 'stalled' : 'refused'
  let port = 3080
  const index = args.indexOf('--port')
  const value = index < 0 ? args.find(arg => arg.startsWith('--port='))?.slice('--port='.length) : args[index + 1]
  if (value !== undefined) {
    port = Number(value)
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Web refusal port')
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Panedesk</title></head>'
    + '<body><main role="alert" data-state="refused"><p lang="en">' + en[reason]
    + '</p><p lang="zh-CN">' + zh[reason] + '</p></main></body></html>'
  const server = createServer((request, response) => {
    const authority = server.address()
    const expected = typeof authority === 'object' && authority !== null ? `127.0.0.1:${String(authority.port)}` : ''
    if (request.headers.host !== expected || request.headers.origin !== undefined) {
      response.writeHead(403).end()
      return
    }
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(503, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
    }).end(html)
  })
  const stopped = Promise.withResolvers<void>()
  const close = (): void => {
    server.close((closeError) => { if (closeError) stopped.reject(closeError); else stopped.resolve() })
    server.closeAllConnections()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('Web refusal listener did not bind')
    process.exitCode = 1
    process.once('SIGTERM', close)
    process.once('SIGINT', close)
    process.stderr.write(`${en[reason]} / ${zh[reason]}\n`)
    process.stderr.write(`panedesk web: http://127.0.0.1:${String(address.port)}/\n`)
    await stopped.promise
  } finally {
    process.off('SIGTERM', close)
    process.off('SIGINT', close)
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  }
}
