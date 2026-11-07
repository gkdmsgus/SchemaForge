// Checks J1-J7: how many heavy jobs run at once and who waits (job_slots.ts). Nothing capped them: 16 demo boards at once
// took about 2 GB on the development PC, the Jetson container's whole memory cap (review of 2026-11-08).
// J1-J7 the rules, with no server.
// Usage (from server/): npx tsx check_job_slots.ts   → exit 0 only if all pass
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

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
rules().catch(e => check('J rules', false, (e as Error).stack ?? String(e)))
  .finally(() => {
    console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED')
    process.exitCode = ok ? 0 : 1
  })
