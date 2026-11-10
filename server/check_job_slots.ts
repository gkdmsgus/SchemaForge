// Checks J1-J7 and S1-S5: how many heavy jobs run at once and who waits (job_slots.ts). Nothing capped them: 16 demo
// boards at once took about 2 GB on the development PC, the Jetson container's whole memory cap (review of 2026-11-08).
// J1-J7 the rules, with no server. S1-S6 a real server in production mode with SF_JOB_SLOTS=3, read through /health:
// at most 3 jobs run, the rest wait in line, a full line is told at once in Korean with Retry-After, a board request
// writes its netlist only once it has its slot, and one replaced while it waits leaves the line. S6 one visitor's
// share: 2 running, 4 waiting, by the address the proxy names in X-Forwarded-For, whatever a visitor writes before it.
// No model; S needs python, skidl and KiCad (a demo board and its 3D export).
// Usage (from server/): npx tsx check_job_slots.ts   → exit 0 only if all pass
import { spawn } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { Slots, clientKey, refused, type Answer, type Slot } from './job_slots'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** an answer as it stands after the pending callbacks ran: a slot, a refusal, or still waiting */
async function state(p: Promise<Answer>) {
  let got: Answer | undefined
  void p.then(a => { got = a })
  await sleep(0)
  return got === undefined ? 'waiting' : refused(got) ? got.busy : 'slot'
}
const slot = async (p: Promise<Answer>) => (await p) as Slot

async function rules() {
  // J1. two run at once, two wait, the fifth is told at once
  const s = new Slots(2, 2, 500)
  const a = [s.acquire('x'), s.acquire('x'), s.acquire('x'), s.acquire('x'), s.acquire('x')]
  const states = await Promise.all(a.map(state))
  check('J1 two run, two wait, the next is refused at once', states.join() === 'slot,slot,waiting,waiting,full'
    && JSON.stringify(s.counts()) === '{"running":2,"waiting":2,"slots":2}', `${states.join()} ${JSON.stringify(s.counts())}`)

  // J2. a slot given back goes to the line in order; giving it back twice frees one slot, not two
  const first = await slot(a[0])
  first.release()
  first.release()
  const order = [await state(a[2]), await state(a[3])]
  ;(await slot(a[1])).release()
  const after = [await state(a[3]), JSON.stringify(s.counts())]
  check('J2 the line goes in order; a slot given back twice is one slot', order.join() === 'slot,waiting'
    && after.join() === 'slot,{"running":2,"waiting":0,"slots":2}', `${order.join()} then ${after.join()}`)
  ;(await slot(a[2])).release()
  ;(await slot(a[3])).release()

  // J3. a waiter past the longest wait is refused, and leaves the line
  const t = new Slots(1, 4, 500)
  const held = await slot(t.acquire('x'))
  const t0 = Date.now()
  // a line that never gives up would hold this check open: 3 s is the most it gets
  const late = await Promise.race([t.acquire('x'), sleep(3000).then(() => ({ busy: 'still waiting after 3 s' }) as unknown as Answer)])
  const waited = Date.now() - t0
  check('J3 past the longest wait: refused, out of the line', refused(late) && late.busy === 'waited' && waited >= 450 && waited < 2000
    && t.counts().waiting === 0, `${JSON.stringify(late)} after ${waited} ms, ${t.counts().waiting} waiting`)
  if (!refused(late)) late.release()

  // J4. a request stopped while it waits leaves the line at once and never gets a slot: the one behind it does
  const gone = new AbortController()
  const w1 = t.acquire('x', gone.signal), w2 = t.acquire('x')
  gone.abort()
  const left = [await state(w1), t.counts().waiting]
  held.release()
  const next = [await state(w2), t.counts().running]
  const stopped = await state(t.acquire('x', AbortSignal.abort()))
  check('J4 a stopped request leaves the line, the next one gets the slot', left.join() === 'gone,1' && next.join() === 'slot,1'
    && stopped === 'gone', `stopped: ${left.join()}; then ${next.join()}; already stopped: ${stopped}`)
  ;(await slot(w2)).release()

  // J5. one key runs its share and waits its share; another key goes in at once while the first one waits
  // (the waiters that stay are stopped at the end, so their 60 s timers do not hold the check open)
  const end = new AbortController()
  const u = new Slots(4, 16, 60000, { running: 2, waiting: 4 })
  const mine = Array.from({ length: 7 }, () => u.acquire('A', end.signal))
  const mineStates = await Promise.all(mine.map(state))
  const other = await state(u.acquire('B'))
  check('J5 a key: 2 run, 4 wait, the 7th is refused; another key goes in at once',
    mineStates.join() === 'slot,slot,waiting,waiting,waiting,waiting,mine' && other === 'slot' && u.counts().running === 3,
    `A ${mineStates.join()}, B ${other}, ${JSON.stringify(u.counts())}`)

  // J6. a key at its running share lets the next key in line go first
  const v = new Slots(2, 16, 60000, { running: 1, waiting: 4 })
  const vA1 = v.acquire('A', end.signal), vA2 = v.acquire('A', end.signal), vB1 = v.acquire('B', end.signal), vC1 = v.acquire('C', end.signal)
  const before = await Promise.all([vA1, vA2, vB1, vC1].map(state))
  ;(await slot(vB1)).release()
  const passed = [await state(vA2), await state(vC1)]
  check('J6 a key at its share lets the next key go first', before.join() === 'slot,waiting,slot,waiting' && passed.join() === 'waiting,slot',
    `${before.join()}; B gives back: A2 ${passed[0]}, C1 ${passed[1]}`)
  end.abort()

  // J7. the key: an IPv4 address as itself, plain or IPv4-mapped; an IPv6 one by its first 64 bits
  const keys = {
    mapped: clientKey('::ffff:203.0.113.7'), plain: clientKey('203.0.113.7'),
    v6a: clientKey('2001:db8:1:2:3:4:5:6'), v6b: clientKey('2001:DB8:1:2::9'), v6c: clientKey('2001:db8:1:3::1'),
    loop6: clientKey('::1'), none: clientKey(undefined),
  }
  check('J7 the key of an address', keys.mapped === '203.0.113.7' && keys.plain === '203.0.113.7' && keys.v6a === '2001:db8:1:2::/64'
    && keys.v6b === keys.v6a && keys.v6c !== keys.v6a && keys.loop6 === '0:0:0:0::/64' && keys.none === 'unknown', JSON.stringify(keys))
}

