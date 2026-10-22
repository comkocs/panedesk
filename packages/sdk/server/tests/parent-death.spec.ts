import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readProcessIdentity, sameProcessIdentity } from '../../../subprocess/subprocess/src/process-identity.ts'

const childFile = fileURLToPath(new URL('./parent-death-child.ts', import.meta.url))

describe('pre-handshake parent death', () => {
  it.skipIf(process.platform !== 'linux')('quiesces on lost stdio after the owning parent is SIGKILLed', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['--import', 'tsx/esm', process.argv[1]], { stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `
    const parent = spawn(process.execPath, ['-e', script, childFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let childPid: number | undefined
    let identity: ReturnType<typeof readProcessIdentity> | undefined
    try {
      childPid = await new Promise<number>((resolve, reject) => {
        let output = ''
        let diagnostics = ''
        const timer = setTimeout(() => { reject(new Error(`child readiness timeout: ${diagnostics}`)) }, 5000)
        parent.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
        parent.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (!output.includes('\n')) return
          clearTimeout(timer)
          resolve(Number(output.trim()))
        })
        parent.once('error', reject)
      })
      expect(Number.isSafeInteger(childPid)).toBe(true)
      identity = readProcessIdentity(childPid)
      const exited = new Promise<void>((resolve) => { parent.once('exit', () => { resolve() }) })
      parent.kill('SIGKILL')
      await exited
      await expect.poll(() => {
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8')
          return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')
        } catch { return true }
      }, { timeout: 5000 }).toBe(true)
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
      if (identity !== undefined && sameProcessIdentity(identity)) {
        try { process.kill(identity.pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  }, 15000)
})
