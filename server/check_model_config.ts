// Checks L1-L8: the model provider settings (model.ts), a failed model call told in words (L6b, L7), and the plan
// prompt's part and spec rules as sent (L2b). A mock OpenAI-compatible API runs on a local port and
// records every request; the real server runs in development set up like xAI's Grok (OPENAI_BASE_URL, SF_MODEL,
// SF_MODEL_MINI, SF_REASONING_EFFORT). Each model call must reach the base URL with the key, its model and the
// reasoning effort: circuit code (/generate, which called api.openai.com by name before), questions, plan, AI
// editor. /health names the model for the screen. Without the settings it stays GPT-4o at OpenAI.
// Needs python with skidl (the mock's circuit is run). No real model, no KiCad.
// Usage (from server/): npx tsx check_model_config.ts   → exit 0 only if all pass
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { createServer } from 'http'
import { createServer as createNetServer, type AddressInfo } from 'net'
import { join } from 'path'
import axios from 'axios'
import OpenAI from 'openai'
import {
  MODEL_BUSY, MODEL_KEY_REFUSED, MODEL_NO_CREDIT, MODEL_RETRIES, MODEL_SILENT, MODEL_TIMEOUT_MS, MODEL_UNREACHABLE, modelClient, modelFailure,
  modelLabel, modelProvider,
} from './model'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

type Seen = { path: string; auth: string; model: string; effort: string; stream: boolean; json: boolean; system: string; user: string }
const seen: Seen[] = []
// set for L7: every model call is answered with this error, as OpenAI answers when the credit is gone or it is busy
let failWith: { status: number; error: Record<string, string>; retry?: boolean } | null = null
// set for L4d: the AI editor's streamed answer is this tool call's arguments, ending with this finish reason
let editArgs: { args: string; finish: string } | null = null
// set for L4e: the AI editor's stream sends one piece and stays open; closed once the server lets go of it
let editHold: { closed: boolean } | null = null
// the circuit /generate gets back: a checked-in test circuit, then the guide
const CIRCUIT = readFileSync(join('test_circuits', 'led_basic.py'), 'utf8')