/** a port the system says is free (a fixed one can sit in a range Windows reserves) */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number }
    s.close(() => resolve(port))
  })
})

type Jobs = { running: number; waiting: number; slots: number }
type Got = { status: number; retry: string | null; body: Buffer }
const SLOTS = 3
const idleJobs = JSON.stringify({ running: 0, waiting: 0, slots: SLOTS })

async function server() {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  // node --import tsx: one process to stop (the tsx command leaves its child running on Windows). Every setting named,
  // so no login, model or sweep comes from the environment
  const proc = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), SF_JOB_SLOTS: String(SLOTS), SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
           ALLOWED_EMAILS: '', OPENAI_API_KEY: '', MOUSER_API_KEY: '', SF_OUTPUTS_SWEEP: '', SF_AI_STUB: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  /** a request from a visitor at this address, as the reverse proxy in front of the server names it */
  const from = (ip: string) => ({ 'X-Forwarded-For': ip })
  const read = async (r: Response): Promise<Got> => ({ status: r.status, retry: r.headers.get('retry-after'), body: Buffer.from(await r.arrayBuffer()) })
  const post = (path: string, body: unknown, ip = '192.0.2.1') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...from(ip) }, body: JSON.stringify(body) })
  const jobs = async () => ((await (await fetch(base + '/health')).json()) as { jobs?: Jobs }).jobs
  /** /health every 50 ms until stopped: the most running and waiting seen */
  const watch = () => {
    const seen = { running: 0, waiting: 0, reads: 0, missing: 0 }
    let on = true
    const done = (async () => {
      while (on) {
        const j = await jobs().catch(() => undefined)
        seen.reads++
        if (!j) seen.missing++
        else { seen.running = Math.max(seen.running, j.running); seen.waiting = Math.max(seen.waiting, j.waiting) }
        await sleep(50)
      }
    })()
    return { seen, stop: async () => { on = false; await done } }
  }
  /** the jobs once nothing runs or waits (10 s at most) */
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const j = await jobs()
      if (j && !j.running && !j.waiting) return JSON.stringify(j)
      await sleep(100)
    }
    return JSON.stringify(await jobs())
  }
  const made = (prefix: string) => readdirSync('outputs').filter(f => f.startsWith(prefix))
  const model = (pcb: string, ip: string) => fetch(`${base}/board_model?pcb=${encodeURIComponent(pcb)}`, { headers: from(ip) }).then(read)
  const said = (body: Buffer) => { try { return JSON.parse(body.toString()) as { error?: string; code?: string } } catch { return {} } }
  /** a 503 as the screen reads it: busy, a Korean sentence, and when to ask again */
  const busy = (a: Got) => a.status === 503 && a.retry === '15' && said(a.body).code === 'busy' && /[가-힣]/.test(said(a.body).error ?? '')
  const stems: string[] = []
  try {
    let up = false
    for (const t0 = Date.now(); !up && Date.now() - t0 < 60000 && proc.exitCode === null; await sleep(300)) {
      up = await fetch(base + '/health').then(r => r.ok, () => false)
    }
    if (!up) return check('S server', false, `did not start in 60 s on port ${port}: ${log.trim().slice(-300)}`)

    // S1. /health says the slots and what runs and waits
    const idle = await jobs()
    check('S1 /health: jobs running, waiting and the slots', JSON.stringify(idle) === idleJobs, JSON.stringify(idle))

    // a board to export: the LED demo's circuit, as a visitor builds it
    const demo = await (await fetch(base + '/demo_result/led')).json() as { filename: string; graph: unknown }
    stems.push(demo.filename.replace(/\.net$/, ''))
    const text = await (await post('/generate_pcb_stream', { graph: demo.graph, baseName: 'slotcheck' })).text()
    const doneLine = /event: done\ndata: (.+)/.exec(text)?.[1]
    const pcb = doneLine ? (JSON.parse(doneLine) as { pcbFilename: string }).pcbFilename : undefined
    if (!pcb) return check('S board', false, `no board: ${text.slice(-200)}`)

    // S2. six 3D exports from six visitors: three run, three wait, all six come back whole
    // S3. a board request behind them waits in line, and its netlist is not written while it waits
    {
      const w = watch()
      const six = Array.from({ length: 6 }, (_, i) => model(pcb, `198.51.100.${i + 1}`))
      await sleep(300)
      const sent = Date.now()
      let answered = 0
      const board = post('/generate_pcb_stream', { graph: demo.graph, baseName: 'slotwait' }, '198.51.100.7')
        .then(async r => { answered = Date.now(); return r.text() })
      // the server writes the netlist once it has its slot and sends the stream's headers right after; a busy PC can show
      // the file between the two (1 look of 18-46 on 2026-11-10). A netlist written while it waited is there the whole
      // wait (500 ms at least) before the answer: early is a file first seen more than 250 ms before it
      let looks = 0, firstSeen = 0
      while (!answered && Date.now() - sent < 30000) {
        looks++
        if (!firstSeen && made('slotwait_').length) firstSeen = Date.now()
        await sleep(50)
      }
      const answers = await Promise.all(six)
      const boardText = await board
      await w.stop()
      const after = await settle()
      const whole = answers.filter(a => a.status === 200 && a.body.subarray(0, 4).toString() === 'glTF').length
      check('S2 six 3D exports from six visitors: 3 run, the rest wait, all six whole', w.seen.missing === 0 && w.seen.running === SLOTS
        && w.seen.waiting >= 1 && whole === 6 && after === idleJobs,
        `most running ${w.seen.running}, waiting ${w.seen.waiting} (${w.seen.reads} reads, ${w.seen.missing} without jobs); ${whole}/6 whole; after ${after}`)
      const waited = answered - sent
      const ahead = firstSeen ? answered - firstSeen : 0
      check('S3 a board request waits in line and writes its netlist only once it has its slot', waited >= 500 && ahead <= 250
        && /event: done/.test(boardText), `waited ${waited} ms; its netlist ${firstSeen ? `first seen ${ahead} ms before the answer` : 'not seen'} in ${looks} looks; ${/event: done/.test(boardText) ? 'done' : boardText.slice(-120)}`)
    }

    // S4. a full line, 3 running and 16 waiting: the next request is told at once, in Korean, with Retry-After, and a
    //     board request refused so writes no netlist
    {
      const running = Array.from({ length: 3 }, (_, i) => model(pcb, `203.0.113.${i + 1}`))
      await sleep(200)
      const waiting = Array.from({ length: 16 }, (_, i) => post('/erc_graph', { graph: demo.graph }, `203.0.113.${i + 10}`).then(read))
      await sleep(300)
      const full = JSON.stringify(await jobs())
      const t0 = Date.now()
      const answer = await read(await post('/generate_pcb_stream', { graph: demo.graph, baseName: 'slotfull' }, '203.0.113.99'))
      const refusedIn = Date.now() - t0
      const left = made('slotfull_')
      const rest = await Promise.all([...running, ...waiting])
      const after = await settle()
      check('S4 a full line: refused at once in Korean with Retry-After, no netlist written; the line all done after',
        full === JSON.stringify({ running: SLOTS, waiting: 16, slots: SLOTS }) && busy(answer) && refusedIn < 1000 && !left.length
        && rest.every(a => a.status === 200) && after === idleJobs,
        `line ${full}; refused in ${refusedIn} ms: ${answer.status} retry ${answer.retry} ${answer.body.toString().slice(0, 120)}; files ${left.join(',') || 'none'}; the rest ${rest.map(a => a.status).join(',')}`)
    }

    // S5. a request replaced while it waits (a retry from another tab) leaves the line and says why; the retry gets the board
    {
      const ahead = Array.from({ length: 6 }, (_, i) => model(pcb, `198.51.100.${i + 20}`))
      await sleep(300)
      const body = { filename: demo.filename, style: 'smd' }
      const first = post('/generate_pcb_stream', body, '198.51.100.30').then(async r => ({ status: r.status, at: Date.now(), text: await r.text() }))
      let inLine = false
      for (let i = 0; i < 40 && !inLine; i++) {
        inLine = (await jobs())?.waiting === 4
        if (!inLine) await sleep(25)
      }
      const second = post('/generate_pcb_stream', body, '198.51.100.31').then(async r => ({ status: r.status, at: Date.now(), text: await r.text() }))
      const [a, b] = await Promise.all([first, second])
      await Promise.all(ahead)
      const after = await settle()
      const firstSaid = said(Buffer.from(a.text))
      check('S5 a request replaced while it waits leaves the line and says why; the retry gets the board', inLine
        && a.status === 409 && firstSaid.code === 'replaced' && /[가-힣]/.test(firstSaid.error ?? '') && a.at < b.at
        && b.status === 200 && /event: done/.test(b.text) && !/event: error/.test(b.text) && after === idleJobs,
        `in line: ${inLine}; first ${a.status} ${a.text.slice(0, 100)}; retry ${b.status} ${/event: done/.test(b.text) ? 'done' : b.text.slice(-120)}; after ${after}`)
    }

    // S6. one visitor runs 2 and waits 4, whatever addresses it writes in front of its own in X-Forwarded-For; the next
    //     ones are refused at once. A request with no X-Forwarded-For is its own address's and goes in at once
    {
      const one = '198.51.100.50'
      const mine = Array.from({ length: 8 }, (_, i) => model(pcb, i % 2 ? `10.9.9.${i}, ${one}` : one))
      await sleep(300)
      const share = JSON.stringify(await jobs())
      const plain = fetch(`${base}/board_model?pcb=${encodeURIComponent(pcb)}`).then(read)
      await sleep(150)
      const beside = await jobs()
      const answers = await Promise.all(mine)
      const own = await plain
      const after = await settle()
      const refusedNow = answers.filter(busy).length, whole = answers.filter(a => a.status === 200).length
      check('S6 one visitor: 2 run, 4 wait, the rest refused; a request with no X-Forwarded-For goes in beside it',
        share === JSON.stringify({ running: 2, waiting: 4, slots: SLOTS }) && beside?.running === 3 && (beside.waiting ?? 0) >= 1
        && refusedNow === 2 && whole === 6 && own.status === 200 && after === idleJobs,
        `one visitor: ${share}; with the other: ${JSON.stringify(beside)}; ${whole} whole, ${refusedNow} refused busy; the other ${own.status}; after ${after}`)
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise(r => proc.once('exit', r))
      proc.kill()
      await gone
    }
    // what these requests wrote: the boards and netlists named slot..., and the demo's netlist with its board
    for (const f of existsSync('outputs') ? readdirSync('outputs') : []) {
      if (/^slot(check|wait|full)_/.test(f) || stems.some(s => f.startsWith(`${s}.`))) rmSync(join('outputs', f), { recursive: true, force: true })
    }
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
rules().catch(e => check('J rules', false, (e as Error).stack ?? String(e)))
  .then(server).catch(e => check('S server', false, (e as Error).stack ?? String(e)))
  .finally(() => {
    console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED')
    process.exitCode = ok ? 0 : 1
  })
