// Checks L1-L6: the model provider settings (model.ts). A mock OpenAI-compatible API runs on a local port and
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
import { modelLabel, modelProvider } from './model'

let ok = true
const check = (name: string, pass: boolean, info = '') => {
  ok &&= pass
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}  ${info}`)
}

type Seen = { path: string; auth: string; model: string; effort: string; stream: boolean; json: boolean; system: string }
const seen: Seen[] = []
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
      json: body.response_format?.type === 'json_object', system: String(body.messages?.[0]?.content ?? '').slice(0, 60),
    })
    if (rq.url !== '/v1/chat/completions') { rs.writeHead(404); return rs.end('{}') }
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
  for (let t0 = Date.now(); !up && Date.now() - t0 < 30000; await new Promise(r => setTimeout(r, 300))) {
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

const post = (base: string, path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function main() {
  // M6 first: the names the screen shows, without a server
  check('L6 model names for the screen', modelLabel('gpt-4o') === 'GPT-4o' && modelLabel('gpt-4o-mini') === 'GPT-4o mini'
    && modelLabel('grok-4.3') === 'Grok 4.3' && modelLabel('other-model') === 'other-model'
    && modelProvider('https://api.openai.com/v1') === 'OpenAI' && modelProvider('https://api.x.ai/v1') === 'xAI',
    `${modelLabel('gpt-4o-mini')} / ${modelLabel('grok-4.3')} / ${modelProvider('https://api.x.ai/v1')}`)

  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', () => resolve()))
  const mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`
  const grok = await startServer({
    NODE_ENV: 'development', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', ALLOWED_EMAILS: '', SF_AI_STUB: '',
    OPENAI_API_KEY: 'xai-test-key', OPENAI_BASE_URL: mockBase,
    SF_MODEL: 'grok-4.3', SF_MODEL_MINI: 'grok-mini-test', SF_REASONING_EFFORT: 'none',
  })
  try {
    if (!grok.up) return check('L0 server with the Grok settings', false, `did not start in 30 s: ${grok.log().trim().slice(-400)}`)
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

    n = seen.length
    const gen = await post(grok.base, '/generate', { description: 'LED 하나를 켜는 회로', autoFix: true })
    const events = await gen.text()
    const done = /event: done/.test(events)
    check('L3 circuit code: SF_MODEL at the base URL (was api.openai.com by name), and the circuit is built',
      done && asked(at(n), 'grok-4.3', s => !s.stream && !s.json) && events.includes('Grok 4.3 is analysing'),
      `${at(n).length} call(s) ${JSON.stringify(at(n).map(s => [s.model, s.effort]))} done=${done}`)

    n = seen.length
    const edit = await post(grok.base, '/chat_edit', { graph: { components: [{ ref: 'R1', value: '1k' }], nets: [] }, message: 'R1 값을 2k로 바꿔줘' })
    await edit.text()
    check('L4 AI editor: SF_MODEL_MINI at the base URL, streamed', asked(at(n), 'grok-mini-test', s => s.stream),
      JSON.stringify(at(n).map(s => [s.model, s.effort, s.stream])))
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
