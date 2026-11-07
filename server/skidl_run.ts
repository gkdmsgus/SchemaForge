// Runs skidl code (model- or user-written) in a throwaway folder and copies the netlist out.
// Kept out of index.ts so the checks can run exactly the code the server runs.
import { spawn } from 'child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

/** Variable names a child process never sees: API keys, Supabase settings, secrets, tokens, passwords. */
export const SECRET_ENV = /_KEY$|^SUPABASE_|SECRET|TOKEN|PASSWORD/i

/**
 * process.env without the secrets. A deny-list rather than an allow-list: skidl on Windows needs
 * APPDATA, USERPROFILE, PATH and SYSTEMROOT, and Python reads more than that.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k) && k !== 'FORCE_COLOR'))
  // plain tracebacks: Python 3.13+ colours them when FORCE_COLOR is set (npm and tsx set it), and the
  // Code tab reads the line number out of them
  return { ...kept, PYTHON_COLORS: '0', NO_COLOR: '1' }
}

/** How much of Python's stderr is kept, from its end (characters). */
export const STDERR_KEPT = 64_000

/**
 * Run skidl code and copy the netlist it writes into outDir as <random>.net; resolves with that path.
 * The code is written exactly as given, so traceback line numbers match what the user sees.
 * Rejects with the end of Python's stderr. The temp folder is removed after every outcome, timeout included.
 */
export function runSkidl(code: string, outDir: string, timeout = 90000): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpDir = join(tmpdir(), `sf_skidl_${randomUUID()}`)
    mkdirSync(tmpDir)
    const cleanup = () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }
    const codePath = join(tmpDir, 'circuit.py')
    writeFileSync(codePath, code, 'utf8')

    // its own process group on POSIX, so what the code starts can be killed with it: python alone was, and the children
    // it left held the container's process slots (--pids-limit) for good (review of 2026-11-03)
    const posix = process.platform !== 'win32'
    // stdout goes nowhere: nobody read it, so a full pipe stalled code that works until the time limit (review of 2026-11-06)
    const proc = spawn('python', [codePath], { cwd: tmpDir, env: childEnv(), detached: posix, stdio: ['ignore', 'ignore', 'pipe'] })
    const killTree = () => {
      if (proc.pid === undefined) return
      if (posix) { try { process.kill(-proc.pid, 'SIGKILL') } catch { /* nothing left */ } }
      else spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { /* best effort */ })
    }
    let stderr = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    // only the end: the traceback's last lines are what the Code tab reads, and code writing here forever took the whole
    // server down (RangeError: Invalid string length, in this handler, so uncaught)
    proc.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-STDERR_KEPT) })

    // A killed process still fires 'close'; the folder is removed there, once Python has let go of it.
    const timer = setTimeout(() => { killTree(); settle(() => reject(new Error('skidl execution timed out'))) }, timeout)
    proc.on('error', (e: Error) => { settle(() => reject(e)); cleanup() })
    // whatever the code started and left running goes when python does (POSIX: the group outlives python; Windows has no
    // group). On 'exit', not 'close': 'close' waits for every holder of the stderr pipe, so a child that kept it held a
    // finished run until it ended or the time limit came (review of 2026-11-07)
    proc.on('exit', () => { if (posix) killTree() })
    proc.on('close', (exit: number | null) => {
      if (posix) killTree()
      settle(() => {
        if (exit !== 0) return reject(new Error(stderr))
        try {
          const netFiles = readdirSync(tmpDir).filter(f => f.endsWith('.net'))
          if (!netFiles.length) return reject(new Error('No netlist file was generated.'))
          const outputPath = join(outDir, `${randomUUID().replace(/-/g, '')}.net`)
          copyFileSync(join(tmpDir, netFiles[0]), outputPath)
          resolve(outputPath)
        } catch (e) {
          reject(e as Error)
        }
      })
      cleanup()
    })
  })
}
