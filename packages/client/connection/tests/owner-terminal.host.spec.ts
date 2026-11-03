/** Real controlling-terminal decisions without launching a Host or contacting a service. */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform === 'win32')('owner controlling terminal', () => {
  it.each(['confirm', 'cancel', 'timeout'] as const)('settles a real terminal %s decision', (decision) => {
    const module = pathToFileURL(new URL('../src/owner-confirmation.ts', import.meta.url).pathname).href
    const code = `import { confirmBrowserLogin } from ${JSON.stringify(module)};
const result = await confirmBrowserLogin({ userAgent: 'synthetic\\u001b[31m browser', requestedAt: 0, source: 'synthetic source' }, 150);
console.log('DECISION=' + result);`
    const script = `import os, pty, select, signal, sys, time
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], '--import', 'tsx/esm', '--input-type=module', '-e', sys.argv[2]])
output = b''
sent = False
deadline = time.monotonic() + 5
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if b'[y/N]' in output and not sent:
            sent = True
            if sys.argv[3] != 'timeout':
                os.write(master, b'y\\n' if sys.argv[3] == 'confirm' else b'n\\n')
        if b'DECISION=' in output:
            break
finally:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
    os.close(master)
sys.stdout.buffer.write(output)
`
    const result = spawnSync('python3', ['-I', '-c', script, process.execPath, code, decision], {
      encoding: 'utf8', timeout: 8_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('synthetic source')
    expect(result.stdout).toContain('1970-01-01T00:00:00.000Z')
    expect(result.stdout).not.toContain('\u001b[31m')
    expect(result.stdout).toContain(`DECISION=${decision === 'confirm'}`)
  })
})
