// Records the full SchemaForge tour as video with Korean captions and a visible pointer, and prints each scene's time.
//   A: everything without login (home, demos, PCB, 3D turn, assembly, gerbers, BOM, Code, operating checks)
//   B: logged in (describe -> questions -> plan -> generate, AI board polish, AI editor, versions, Code run,
//      history, favorites). The owner logs in by hand in a window that is NOT recorded; the script only carries
//      that login over to the recorded window and never types a password.
// Part B keeps the login and waits for videos/tour_control.txt: "take" records part B again, "logout" records
// the closing logout clip, "quit" ends. Waits are played faster in the edit (badge "▶▶ n배속").
// Usage: node scripts/record_tour.mjs A|B [BASE]   (default https://schemaforge.kro.kr)
import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { GPU_ARGS, VIEW, overlay, recorder, edit, duration } from './tour/lib.mjs'

const PART = (process.argv[2] || 'A').toUpperCase()
const BASE = (process.argv[3] || 'https://schemaforge.kro.kr').replace(/\/$/, '')
const OUT = join(process.cwd(), 'videos')
const HERE = dirname(fileURLToPath(import.meta.url))
const CONTROL = join(OUT, 'tour_control.txt')
const STATUS = join(OUT, `tour_status_${PART}.json`)
mkdirSync(join(OUT, 'downloads'), { recursive: true })
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const status = s => writeFileSync(STATUS, JSON.stringify({ ...s, at: new Date().toISOString() }, null, 1))

// Windows must not idle-sleep while the tour runs: a sleep froze a take for hours, and that pause went into its video.
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) holds only while this helper
// lives, and the helper ends with this process; no power setting is changed.
if (process.platform === 'win32') {
  const hold = `Add-Type -Namespace SF -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';`
    // 2147483651 = 0x80000003, written in decimal: PowerShell 5.1 reads 0x80000003 as a negative Int32 and the call fails
    + ` [SF.Power]::SetThreadExecutionState([uint32]2147483651) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep 5 }`
  spawn('powershell', ['-NoProfile', '-Command', hold], { stdio: 'ignore', windowsHide: true }).unref()
}

// wake a sleeping free instance before the camera matters; without KiCad there is no DRC, 3D or gerber to show
const wake = () => fetch(`${BASE}/health`, { signal: AbortSignal.timeout(180000) }).then(r => r.json())
const health = await wake()
if (!health.kicad) { console.log('server has no KiCad: ' + JSON.stringify(health)); process.exit(1) }

const browser = await chromium.launch({ headless: PART !== 'B', args: GPU_ARGS })

/** one recorded take: a fresh context, the shots of `file`, then the edited mp4 */
async function take(name, file, storageState, opts = {}) {
  await wake()   // the free instance sleeps after 15 min without requests
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: OUT, size: VIEW }, storageState })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {})
  await context.addInitScript(overlay)
  const page = await context.newPage()
  page.on('dialog', d => (/복사 완료|배치 체크/.test(d.message()) ? d.accept() : d.dismiss()).catch(() => {}))
  page.on('download', d => d.saveAs(join(OUT, 'downloads', d.suggestedFilename())).catch(() => {}))
  const rec = recorder(page, BASE, OUT)
  // the shots are read fresh on every take, so a fixed scene runs without logging in again
  const { run } = await import(pathToFileURL(join(HERE, 'tour', file)).href + '?t=' + Date.now())
  try { await run(rec, opts) } catch (e) { rec.failed.push(['-', 'tour', String(e?.message || e).split('\n')[0]]) }
  const state = await context.storageState().catch(() => storageState)
  const video = page.video()
  await context.close()
  const webm = join(OUT, `${name}_${stamp()}.webm`)
  renameSync(await video.path(), webm)
  const mp4 = webm.replace(/\.webm$/, '.mp4')
  edit(webm, mp4, rec.trimStart, rec.speedups)
  const result = { video: mp4, seconds: Math.round(duration(mp4) * 10) / 10, times: rec.times, failed: rec.failed }
  console.log(`\n${name}: ${mp4} (${result.seconds} s)`)
  for (const [id, label, s, ok] of rec.times) console.log(`  ${id} ${label}: ${s.toFixed(1)} s ${ok}`)
  for (const [id, label, msg] of rec.failed) console.log(`  FAIL ${id} ${label}: ${msg}`)
  return { result, state }
}

try {
  if (PART === 'A') {
    const { result } = await take('tour_A', 'shots_a.mjs')
    status({ phase: 'done', part: 'A', ...result })
  } else {
    // the login window is not recorded: the owner logs in there by hand
    const login = await browser.newContext({ viewport: VIEW })
    await login.addInitScript(overlay)
    const lp = await login.newPage()
    await lp.goto(BASE, { waitUntil: 'networkidle' })
    await lp.evaluate(() => window.__caption('이 창은 녹화되지 않습니다. 오른쪽 위 로그인을 눌러 로그인해 주세요', 'top'))
    status({ phase: 'waiting-login' })
    console.log('waiting for the owner to log in (up to 30 min)')
    await lp.getByRole('button', { name: '로그아웃' }).waitFor({ timeout: 30 * 60000 })
    await lp.waitForTimeout(2500)
    if (await lp.getByTestId('cannot-generate').count()) throw new Error('this account cannot generate (not in ALLOWED_EMAILS)')
    // one small model call before the camera: with no OpenAI credit every AI scene fails (429 insufficient_quota).
    // /plan answers the model's error as it is (/clarify swallows it); "check" in the control file asks again
    const probe = () => lp.evaluate(async () => {
      const r = await fetch('/plan', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('sf_token')}` },
        body: JSON.stringify({ description: 'LED 하나를 켜는 회로' }) })
      return { status: r.status, body: (await r.text()).slice(0, 200) }
    })
    rmSync(CONTROL, { force: true })
    for (let p = await probe(); p.status !== 200; p = await probe()) {
      console.log(`model check failed: ${p.status} ${p.body}`)
      status({ phase: 'model-unavailable', probe: p })
      let c = ''
      while (c !== 'check') {
        await new Promise(r => setTimeout(r, 2000))
        if (existsSync(CONTROL)) { c = readFileSync(CONTROL, 'utf8').trim(); rmSync(CONTROL, { force: true }) }
        if (c === 'quit') throw new Error('stopped while the model was unavailable')
      }
    }
    console.log('model check ok')
    let state = await login.storageState()
    await login.close()
    let n = 0
    let cmd = 'take'
    while (cmd !== 'quit') {
      if (cmd === 'take' || cmd === 'logout') {
        n++
        status({ phase: 'recording', take: n, cmd })
        const { result, state: next } = cmd === 'take'
          ? await take(`tour_B${n}`, 'shots_b.mjs', state)
          : await take('tour_logout', 'shots_logout.mjs', state)
        state = next
        status({ phase: 'idle', take: n, cmd, ...result })
      }
      // wait for the next command
      cmd = ''
      while (!cmd) {
        await new Promise(r => setTimeout(r, 2000))
        if (existsSync(CONTROL)) { cmd = readFileSync(CONTROL, 'utf8').trim(); rmSync(CONTROL, { force: true }) }
      }
    }
    status({ phase: 'done', part: 'B', takes: n })
  }
} catch (e) {
  console.log('tour stopped: ' + (e?.message || e))
  status({ phase: 'error', error: String(e?.message || e) })
} finally {
  await browser.close()
}
