/** POSIX session separation prevents sandbox children from opening the owner's controlling terminal. */
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('separates a child session from an owned terminal with an attached control', () => {
  const script = `import os, pty, subprocess, sys
pid, master = pty.fork()
if pid == 0:
    probe = 'import os; fd=os.open("/dev/tty", os.O_RDWR); os.close(fd)'
    attached = subprocess.run([sys.executable, '-I', '-c', probe], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    isolated = subprocess.run([sys.executable, '-I', '-c', probe], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os._exit(0 if attached.returncode == 0 and isolated.returncode != 0 else 1)
_, status = os.waitpid(pid, 0)
os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
`
  const result = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