const mock = createServer((rq, rs) => {
  let raw = ''
  rq.on('data', (d: Buffer) => { raw += d.toString() })
  rq.on('end', () => {
    const body = (() => { try { return JSON.parse(raw || '{}') } catch { return {} } })()
    seen.push({
      path: rq.url ?? '', auth: String(rq.headers.authorization ?? ''), model: String(body.model ?? ''),
      effort: String(body.reasoning_effort ?? ''), stream: body.stream === true,
      json: body.response_format?.type === 'json_object', system: String(body.messages?.[0]?.content ?? ''),
      user: String(body.messages?.find((m: { role?: string }) => m.role === 'user')?.content ?? ''),
    })
    if (rq.url !== '/v1/chat/completions') { rs.writeHead(404); return rs.end('{}') }
    if (failWith) {
      // retry-after 0 and x-should-retry false: the SDK's own retries would only make the check slower (L8 asks for them)
      rs.writeHead(failWith.status, { 'Content-Type': 'application/json', 'retry-after': '0', 'x-should-retry': failWith.retry ? 'true' : 'false' })
      return rs.end(JSON.stringify({ error: failWith.error }))
    }
    if (body.stream && editHold) {
      const hold = editHold
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' })
      rs.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'edit_circuit', arguments: '{"reply":"잠' } }] }, finish_reason: null }] })}\n\n`)
      rs.on('close', () => { hold.closed = true })
      return
    }
    if (body.stream && editArgs) {   // the edit as a tool call, in two pieces
      const { args, finish } = editArgs, half = Math.ceil(args.length / 2)
      const call = (part: string) => ({ tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'edit_circuit', arguments: part } }] })
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const part of [args.slice(0, half), args.slice(half)]) {
        rs.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: call(part), finish_reason: null }] })}\n\n`)
      }
      rs.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
      return rs.end('data: [DONE]\n\n')
    }
    if (body.stream) {   // the AI editor streams: one text chunk, then the end
      rs.writeHead(200, { 'Content-Type': 'text/event-stream' })
      rs.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '바꿀 것이 없습니다.' }, finish_reason: null }] })}\n\n`)
      rs.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      return rs.end('data: [DONE]\n\n')
    }
    const content = body.response_format?.type === 'json_object'
      ? '{"clear":true,"title":"LED","summary":"s","topology":"t","specs":[],"parts":[],"risks":[]}'
      : `${CIRCUIT}\n---GUIDE---\n안내`
    rs.writeHead(200, { 'Content-Type': 'application/json' })
    rs.end(JSON.stringify({
      id: 'c', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

/** a port the system says is free (a fixed or random one can sit in a range Windows reserves) */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo
    s.close(() => resolve(port))
  })
})

// How long a started server may take to answer /health. It answers in about 1 s here, idle or with every core busy
// (0.8-1.0 s, 2026-11-07); 30 s failed D9 once while other work held the PC (about 76% CPU). A server that
// starts costs nothing more, and one that exited is not waited for.
const START_MS = 60000
async function startServer(env: Record<string, string>) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'index.ts'], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout!.on('data', (d: Buffer) => { log += d.toString() })
  proc.stderr!.on('data', (d: Buffer) => { log += d.toString() })
  let up = false
  for (let t0 = Date.now(); !up && Date.now() - t0 < START_MS && proc.exitCode === null; await new Promise(r => setTimeout(r, 300))) {
    up = await fetch(base + '/health').then(r => r.ok, () => false)
  }
  return { proc, base, up, log: () => log }
}

async function stopServer(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise(r => proc.once('exit', r))
  proc.kill()
  await gone
}

type Health = { model?: string; provider?: string }

const post2 = (base: string, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
const post = (base: string, path: string, body: unknown) => post2(base, path, body)

async function main() {
  // M6 first: the names the screen shows, without a server
  check('L6 model names for the screen', modelLabel('gpt-4o') === 'GPT-4o' && modelLabel('gpt-4o-mini') === 'GPT-4o mini'
    && modelLabel('grok-4.3') === 'Grok 4.3' && modelLabel('other-model') === 'other-model'
    && modelProvider('https://api.openai.com/v1') === 'OpenAI' && modelProvider('https://api.x.ai/v1') === 'xAI',
    `${modelLabel('gpt-4o-mini')} / ${modelLabel('grok-4.3')} / ${modelProvider('https://api.x.ai/v1')}`)

  // L6b. a failed model call in words: the shapes of the OpenAI SDK's error, axios's error, and xAI's message
  const said = (e: unknown) => modelFailure(e)?.text ?? null
  const shapes = {
    sdkQuota: said({ status: 429, code: 'insufficient_quota', message: '429 You exceeded your current quota' }),
    axiosQuota: said({ message: 'Request failed with status code 429', response: { status: 429, data: { error: { code: 'insufficient_quota', type: 'insufficient_quota' } } } }),
    xaiCredit: said({ status: 429, message: '429 Your team has either used all available credits or reached its monthly spending limit' }),
    busy: said({ status: 429, code: 'rate_limit_exceeded', message: '429 Rate limit reached for gpt-4o' }),
    key: said({ response: { status: 401, data: { error: { code: 'invalid_api_key' } } } }),
    other: said({ status: 500, message: 'Internal error' }),
    plain: said(new Error('boom')),
  }
  check('L6b a failed model call in words: no credit, busy, key refused; anything else left to the caller',
    shapes.sdkQuota === MODEL_NO_CREDIT && shapes.axiosQuota === MODEL_NO_CREDIT && shapes.xaiCredit === MODEL_NO_CREDIT
    && shapes.busy === MODEL_BUSY && shapes.key === MODEL_KEY_REFUSED && shapes.other === null && shapes.plain === null,
    JSON.stringify(Object.fromEntries(Object.entries(shapes).map(([k, v]) => [k, v?.slice(0, 18) ?? null]))))

  // L8. every OpenAI SDK call site takes its client from modelClient(): the SDK's own 10 minutes and 2 retries outlast
  // the whole AI budget, so a stalled model cost a finished board (review of 2026-11-06). 60 s, one retry: about 2 minutes
  const client = (() => { process.env.OPENAI_API_KEY ||= 'check-only'; return modelClient() })()
  const callers = ['index.ts', 'ai_layout.ts'].map(f => [f, readFileSync(f, 'utf8')] as const)
  const own = callers.filter(([, text]) => text.includes('new OpenAI(') || !text.includes('modelClient()')).map(([f]) => f)
  check('L8 model client: 60 s, one retry, used by every call site', client.timeout === 60000 && client.maxRetries === 1
    && MODEL_TIMEOUT_MS === 60000 && MODEL_RETRIES === 1 && own.length === 0,
    `timeout ${client.timeout} ms, retries ${client.maxRetries}${own.length ? `; its own client: ${own.join(', ')}` : ''}`)

  // L8c. a call the SDK gives up on is told in words: with those limits a stalled model's "Request timed out." reached
  // the AI rounds list, which is Korean (21b in pcb/check_ai_loop.py). The real SDK, a port that never answers, a short limit
  const silent = createServer(() => { /* never answers */ })
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', () => resolve()))
  const quick = new OpenAI({ apiKey: 'check-only', baseURL: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`, timeout: 200, maxRetries: 0 })
  const gaveUp = await quick.chat.completions.create({ model: 'fake', messages: [] }).catch((e: unknown) => e)
  silent.closeAllConnections()
  silent.close()
  const told = modelFailure(gaveUp)
  check('L8c a stalled call is told in words', told?.text === MODEL_SILENT && told.status === 504, told?.text ?? String(gaveUp))

  // L8d. the other ways a model call fails before any answer, told in words too: /generate's axios gave up at its 88 s
  // limit with "Server error: timeout of 88000ms exceeded", a model that hung up gave "socket hang up", and the SDK's
  // "Connection error." reached the plan and the AI rounds list (review of 2026-11-07). Real errors from real clients
  const hangUp = createNetServer(s => s.destroy())
  await new Promise<void>(resolve => hangUp.listen(0, '127.0.0.1', () => resolve()))
  const shut = createNetServer()
  await new Promise<void>(resolve => shut.listen(0, '127.0.0.1', () => resolve()))
  const shutPort = (shut.address() as AddressInfo).port
  await new Promise<void>(resolve => shut.close(() => resolve()))
  const at = (server: { address(): unknown }) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', () => resolve()))
  const viaAxios = (base: string, timeout = 2000) => axios.post(`${base}/v1/chat/completions`, {}, { timeout }).catch((e: unknown) => e)
  const viaSdk = (base: string) => new OpenAI({ apiKey: 'check-only', baseURL: `${base}/v1`, timeout: 2000, maxRetries: 0 })
    .chat.completions.create({ model: 'fake', messages: [] }).catch((e: unknown) => e)
  const failures = {
    axiosTimeout: [await viaAxios(at(silent), 200), 504, MODEL_SILENT],
    axiosHangUp: [await viaAxios(at(hangUp)), 503, MODEL_UNREACHABLE],
    axiosRefused: [await viaAxios(`http://127.0.0.1:${shutPort}`), 503, MODEL_UNREACHABLE],
    sdkHangUp: [await viaSdk(at(hangUp)), 503, MODEL_UNREACHABLE],
    sdkRefused: [await viaSdk(`http://127.0.0.1:${shutPort}`), 503, MODEL_UNREACHABLE],
  } as const
  silent.closeAllConnections()
  silent.close()
  hangUp.close()
  const wrong = Object.entries(failures).filter(([, [e, status, text]]) => modelFailure(e)?.status !== status || modelFailure(e)?.text !== text)
  check('L8d a model that hangs up, refuses the connection or outlasts axios is told in words', wrong.length === 0,
    wrong.map(([k, [e]]) => `${k}: ${modelFailure(e)?.text ?? (e as Error)?.message}`).join(' | '))

  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', () => resolve()))
  const mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`
  const grok = await startServer({
    NODE_ENV: 'development', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_AI_STUB: '',
    OPENAI_API_KEY: 'xai-test-key', OPENAI_BASE_URL: mockBase,
    SF_MODEL: 'grok-4.3', SF_MODEL_MINI: 'grok-mini-test', SF_REASONING_EFFORT: 'none',
  })
  try {
    if (!grok.up) return check('L0 server with the Grok settings', false, `did not start (limit ${START_MS / 1000} s): ${grok.log().trim().slice(-400)}`)
    const health = await fetch(grok.base + '/health').then(r => r.json() as Promise<Health>)
    check('L1 /health names the model and who runs it', health.model === 'Grok 4.3' && health.provider === '127.0.0.1',
      `${health.model} · ${health.provider}`)

    const at = (n: number) => seen.slice(n)
    const asked = (calls: Seen[], model: string, more: (s: Seen) => boolean) => calls.length > 0 && calls.every(s =>
      s.path === '/v1/chat/completions' && s.auth === 'Bearer xai-test-key' && s.model === model && s.effort === 'none' && more(s))

    let n = seen.length
    const clarify = await post(grok.base, '/clarify', { description: 'LED 하나를 켜는 회로' })
    const plan = await post(grok.base, '/plan', { description: 'LED 하나를 켜는 회로' })
    check('L2 questions and plan: SF_MODEL_MINI at the base URL, JSON mode, the key, reasoning effort',
      clarify.status === 200 && plan.status === 200 && at(n).length === 2 && asked(at(n), 'grok-mini-test', s => s.json),
      JSON.stringify(at(n).map(s => [s.path, s.model, s.effort, s.json])))

    // L2b. the plan's system prompt, as the model got it, asks for no part count and no spec the circuit lacks
    //      (2026-11-03 takes 1 and 3, S28: "4-6 entries" and "frequency, efficiency" for every circuit gave an
    //      LM1117-3.3 an R1 "출력 전압 조정" and specs of 50 kHz and 80 %); its designator and value rules stay whole
    const brief = (at(n).find(s => s.system.includes('one-page design brief'))?.system ?? '').replace(/\s+/g, ' ')
    const briefRules = { noFloor: !/\d+-\d+ entries — the parts/.test(brief) && brief.includes('Never add a part to reach a count'),
      fixedReg: /fixed-output regulator \([^)]*\) takes no voltage-setting resistor/.test(brief),
      specs: brief.includes('a frequency only for a circuit that oscillates or switches') && brief.includes('efficiency is at most Vout/Vin')
        && !brief.includes('frequency, efficiency)'),
      refs: brief.includes('Use standard reference designators (R, C, L, D, Q, U, SW, K, LS, BT, J, Y) numbered from 1.')
        && brief.includes('"value" is a real part number or E-series value.'),
      // and every part the circuit needs, checked before the answer: "only parts the design needs, up to 6" made the
      // blinker's brief drop its LED resistor or a timing resistor (2026-11-03 take 4, S05: 4 parts; against the
      // live model the tour's blinker kept its LED resistor and both timing resistors in 0 of 5 briefs, 19 of 20 after)
      needed: brief.includes('every part the circuit cannot work without') && brief.includes('every LED has its series resistor listed')
        && brief.includes('a revision keeps every part the circuit still needs') }
    check('L2b plan prompt: no part floor, every part the circuit needs, specs that apply', Object.values(briefRules).every(Boolean), JSON.stringify(briefRules))

    n = seen.length
    const gen = await post(grok.base, '/generate', { description: 'LED 하나를 켜는 회로', autoFix: true })
    const events = await gen.text()
    const done = /event: done/.test(events)
    check('L3 circuit code: SF_MODEL at the base URL (was api.openai.com by name), and the circuit is built',
      done && asked(at(n), 'grok-4.3', s => !s.stream && !s.json) && events.includes('Grok 4.3 is analysing') && !events.includes('"sources"'),
      `${at(n).length} call(s) ${JSON.stringify(at(n).map(s => [s.model, s.effort]))} done=${done}`)

    // L3b. the approved plan reaches the circuit request (it was approved on screen and never sent); none without one
    n = seen.length
    const planned = await post(grok.base, '/generate', { description: '전원 회로 만들어줘', autoFix: true, plan: {
      topology: '선형', specs: [{ label: '출력 전압', value: '12V' }],
      parts: [{ ref: 'U1', type: '전압 조정기', value: 'LM7812', role: '12V 출력' }, { ref: 'R1', type: '저항', value: '1kΩ' }] } })
    await planned.text()
    const withPlan = at(n)[0]?.user ?? ''
    n = seen.length
    await (await post(grok.base, '/generate', { description: '전원 회로 만들어줘', autoFix: true })).text()
    const withoutPlan = at(n)[0]?.user ?? ''
    check('L3b the approved plan goes into the circuit request, and nothing when there is none',
      /approved this design plan/.test(withPlan) && /Part: U1 전압 조정기 LM7812 \(12V 출력\)/.test(withPlan) && /Spec: 출력 전압 = 12V/.test(withPlan)
      && !/approved this design plan/.test(withoutPlan) && withoutPlan.includes('전원 회로 만들어줘'),
      withPlan.slice(0, 300).replace(/\n/g, ' | '))

    n = seen.length
    const edit = await post(grok.base, '/chat_edit', { graph: { components: [{ ref: 'R1', value: '1k' }], nets: [] }, message: 'R1 값을 2k로 바꿔줘' })
    await edit.text()
    // no-transform as the other streams: a compressing proxy in front (Caddy's encode) would compress only this one
    const editCache = edit.headers.get('cache-control')
    check('L4 AI editor: SF_MODEL_MINI at the base URL, streamed, not to be transformed', asked(at(n), 'grok-mini-test', s => s.stream) && editCache === 'no-cache, no-transform',
      `${JSON.stringify(at(n).map(s => [s.model, s.effort, s.stream]))} ${editCache}`)

    // L4b. the AI editor is told the free refs and to leave unnamed parts alone (live, 2026-10-30, the 555 blinker:
    // a new capacitor took C3, which exists, and the battery's + pin was moved off VCC)
    n = seen.length
    const blinker = { components: ['BT1', 'U1', 'R1', 'R2', 'R3', 'C1', 'C2', 'C3', 'D1'].map(ref => ({ ref, value: '' })),
      nets: [{ name: 'VCC', nodes: [{ ref: 'BT1', pin: '1' }, { ref: 'C3', pin: '1' }] }] }
    await (await post(grok.base, '/chat_edit', { graph: blinker, message: '전원 입력 쪽에 100nF 커패시터를 하나 추가해줘' })).text()
    const sys = at(n)[0]?.system ?? ''
    check('L4b AI editor prompt: the free refs (C4, not C3) and no removing, changing or re-wiring parts the user did not name',
      /Free refs for new parts: R4, C4, L1, D2, Q1, U2, SW1, K1, LS1, BT2, J1, Y1\n/.test(sys) && /never a ref already in the component list/.test(sys)
      && /Change, remove or re-wire only the parts the user's message names/.test(sys) && /Never remove or modify another part/.test(sys)
      && !/must list every ref\+pin/.test(sys),
      sys.split('\n').filter(l => /Free refs|Change, remove|never a ref/.test(l)).join(' | ') || sys.slice(0, 200))
    // L4c. a reply that asks comes with no edit: the app applies actions at once (2026-11-01 tour: "이 연결을 적용할까요?"
    // came with the connection, and it was in before the answer)
    check('L4c AI editor prompt: a reply that asks the user anything returns no actions',
      /when\s+the reply asks the user anything[^]*?return an empty actions array: the\s+edit waits for the answer/.test(sys)
      && /When you return actions, the reply says what changed and asks nothing/.test(sys),
      sys.split('\n').filter(l => /asks|waits/.test(l)).join(' | ') || sys.slice(0, 200))

    // L4d. "완료" only with an edit (2026-11-03 tour, 52 s: "완료했습니다." with nothing changed): no reply and no actions,
    // an edit cut at max_tokens (its reply as far as it came, no actions), and a whole edit with no reply
    const edited = async (args: string, finish = 'stop') => {
      editArgs = { args, finish }
      try {
        const sse = await (await post(grok.base, '/chat_edit', { graph: blinker, message: 'C1을 연결해줘' })).text()
        const m = /event: done\ndata: (.+)/.exec(sse)
        return m ? JSON.parse(m[1]) as { reply: string; actions: unknown[] } : { reply: `(no done event) ${sse.slice(0, 120)}`, actions: [] }
      } finally { editArgs = null }
    }
    const empty = await edited('{"reply":"","actions":[]}')
    const cut = await edited('{"reply":"C1을 TRIG에 연결했습니다.","actions":[{"type":"add_net","name":"TRIG","nodes":[{"ref":"C1"', 'length')
    const whole = await edited('{"reply":"","actions":[{"type":"modify_component","ref":"R1","value":"2k"}]}')
    // the cut reply's escapes read (2 is 2, \t a tab), the escape cut at its end left out (review of 2026-11-03)
    const esc = await edited('{"reply":"R1 값을 \\u0032k로\\t바꾸고 \\u00', 'length')
    // an escaped backslash stays one backslash: "\\u0041" is not A, "\\t" not a tab (recheck of 2026-11-03)
    const esc2 = await edited(String.raw`{"reply":"see \\u0041 and C:\\temp\t끝`, 'length')
    check('L4d AI editor: no reply and no edit is not "완료"; an edit cut short keeps its reply (escapes read), applies nothing and asks for it in parts; "완료" with an edit',
      /^바꿀 내용을 정하지 못했습니다/.test(empty.reply) && !empty.actions.length
      && /^C1을 TRIG에 연결했습니다\.\n\n답이 길어 중간에 끊겼습니다\. 바꿀 것을 몇 개씩 나눠서/.test(cut.reply) && !cut.actions.length
      && whole.reply === '완료했습니다.' && whole.actions.length === 1
      && /^R1 값을 2k로\t바꾸고 \n\n답이 길어 중간에 끊겼습니다/.test(esc.reply) && !esc.reply.includes('\\')
      && esc2.reply.startsWith(String.raw`see \u0041 and C:\temp` + '\t끝\n\n'),
      JSON.stringify({ empty, cut, whole, esc, esc2 }))

    // L4e. the visitor leaves in the middle of an AI edit: the model's stream is dropped at once (it ran on for up to 45 s
    // at the operator's cost, review of 2026-11-06)
    const hold = { closed: false }
    editHold = hold
    const leave = new AbortController()
    const leaving = await post2(grok.base, '/chat_edit', { graph: blinker, message: 'C1을 연결해줘' }, leave.signal)
    await leaving.body!.getReader().read()
    leave.abort()
    const t0 = Date.now()
    while (!hold.closed && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 50))
    editHold = null
    check('L4e AI editor: the model stream ends when the visitor leaves', hold.closed, `${hold.closed ? `dropped ${Date.now() - t0} ms after the visitor left` : 'still open 10 s after the visitor left'}`)

    // L7. the model's credit is gone (OpenAI: 429 insufficient_quota): the plan, the circuit and the AI editor say so
    // in words. The circuit said "Server error: Request failed with status code 429" before (2026-11-01)
    failWith = { status: 429, error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }
    const qPlan = await post(grok.base, '/plan', { description: 'LED 하나를 켜는 회로' })
    const qPlanError = String((await qPlan.json() as { error?: string }).error ?? '')
    const qGen = await (await post(grok.base, '/generate', { description: 'LED 하나를 켜는 회로', autoFix: true })).text()
    const qEdit = await (await post(grok.base, '/chat_edit', { graph: blinker, message: 'R1 값을 2k로 바꿔줘' })).text()
    const inEvent = (sseText: string) => sseText.split('\n').filter(l => l.startsWith('data:') && /message/.test(l)).join(' ')
    check('L7 no model credit: the plan (503), the circuit and the AI editor tell it in words, not the status code',
      qPlan.status === 503 && qPlanError === MODEL_NO_CREDIT && inEvent(qGen).includes(MODEL_NO_CREDIT) && !/status code 429|Server error/.test(qGen)
      && inEvent(qEdit).includes(MODEL_NO_CREDIT),
      `plan ${qPlan.status} ${qPlanError.slice(0, 30)} | gen ${inEvent(qGen).slice(0, 80)} | edit ${inEvent(qEdit).slice(0, 80)}`)

    // L7b. too many requests (429 rate_limit_exceeded): try again shortly
    failWith = { status: 429, error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }
    const busy = await post(grok.base, '/plan', { description: 'LED 하나를 켜는 회로' })
    const busyError = String((await busy.json() as { error?: string }).error ?? '')
    check('L7b model busy: the plan answers 429 and asks to try again shortly', busy.status === 429 && busyError === MODEL_BUSY,
      `${busy.status} ${busyError}`)
    const busyAsk = await post(grok.base, '/clarify', { description: 'LED 하나를 켜는 회로' })
    const busyAskBody = await busyAsk.json() as { error?: string; clear?: boolean }

    // L8b. the same on the wire: an answer the SDK may retry (500) is asked twice from a route, not three times
    failWith = { status: 500, error: { message: 'down', type: 'server_error', code: 'server_error' }, retry: true }
    n = seen.length
    const down = await post(grok.base, '/plan', { description: 'LED 하나를 켜는 회로' })
    check('L8b a retryable failure is asked once more, no further', down.status === 500 && at(n).length === 2, `${down.status} after ${at(n).length} call(s)`)
    const downAsk = await post(grok.base, '/clarify', { description: 'LED 하나를 켜는 회로' })
    const downAskBody = await downAsk.json() as { error?: string; clear?: boolean }
    failWith = null

    // L7c. the questions step says a model failure it knows as the plan does, so the screen stops there: it answered
    // "no questions" and the plan and the circuit asked the same model again, about 5.5 minutes for a stalled one before
    // an English error (review of 2026-11-07). Any other failure still lets the steps go on (the questions are optional)
    check('L7c the questions: a known model failure is told (429 busy), any other is "no questions"', busyAsk.status === 429
      && busyAskBody.error === MODEL_BUSY && downAsk.status === 200 && downAskBody.clear === true,
      `busy ${busyAsk.status} ${JSON.stringify(busyAskBody).slice(0, 60)} | 500 ${downAsk.status} ${JSON.stringify(downAskBody)}`)
  } finally {
    await stopServer(grok.proc)
  }

  const plain = await startServer({ NODE_ENV: 'development', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '',
    OPENAI_BASE_URL: '', SF_MODEL: '', SF_MODEL_MINI: '', SF_REASONING_EFFORT: '' })
  try {
    const health: Health = plain.up ? await fetch(plain.base + '/health').then(r => r.json() as Promise<Health>) : {}
    check('L5 without the settings: GPT-4o at OpenAI', health.model === 'GPT-4o' && health.provider === 'OpenAI', `${health.model} · ${health.provider}`)
  } finally {
    await stopServer(plain.proc)
    mock.close()
    mock.closeAllConnections()
  }
}

// exitCode, not process.exit(): exiting with fetch's sockets still open crashed Node on Windows (0xC0000409)
main().catch(e => check('L model config', false, (e as Error).stack ?? String(e))).finally(() => { process.exitCode = ok ? 0 : 1 })
