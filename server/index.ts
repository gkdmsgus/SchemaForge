import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { spawn } from 'child_process'
import {
  mkdirSync, existsSync, copyFileSync,
  readdirSync, writeFileSync, readFileSync,
} from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import { tavily } from '@tavily/core'
import axios from 'axios'
import { createClient } from '@supabase/supabase-js'

// ── Types ──────────────────────────────────────────────────────────

interface NetNode { ref: string; pin: string }
interface NetEntry { name: string; nodes: NetNode[] }
interface ComponentEntry { ref: string; value: string; name?: string }
interface NetGraph { components: ComponentEntry[]; nets: NetEntry[] }

interface ChatAction {
  type: string
  ref?: string
  name?: string
  value?: string
  nodes?: NetNode[]
}

interface AuthUser {
  id: string
  email: string
}

// Extend Request with optional user
interface AuthRequest extends Request {
  user?: AuthUser
}

// ── Supabase (optional) ────────────────────────────────────────────

const SUPABASE_ENABLED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
const supabase = SUPABASE_ENABLED
  ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
  : null

// fallback local token store (used when Supabase not configured)
const localTokens = new Map<string, AuthUser>()

// ── Express app ────────────────────────────────────────────────────

const app = express()
app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true,
}))
app.use(express.json())

// Production: serve built React files
// Dockerfile WORKDIR=/app/server, dist is copied to /app/dist
const distCandidates = [
  join(process.cwd(), 'dist'),
  join(process.cwd(), '..', 'dist'),
  '/app/dist',
]
const distPath = distCandidates.find(p => existsSync(p)) ?? join(process.cwd(), 'dist')
console.log('[static] distPath:', distPath, '| exists:', existsSync(distPath))

if (existsSync(distPath)) {
  app.use(express.static(distPath))
}

const OUTPUTS_DIR = join(process.cwd(), 'outputs')
if (!existsSync(OUTPUTS_DIR)) mkdirSync(OUTPUTS_DIR)

// ── Auth Middleware ────────────────────────────────────────────────

async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  if (SUPABASE_ENABLED) {
    const { data, error } = await supabase!.auth.getUser(token)
    if (error || !data.user) return res.status(401).json({ error: 'Invalid token' })
    req.user = { id: data.user.id, email: data.user.email ?? '' }
  } else {
    const user = localTokens.get(token)
    if (!user) return res.status(401).json({ error: 'Invalid token' })
    req.user = user
  }
  next()
}

async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    if (SUPABASE_ENABLED) {
      const { data } = await supabase!.auth.getUser(token)
      if (data.user) req.user = { id: data.user.id, email: data.user.email ?? '' }
    } else {
      const user = localTokens.get(token)
      if (user) req.user = user
    }
  }
  next()
}

// ── Auth Routes ────────────────────────────────────────────────────

// POST /auth/register
app.post('/auth/register', async (req: Request, res: Response) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' })

  if (SUPABASE_ENABLED) {
    const { data, error } = await supabase!.auth.signUp({ email, password })
    if (error) return res.status(400).json({ error: error.message })
    res.json({ user: { id: data.user?.id, email: data.user?.email }, session: data.session })
  } else {
    // 로컬 fallback: 간단한 인메모리 유저 저장
    const id = randomUUID()
    const token = randomUUID()
    const user: AuthUser = { id, email }
    localTokens.set(token, user)
    res.json({ user, token })
  }
})

// POST /auth/login
app.post('/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' })

  if (SUPABASE_ENABLED) {
    const { data, error } = await supabase!.auth.signInWithPassword({ email, password })
    if (error) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' })
    res.json({ user: { id: data.user?.id, email: data.user?.email }, token: data.session?.access_token })
  } else {
    // 로컬 fallback: 이메일로 토큰 발급 (비밀번호 무검증 - 데모용)
    const id = randomUUID()
    const token = randomUUID()
    const user: AuthUser = { id, email }
    localTokens.set(token, user)
    res.json({ user, token })
  }
})

// POST /auth/logout
app.post('/auth/logout', async (req: AuthRequest, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    if (SUPABASE_ENABLED) {
      await supabase!.auth.admin.signOut(token)
    } else {
      localTokens.delete(token)
    }
  }
  res.json({ ok: true })
})

// GET /auth/me
app.get('/auth/me', requireAuth as any, async (req: AuthRequest, res: Response) => {
  res.json({ user: req.user })
})

// ── Session Routes (DB persistence) ───────────────────────────────

// GET /sessions — 유저 세션 목록
app.get('/sessions', requireAuth as any, async (req: AuthRequest, res: Response) => {
  if (!supabase) return res.json({ sessions: [] })
  const { data, error } = await supabase
    .from('sessions')
    .select('id, prompt, guide, graph, filename, created_at')
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ sessions: data })
})

// POST /sessions — 세션 저장
app.post('/sessions', optionalAuth as any, async (req: AuthRequest, res: Response) => {
  const { prompt, code, guide, graph, filename } = req.body
  if (!prompt) return res.status(400).json({ error: 'prompt required' })
  if (!supabase) return res.json({ id: randomUUID() })

  const row = { user_id: req.user?.id ?? null, prompt, code: code ?? null, guide: guide ?? null, graph: graph ?? null, filename: filename ?? null }
  const { data, error } = await supabase.from('sessions').insert(row).select('id').single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ id: data.id })
})

// DELETE /sessions/:id
app.delete('/sessions/:id', requireAuth as any, async (req: AuthRequest, res: Response) => {
  if (!supabase) return res.json({ ok: true })
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id).eq('user_id', req.user!.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// GET /sessions/:id/messages — 채팅 메시지
app.get('/sessions/:id/messages', requireAuth as any, async (req: AuthRequest, res: Response) => {
  if (!supabase) return res.json({ messages: [] })
  const { data: session } = await supabase.from('sessions').select('id').eq('id', req.params.id).eq('user_id', req.user!.id).single()
  if (!session) return res.status(404).json({ error: 'Session not found' })

  const { data, error } = await supabase.from('chat_messages').select('id, role, content, actions, created_at').eq('session_id', req.params.id).order('created_at')
  if (error) return res.status(500).json({ error: error.message })
  res.json({ messages: data })
})

// POST /sessions/:id/messages — 채팅 메시지 저장
app.post('/sessions/:id/messages', optionalAuth as any, async (req: AuthRequest, res: Response) => {
  const { role, content, actions } = req.body
  if (!role || !content) return res.status(400).json({ error: 'role and content required' })
  if (!supabase) return res.json({ ok: true })

  const { error } = await supabase.from('chat_messages').insert({ session_id: req.params.id, role, content, actions: actions ?? null })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── Favorites Routes ───────────────────────────────────────────────

// GET /favorites
app.get('/favorites', requireAuth as any, async (req: AuthRequest, res: Response) => {
  if (!supabase) return res.json({ favorites: [] })
  const { data, error } = await supabase.from('favorites').select('id, session_id, sessions(prompt, graph, created_at)').eq('user_id', req.user!.id).order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ favorites: data })
})

// POST /favorites
app.post('/favorites', requireAuth as any, async (req: AuthRequest, res: Response) => {
  const { session_id } = req.body
  if (!session_id) return res.status(400).json({ error: 'session_id required' })
  if (!supabase) return res.json({ id: randomUUID() })

  const { data, error } = await supabase.from('favorites').upsert({ user_id: req.user!.id, session_id }, { onConflict: 'user_id,session_id' }).select('id').single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ id: data.id })
})

// DELETE /favorites/:id
app.delete('/favorites/:id', requireAuth as any, async (req: AuthRequest, res: Response) => {
  if (!supabase) return res.json({ ok: true })
  const { error } = await supabase.from('favorites').delete().eq('id', req.params.id).eq('user_id', req.user!.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── Circuit Generation Helpers ─────────────────────────────────────

const SYSTEM_PROMPT = `You are a circuit design engine that emits skidl Python code for KiCad. You ALWAYS produce a complete, buildable circuit — never a stub, never a clarifying question.

═══ SECTION 1 — skidl code ═══

Hard rules. Violating any one of these makes the output unusable:
1. The first line is exactly: from skidl import *
2. Import nothing else. No os, no sys, no file or network access.
3. Every Part() uses tool=SKIDL with an explicit pins=[...] list.
   NEVER Part('library', 'name'). NEVER a footprint= argument. NEVER call ERC().
4. Set .value on every part immediately after creating it.
5. Connect pins by name: r1['p1'] += vcc
6. The last line is exactly: generate_netlist()

Reference designators — use ONLY these ref_prefix values. Any other prefix gets the
wrong PCB footprint downstream:
  R  resistor          C  capacitor           L  inductor
  D  diode / LED       Q  transistor / FET    U  IC / regulator / timer
  SW switch / button   K  relay               LS buzzer / speaker
  BT battery / cell    J  connector, header, USB, power jack, screw terminal
  Y  crystal / oscillator

Nets:
- Name every net. Net names are shown to the user and written into the netlist, so
  make them meaningful: GND, VCC, +5V, +3V3, VIN, VOUT, TRIG, LED_A.
- Exactly one ground net, named 'GND'.
- Every pin of every part must land on a net. A floating pin is a defect — tie unused
  IC inputs explicitly to VCC or GND rather than leaving them unconnected.
- The power source is a real part (BT for a battery, J for a jack/USB inlet), never a
  bare net with nothing driving it.

Values:
- Real E12/E24 values with units: '4.7k', '470', '100nF', '10uF', '1N4148', 'NE555'.
- Bare numbers ('10000') and placeholders ('R1', 'resistor') are wrong.
- Include what a working board actually needs: a decoupling cap on every IC supply pin,
  a current-limiting resistor on every LED, a bulk cap on the input rail, a flyback
  diode across any relay or motor, a pull-up on any open-drain or reset line.
- Size the parts from the user's numbers. If they ask for 1 Hz or 3.3 V or 15 mA, the
  values you pick must actually produce that.

Part templates — copy verbatim, changing only name, value and the pin list:
- Resistor: Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Capacitor: Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Electrolytic capacitor (polarized, use for 1uF and above): Part(tool=SKIDL, name='CP', ref_prefix='C', pins=[Pin(num=1,name='+',func=Pin.types.PASSIVE), Pin(num=2,name='-',func=Pin.types.PASSIVE)])
- Inductor: Part(tool=SKIDL, name='L', ref_prefix='L', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- LED: Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- Diode: Part(tool=SKIDL, name='D', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- NPN: Part(tool=SKIDL, name='Q_NPN', ref_prefix='Q', pins=[Pin(num=1,name='B',func=Pin.types.INPUT), Pin(num=2,name='C',func=Pin.types.PASSIVE), Pin(num=3,name='E',func=Pin.types.PASSIVE)])
- N-MOSFET: Part(tool=SKIDL, name='Q_NMOS', ref_prefix='Q', pins=[Pin(num=1,name='G',func=Pin.types.INPUT), Pin(num=2,name='D',func=Pin.types.PASSIVE), Pin(num=3,name='S',func=Pin.types.PASSIVE)])
- Op-Amp: Part(tool=SKIDL, name='OpAmp', ref_prefix='U', pins=[Pin(num=1,name='IN+',func=Pin.types.INPUT), Pin(num=2,name='IN-',func=Pin.types.INPUT), Pin(num=3,name='OUT',func=Pin.types.OUTPUT), Pin(num=4,name='V+',func=Pin.types.PWRIN), Pin(num=5,name='V-',func=Pin.types.PWRIN)])
- Linear regulator: Part(tool=SKIDL, name='REG', ref_prefix='U', pins=[Pin(num=1,name='GND',func=Pin.types.PWRIN), Pin(num=2,name='OUT',func=Pin.types.PWROUT), Pin(num=3,name='IN',func=Pin.types.PWRIN)])
- NE555 timer: Part(tool=SKIDL, name='NE555', ref_prefix='U', pins=[Pin(num=1,name='GND',func=Pin.types.PWRIN), Pin(num=2,name='TRIG',func=Pin.types.INPUT), Pin(num=3,name='OUT',func=Pin.types.OUTPUT), Pin(num=4,name='RESET',func=Pin.types.INPUT), Pin(num=5,name='CTRL',func=Pin.types.PASSIVE), Pin(num=6,name='THRES',func=Pin.types.INPUT), Pin(num=7,name='DISCH',func=Pin.types.PASSIVE), Pin(num=8,name='VCC',func=Pin.types.PWRIN)])
- Switch: Part(tool=SKIDL, name='SW', ref_prefix='SW', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Relay: Part(tool=SKIDL, name='Relay', ref_prefix='K', pins=[Pin(num=1,name='COIL1',func=Pin.types.PASSIVE), Pin(num=2,name='COIL2',func=Pin.types.PASSIVE), Pin(num=3,name='COM',func=Pin.types.PASSIVE), Pin(num=4,name='NO',func=Pin.types.PASSIVE), Pin(num=5,name='NC',func=Pin.types.PASSIVE)])
- Buzzer: Part(tool=SKIDL, name='Buzzer', ref_prefix='LS', pins=[Pin(num=1,name='+',func=Pin.types.PASSIVE), Pin(num=2,name='-',func=Pin.types.PASSIVE)])
- Battery: Part(tool=SKIDL, name='Battery', ref_prefix='BT', pins=[Pin(num=1,name='+',func=Pin.types.PWROUT), Pin(num=2,name='-',func=Pin.types.PWROUT)])
- Connector / power inlet: Part(tool=SKIDL, name='Conn_01x02', ref_prefix='J', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Crystal: Part(tool=SKIDL, name='Crystal', ref_prefix='Y', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])

For a part not listed here, follow the same shape: real pin names from its datasheet,
Pin.types.PWRIN / PWROUT for supply pins, INPUT / OUTPUT for signals, PASSIVE otherwise.

═══ SECTION 2 — Korean wiring guide ═══

Write in Korean, using exactly these four headings and nothing else:

## 회로 개요
One or two sentences: which topology this is and what it does.

## 배선 순서
Numbered steps in the order someone would actually build it — power rails first, then
the core stage, then the output stage. Every step names the real refs and pin
names/numbers from the code above (e.g. "U1의 8번(VCC)").

## 계산 근거
The formulas that set the key values, with the numbers substituted in and the result in
bold. If the user asked for a target, show that these values hit it.

## 주의사항
Two to four hazards specific to THIS circuit — polarity, power dissipation, current
limits, thermal headroom, oscillation. No generic safety filler.

═══ OUTPUT FORMAT ═══

Exactly two sections separated by a line containing only: ---GUIDE---
Before the separator: the skidl Python code and nothing else. No prose, no markdown
fences, no comments outside the code.
After the separator: the Korean guide.`

/** Remove a wrapping ```...``` markdown fence, if the model emitted one. */
function stripFences(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  const lines = t.split('\n')
  lines.shift()
  if (lines[lines.length - 1]?.trim().startsWith('```')) lines.pop()
  return lines.join('\n').trim()
}

function runSkidl(code: string, timeout = 90000): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpDir = join(tmpdir(), randomUUID())
    mkdirSync(tmpDir)
    const codePath = join(tmpDir, 'circuit.py')
    writeFileSync(codePath, code, 'utf8')

    const proc = spawn('python', [codePath], { cwd: tmpDir })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => { proc.kill(); reject(new Error('skidl execution timed out')) }, timeout)
    proc.on('error', (e: Error) => { clearTimeout(timer); reject(e) })

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(stderr))
      const netFiles = readdirSync(tmpDir).filter(f => f.endsWith('.net'))
      if (!netFiles.length) return reject(new Error('No netlist file was generated.'))
      const jobId = randomUUID().replace(/-/g, '')
      const outputPath = join(OUTPUTS_DIR, `${jobId}.net`)
      copyFileSync(join(tmpDir, netFiles[0]), outputPath)
      resolve(outputPath)
    })
  })
}

function parseNetlist(text: string): NetGraph {
  const components: ComponentEntry[] = []
  const nets: NetEntry[] = []

  const compRe = /\(comp\s*\(ref\s+"([^"]+)"\)\s*\(value\s+"([^"]*)"\)/g
  const compStarts: { idx: number; ref: string; value: string }[] = []
  let m: RegExpExecArray | null
  while ((m = compRe.exec(text)) !== null) {
    compStarts.push({ idx: m.index, ref: m[1], value: m[2] })
  }
  // The part template name (libsource part) picks the PCB footprint downstream.
  const netsIdx = text.search(/\(nets\b/)
  compStarts.forEach((c, i) => {
    const end = i + 1 < compStarts.length ? compStarts[i + 1].idx : (netsIdx >= 0 ? netsIdx : text.length)
    const part = /\(part\s+"([^"]+)"\)/.exec(text.slice(c.idx, end))
    components.push(part ? { ref: c.ref, value: c.value, name: part[1] } : { ref: c.ref, value: c.value })
  })

  const netSectionMatch = text.match(/\(nets[\s\S]*$/)
  if (netSectionMatch) {
    const netSection = netSectionMatch[0]
    const netStartRe = /\(net\s*\n?\s*\(code\s+(\d+)\)\s*\n?\s*\(name\s+"([^"]+)"\)/g
    let nm: RegExpExecArray | null
    const netStarts: { idx: number; name: string }[] = []
    while ((nm = netStartRe.exec(netSection)) !== null) {
      netStarts.push({ idx: nm.index, name: nm[2] })
    }
    for (let i = 0; i < netStarts.length; i++) {
      const start = netStarts[i].idx
      const end = i + 1 < netStarts.length ? netStarts[i + 1].idx : netSection.length
      const block = netSection.slice(start, end)
      const nodes: NetNode[] = []
      let nodeM: RegExpExecArray | null
      const nodeRe = /\(node\s*\n?\s*\(ref\s+"([^"]+)"\)\s*\n?\s*\(pin\s+"([^"]+)"\)/g
      while ((nodeM = nodeRe.exec(block)) !== null) {
        nodes.push({ ref: nodeM[1], pin: nodeM[2] })
      }
      if (nodes.length > 0) nets.push({ name: netStarts[i].name, nodes })
    }
  }

  return { components, nets }
}

const sse = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`

function graphToNetlist(graph: NetGraph): string {
  const compLines = graph.components.map(c =>
    `    (comp (ref "${c.ref}") (value "${c.value || c.ref}")\n` +
    `      (description "${c.name || ''}")\n` +
    `      (footprint "")\n` +
    (c.name ? `      (libsource (lib "NO_LIB") (part "${c.name}"))\n` : '') +
    `    )`
  ).join('\n')

  const netLines = graph.nets.map((n, i) => {
    const nodeLines = n.nodes.map(nd =>
      `      (node (ref "${nd.ref}") (pin "${nd.pin}"))`
    ).join('\n')
    return `    (net (code ${i + 1}) (name "${n.name}")\n${nodeLines}\n    )`
  }).join('\n')

  return `(export (version "D")
  (design
    (source "schemaforge_edited")
    (date "")
    (tool "SchemaForge AI Editor")
  )
  (components
${compLines}
  )
  (nets
${netLines}
  )
)`
}

// ── POST /clarify ──────────────────────────────────────────────────

const CLARIFY_SYSTEM_PROMPT = `You screen circuit requests. Given a user's request (Korean or English), decide whether you can already design a specific circuit from it, or whether a couple of questions would change what you build.

Output JSON ONLY, in exactly one of these two shapes:
{ "clear": true }
{ "clear": false, "questions": [ { "key": "string", "label": "string (Korean)", "options": ["string", ...] } ] }

When to return clear:true — STRONGLY prefer this:
- The request names a function and any one hard number (voltage, current, frequency,
  channel count, a part number). "9V로 LED 3개 점멸" is clear. So is "NE555 1Hz 타이머".
- Anything you could design by picking reasonable defaults. Pick the defaults.

When to return clear:false:
- Only when a missing answer would change the topology, not just a component value.
  "전원 회로 만들어줘" — linear vs switching vs what rail is genuinely unknown.
- Never ask about something the user already stated.
- Never ask for a value you could just choose (resistor tolerance, cap package).

Question rules:
- 2 to 4 questions. Each must change the design if answered differently.
- label: Korean, a full question, under 30 characters.
- options: 2–4 short Korean choices. Put the most common one first — it is the default.
- key: lowercase ascii identifier (supply, topology, output_current, mounting).

Output the JSON object and nothing else.`

app.post('/clarify', async (req: Request, res: Response) => {
  const description = (req.body?.description || '').trim()
  if (!description) return res.status(400).json({ error: 'description required' })
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: CLARIFY_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    })
    const raw = response.choices[0]?.message?.content || '{"clear":true}'
    let parsed: { clear: boolean; questions?: unknown[] }
    try { parsed = JSON.parse(raw) } catch { parsed = { clear: true } }
    if (typeof parsed.clear !== 'boolean') parsed.clear = true
    if (parsed.clear) return res.json({ clear: true })
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return res.json({ clear: true })
    res.json({ clear: false, questions: parsed.questions.slice(0, 4) })
  } catch (e) {
    console.error('/clarify error:', e)
    res.json({ clear: true })
  }
})

// ── POST /plan ─────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are a senior circuit designer writing the one-page design brief that goes out before the schematic is drawn. The reader is an engineer who wants to know your choices and whether they are sound.

Output JSON ONLY, in exactly this shape:
{
  "title": "string (Korean, <= 30 chars, names the actual topology)",
  "summary": "string (Korean, 1-2 sentences: what it does and how)",
  "topology": "string (Korean, <= 80 chars, the block-level structure)",
  "specs":  [ { "label": "string (Korean)", "value": "string with units" } ],
  "parts":  [ { "ref": "string", "type": "string (Korean)", "value": "string", "role": "string (Korean, why this part is here)" } ],
  "risks":  [ "string (Korean)" ]
}

Content rules:
- specs: 3-5 entries. Every value carries a unit. Include the numbers the user asked for
  and the ones they will ask about next (input, output, current, frequency, efficiency).
- parts: 4-6 entries — the parts that define the design, not every passive. Use standard
  reference designators (R, C, L, D, Q, U, SW, K, LS, BT, J, Y) numbered from 1.
  "value" is a real part number or E-series value.
- risks: 2-4 entries. Real failure modes of THIS circuit with the number attached —
  power dissipation, thermal headroom, current limits, polarity, stability, tolerance
  stack-up. Not generic safety advice.
- Any figure you state must follow from the parts you listed. Do not invent numbers.

Output the JSON object only. No markdown, no prose.`

app.post('/plan', async (req: Request, res: Response) => {
  const description = (req.body?.description || '').trim()
  if (!description) return res.status(400).json({ error: 'description required' })
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
      temperature: 0.3,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    })
    const raw = response.choices[0]?.message?.content || '{}'
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw) } catch { return res.status(500).json({ error: 'plan parse failed' }) }
    if (!Array.isArray(parsed.specs)) parsed.specs = []
    if (!Array.isArray(parsed.parts)) parsed.parts = []
    if (!Array.isArray(parsed.risks)) parsed.risks = []
    res.json(parsed)
  } catch (e) {
    console.error('/plan error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── POST /chat_edit ────────────────────────────────────────────────

app.post('/chat_edit', async (req: Request, res: Response) => {
  const { graph, message, history = [] } = req.body as {
    graph: NetGraph; message: string; history: { role: string; content: string }[]
  }
  if (!graph || !message) return res.status(400).json({ error: 'graph and message required' })

  const compSummary = (graph.components || []).map(c => `${c.ref}(${c.value || '?'})`).join(', ')
  const netSummary  = (graph.nets || []).map(n => `${n.name}:[${n.nodes.map(nd => nd.ref).join(',')}]`).join(', ')

  const systemPrompt = `You edit an existing schematic. Apply exactly what the user asks — no extra "improvements".

Current circuit:
- Components: ${compSummary || 'none'}
- Nets: ${netSummary || 'none'}

Rules:
- Only reference designators from the component list above. Never invent a ref.
- add_component: pick the next free number for that prefix (R, C, L, D, Q, U, SW, K,
  LS, BT, J, Y only) and give it a real value with units. Set "name" to the part type
  exactly as one of: R, C, CP (electrolytic, 1uF and above), L, LED, D, Q_NPN, Q_NMOS,
  NE555, REG, SW, Relay, Buzzer, Battery, Crystal, Conn_01x02 … Conn_01x10 — the PCB
  footprint is chosen from this name, and pins are numbered as in those parts
  (LED/D: 1=A 2=K, Q_NPN: 1=B 2=C 3=E, Q_NMOS: 1=G 2=D 3=S, CP: 1=+ 2=-).
- add_net / remove_net: "nodes" must list every ref+pin on that net, not just the new one.
- modify_component: change only the field the user named.
- If the request is ambiguous or names a part that does not exist, return an empty
  actions array and ask which one in the reply. Do not guess.
- If an edit breaks the circuit (removing the only current-limiting resistor, shorting a
  rail to ground), still apply it, but say so in one clause of the reply.

Always call the edit_circuit function. Reply in Korean, 1-2 sentences, stating what
changed.`

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: message },
  ]

  const tools = [{
    type: 'function' as const,
    function: {
      name: 'edit_circuit',
      description: 'Apply circuit edits and reply to the user',
      parameters: {
        type: 'object',
        properties: {
          reply: { type: 'string' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['remove_component','add_component','modify_component','add_net','remove_net'] },
                ref:   { type: 'string' },
                name:  { type: 'string' },
                value: { type: 'string' },
                nodes: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, pin: { type: 'string' } }, required: ['ref','pin'] } },
              },
              required: ['type'],
            },
          },
        },
        required: ['reply', 'actions'],
      },
    },
  }]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 25000)

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: 'edit_circuit' } },
      temperature: 0,
      max_tokens: 700,
      stream: true,
    }, { signal: abort.signal })

    let argsBuf = ''
    let sentReplyLen = 0

    for await (const chunk of stream) {
      const args = chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments
      if (!args) continue
      argsBuf += args

      const m = argsBuf.match(/^[^{]*\{"reply"\s*:\s*"((?:[^"\\]|\\.)*)/)
      if (m) {
        const decoded = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        if (decoded.length > sentReplyLen) {
          res.write(`event: text\ndata: ${JSON.stringify(decoded.slice(sentReplyLen))}\n\n`)
          sentReplyLen = decoded.length
        }
      }
    }

    let reply = '완료했습니다.', actions: ChatAction[] = []
    try {
      const parsed = JSON.parse(argsBuf)
      reply = parsed.reply || reply
      actions = (parsed.actions || []).filter((a: ChatAction) => a?.type)
    } catch (_) {}

    res.write(`event: done\ndata: ${JSON.stringify({ reply, actions })}\n\n`)
    res.end()
  } catch (e) {
    const msg = abort.signal.aborted ? '요청 시간이 초과됐습니다.' : (e as Error).message
    res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`)
    res.end()
  } finally {
    clearTimeout(timeout)
  }
})

// ── POST /generate ─────────────────────────────────────────────────

app.post('/generate', optionalAuth as any, async (req: AuthRequest, res: Response) => {
  const description = (req.body?.description || '').trim()
  if (!description) return res.status(400).json({ error: 'Please enter a circuit description.' })

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  if (res.socket) res.socket.setNoDelay(true)

  const abort = new AbortController()
  let clientClosed = false
  res.on('close', () => { clientClosed = true; abort.abort() })

  const heartbeat = setInterval(() => {
    if (!clientClosed) res.write(': heartbeat\n\n')
  }, 10000)

  try {
    if (abort.signal.aborted) return res.end()
    res.write(sse('status', '🔍 Analysing circuit requirements...'))
    const sourceUrls: string[] = []

    if (abort.signal.aborted) return res.end()
    res.write(sse('status', '🤖 GPT-4o is analysing and generating the circuit...'))
    const userMsg =
      `Circuit request: ${description}\n\n` +
      'Design this to standard professional practice. Include every component the board ' +
      'needs to actually work — decoupling, current limiting, bulk capacitance, ' +
      'protection — not just the parts named in the request.'

    let raw = ''
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ]

    const genTimeout = setTimeout(() => abort.abort(), 90000)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const axiosRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o',
          messages,
          temperature: 0.1,
          max_tokens: 2500,
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 88000,
          signal: abort.signal as AbortSignal,
        })
        raw = (axiosRes.data.choices[0].message.content as string).trim()
        if (stripFences(raw).startsWith('from skidl')) break
        if (attempt === 0) {
          messages.push({ role: 'assistant', content: raw })
          messages.push({ role: 'user', content: "Output only skidl Python code starting with 'from skidl import *'." })
        }
      }
    } finally {
      clearTimeout(genTimeout)
    }

    let [skidlCode, guide] = raw.includes('---GUIDE---')
      ? raw.split('---GUIDE---', 2).map((s: string) => s.trim())
      : [raw.trim(), '']

    skidlCode = stripFences(skidlCode)

    if (abort.signal.aborted) return res.end()
    res.write(sse('status', '⚙️ Generating netlist...'))
    let outputPath: string
    try {
      outputPath = await runSkidl(skidlCode)
    } catch (firstErr) {
      if (abort.signal.aborted) return res.end()
      res.write(sse('status', '🔧 Fixing code and retrying...'))
      try {
        const fixMessages = [
          { role: 'system' as const, content: SYSTEM_PROMPT },
          { role: 'user' as const, content: userMsg },
          { role: 'assistant' as const, content: raw },
          { role: 'user' as const, content: `The code above failed:\n${(firstErr as Error).message}\n\nFix and output corrected code + ---GUIDE--- + Korean guide.` },
        ]
        const retryTimeout = setTimeout(() => abort.abort(), 45000)
        let fixAxiosRes
        try {
          fixAxiosRes = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o', messages: fixMessages, temperature: 0.05, max_tokens: 2500,
          }, {
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 43000,
            signal: abort.signal as AbortSignal,
          })
        } finally { clearTimeout(retryTimeout) }
        const fixRaw = (fixAxiosRes.data.choices[0].message.content as string).trim()
        const [fixCodeRaw, fixGuide] = fixRaw.includes('---GUIDE---')
          ? fixRaw.split('---GUIDE---', 2).map((s: string) => s.trim())
          : [fixRaw.trim(), guide]
        const fixCode = stripFences(fixCodeRaw)
        skidlCode = fixCode
        if (fixGuide) guide = fixGuide
        outputPath = await runSkidl(skidlCode)
      } catch (retryErr) {
        res.write(sse('error', JSON.stringify({
          message: 'skidl execution error',
          detail: (retryErr as Error).message,
          code: skidlCode,
        })))
        return res.end()
      }
    }

    const filename = basename(outputPath)
    let graph: NetGraph = { components: [], nets: [] }
    try {
      const netContent = readFileSync(outputPath, 'utf8')
      graph = parseNetlist(netContent)
    } catch (_) {}

    // Auto-save session to DB if user is logged in
    if (req.user?.id && supabase) {
      supabase.from('sessions').insert({
        user_id: req.user.id,
        prompt: description,
        code: skidlCode,
        guide,
        graph,
        filename,
      }).then(() => { /* fire-and-forget */ }, console.error)
    }

    res.write(sse('done', JSON.stringify({ code: skidlCode, guide, filename, sources: sourceUrls, graph })))
  } catch (e) {
    if (!clientClosed) {
      const msg = abort.signal.aborted
        ? '회로 생성 시간이 초과됐습니다.'
        : `Server error: ${(e as Error).message}`
      res.write(sse('error', JSON.stringify({ message: msg })))
    }
  } finally {
    clearInterval(heartbeat)
  }

  res.end()
})

// ── POST /test_code ────────────────────────────────────────────────

app.post('/test_code', async (req: Request, res: Response) => {
  const code = (req.body?.code || '').trim()
  if (!code) return res.status(400).json({ error: 'No code provided.' })
  try {
    const outputPath = await runSkidl(code)
    const filename = basename(outputPath)
    let graph: NetGraph = { components: [], nets: [] }
    try {
      const netContent = readFileSync(outputPath, 'utf8')
      graph = parseNetlist(netContent)
    } catch (_) {}
    res.json({ filename, graph })
  } catch (e) {
    res.json({ error: (e as Error).message })
  }
})

// ── GET /download/:filename ────────────────────────────────────────

app.get('/download/:filename', (req: Request, res: Response) => {
  const filename = basename(req.params['filename'] as string)
  const filePath = join(OUTPUTS_DIR, filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found.' })
  res.download(filePath, 'schematic.net')
})

// ── POST /generate_pcb ─────────────────────────────────────────────

type PcbStyle = 'smd' | 'tht'

interface PcbSummary {
  components: number
  nets: number
  unmapped: { ref: string; part: string; reason: string }[]
  warnings: string[]
  style: PcbStyle
  board: { w: number; h: number }
  boardJson: string
}

/** Run pcb_generator.py; its last stdout line is a JSON summary. */
function runPcbGenerator(netPath: string, pcbPath: string, style: PcbStyle): Promise<PcbSummary> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [join(process.cwd(), 'pcb_generator.py'), netPath, pcbPath, '--style', style])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('PCB generation timed out')) }, 30000)
    proc.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(stderr || 'PCB generation failed'))
      try {
        const last = stdout.trim().split('\n').pop() || '{}'
        resolve(JSON.parse(last) as PcbSummary)
      } catch {
        reject(new Error('PCB generator returned no summary'))
      }
    })
  })
}

const pcbStyle = (s: unknown): PcbStyle => (s === 'tht' ? 'tht' : 'smd')

app.post('/generate_pcb', async (req: Request, res: Response) => {
  const { filename, style } = req.body || {}
  if (!filename) return res.status(400).json({ error: 'No netlist filename provided.' })

  const netPath = join(OUTPUTS_DIR, basename(filename as string))
  if (!existsSync(netPath)) return res.status(404).json({ error: 'Netlist file not found.' })

  const pcbFilename = basename(filename as string, '.net') + '.kicad_pcb'
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  try {
    const summary = await runPcbGenerator(netPath, pcbPath, pcbStyle(style))
    res.json({ pcbFilename, summary, message: 'PCB layout generated successfully' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── POST /generate_pcb_from_graph ─────────────────────────────────

app.post('/generate_pcb_from_graph', async (req: Request, res: Response) => {
  const { graph, baseName, style } = req.body || {}
  if (!graph) return res.status(400).json({ error: 'No graph provided.' })

  const uid = randomUUID().slice(0, 8)
  const netFilename = `${(baseName as string) || 'edited'}_${uid}.net`
  const netPath = join(OUTPUTS_DIR, netFilename)
  const pcbFilename = netFilename.replace('.net', '.kicad_pcb')
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  try {
    writeFileSync(netPath, graphToNetlist(graph as NetGraph), 'utf8')
    const summary = await runPcbGenerator(netPath, pcbPath, pcbStyle(style))
    res.json({ pcbFilename, summary, message: 'PCB layout generated from edited graph' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── GET /download_pcb/:filename ────────────────────────────────────

app.get('/download_pcb/:filename', (req: Request, res: Response) => {
  const filename = basename(req.params['filename'] as string)
  const filePath = join(OUTPUTS_DIR, filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found.' })
  res.download(filePath, filename)
})

// ── POST /mouser_search ────────────────────────────────────────────

interface MockPreset { mfg: string; desc: string; price: number; partFmt: string }

function mockMouserPart(comp: ComponentEntry) {
  const prefix = comp.ref.replace(/\d+/g, '')
  const v = comp.value || ''
  const presets: Record<string, MockPreset> = {
    R:  { mfg: 'Yageo',             desc: `${v} ±1% 1/4W chip resistor`, price: 0.04, partFmt: 'RC0805FR-07' },
    C:  { mfg: 'Murata',            desc: `${v} 50V X7R MLCC`,           price: 0.08, partFmt: 'GRM21BR71H' },
    L:  { mfg: 'TDK',               desc: `${v} shielded inductor`,      price: 0.42, partFmt: 'CLF7045T-' },
    D:  { mfg: 'Lite-On',           desc: `LED ${v} 5mm`,                price: 0.12, partFmt: 'LTL-1HE' },
    Q:  { mfg: 'ON Semiconductor',  desc: `Transistor ${v}`,             price: 0.16, partFmt: 'BC547B-' },
    U:  { mfg: 'Texas Instruments', desc: `IC ${v}`,                     price: 1.20, partFmt: '595-' },
    SW: { mfg: 'Omron',             desc: `Tactile switch ${v}`,         price: 0.28, partFmt: 'B3F-1000' },
    K:  { mfg: 'Omron',             desc: `Relay ${v} 5V coil`,          price: 1.85, partFmt: 'G5V-1-DC' },
    LS: { mfg: 'CUI Devices',       desc: `Buzzer ${v}`,                 price: 1.45, partFmt: 'CMT-' },
    BT: { mfg: 'Keystone',          desc: `Battery holder ${v}`,         price: 0.95, partFmt: 'BH-' },
    F:  { mfg: 'Bel Fuse',          desc: `Fuse ${v}`,                   price: 0.55, partFmt: '0451-' },
  }
  const preset = presets[prefix] || { mfg: 'Generic', desc: v || prefix, price: 0.5, partFmt: 'GEN-' }
  const seedNum = Math.abs([...comp.ref].reduce((a, c) => a * 31 + c.charCodeAt(0), 0)) % 9000 + 1000
  const mouserPart = preset.partFmt + seedNum
  const stock = (seedNum * 13) % 50000 + 500
  return {
    ref: comp.ref,
    value: comp.value,
    mouserPart,
    mfgPart: preset.partFmt.split('-')[0] + seedNum,
    manufacturer: preset.mfg,
    description: preset.desc,
    price: `$${preset.price.toFixed(2)}`,
    priceNum: preset.price,
    url: `https://kr.mouser.com/Search/Refine?Keyword=${encodeURIComponent(v || preset.partFmt)}`,
    imageUrl: '',
    stock: String(stock),
    mock: true,
  }
}

app.post('/mouser_search', async (req: Request, res: Response) => {
  const { components } = req.body || {}
  if (!components?.length) return res.status(400).json({ error: 'No components' })

  const apiKey = process.env.MOUSER_API_KEY
  if (!apiKey) {
    return res.json({ results: (components as ComponentEntry[]).map(mockMouserPart), cartUrl: null, mockMode: true })
  }

  const results = []
  for (const comp of components as ComponentEntry[]) {
    if (!comp.value || comp.value === '-') {
      results.push({ ref: comp.ref, value: comp.value, mouserPart: null })
      continue
    }
    const prefix = comp.ref.replace(/\d+/g, '')
    const typeMap: Record<string, string> = {
      R: 'resistor', C: 'capacitor', L: 'inductor', D: 'diode', Q: 'transistor',
      U: '', SW: 'switch', LS: 'buzzer', BT: 'battery holder', K: 'relay',
    }
    const keyword = `${comp.value} ${typeMap[prefix] || ''} SMD`.trim()
    try {
      const resp = await axios.post(
        `https://api.mouser.com/api/v1/search/keyword?apiKey=${apiKey}`,
        { SearchByKeywordRequest: { keyword, records: 1, startingRecord: 0, searchOptions: '1', searchWithYourSignUpLanguage: '' } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      )
      const parts = resp.data?.SearchResults?.Parts || []
      if (parts.length > 0) {
        const p = parts[0]
        results.push({
          ref: comp.ref, value: comp.value,
          mouserPart: p.MouserPartNumber, mfgPart: p.ManufacturerPartNumber,
          manufacturer: p.Manufacturer, description: p.Description,
          price: p.PriceBreaks?.[0]?.Price || '',
          url: p.ProductDetailUrl, imageUrl: p.ImagePath, stock: p.Availability,
        })
      } else {
        results.push({ ref: comp.ref, value: comp.value, mouserPart: null })
      }
    } catch (e) {
      results.push({ ref: comp.ref, value: comp.value, mouserPart: null, error: (e as Error).message })
    }
  }

  const cartParts = results.filter(r => r.mouserPart)
  const cartUrl = cartParts.length > 0
    ? `https://kr.mouser.com/Cart/AddToCart?PartsString=${encodeURIComponent(cartParts.map(p => `${p.mouserPart}|1`).join('||'))}`
    : null

  res.json({ results, cartUrl })
})

// ── POST /generate_gerber (local KiCad CLI only) ───────────────────

// KICAD_CLI_PATH wins; otherwise the per-user Windows install, otherwise PATH.
const WIN_KICAD_CLI = join(process.env.LOCALAPPDATA || '', 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
const KICAD_CLI = process.env.KICAD_CLI_PATH || (existsSync(WIN_KICAD_CLI) ? WIN_KICAD_CLI : 'kicad-cli')

function runKicadCli(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(KICAD_CLI, args)
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${label} timed out`)) }, 30000)
    // Without this handler a missing kicad-cli crashes the whole server.
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? 'KiCad (kicad-cli) is not installed on this server' : e.message))
    })
    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(stderr || `${label} failed`))
      resolve()
    })
  })
}

app.post('/generate_gerber', async (req: Request, res: Response) => {
  const { pcbFilename } = req.body || {}
  if (!pcbFilename) return res.status(400).json({ error: 'No PCB filename provided.' })

  const pcbPath = join(OUTPUTS_DIR, basename(pcbFilename as string))
  if (!existsSync(pcbPath)) return res.status(404).json({ error: 'PCB file not found.' })

  const gerberDir = join(OUTPUTS_DIR, basename(pcbFilename as string, '.kicad_pcb') + '_gerber')
  if (!existsSync(gerberDir)) mkdirSync(gerberDir)

  try {
    await runKicadCli(['pcb', 'export', 'gerbers', '--output', gerberDir, pcbPath], 'Gerber export')
    await runKicadCli(['pcb', 'export', 'drill', '--output', gerberDir + '/', pcbPath], 'Drill export')

    const files = readdirSync(gerberDir)
    res.json({ gerberDir: basename(gerberDir), files, message: 'Gerber files generated' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── GET /download_gerber_file/:dir/:filename ───────────────────────

app.get('/download_gerber_file/:dir/:filename', (req: Request, res: Response) => {
  const dir = basename(req.params['dir'] as string)
  const filename = basename(req.params['filename'] as string)
  const filePath = join(OUTPUTS_DIR, dir, filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found.' })
  res.download(filePath, filename)
})

// ── GET /health ────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '2.0.0', db: !!process.env.SUPABASE_URL })
})

// ── SPA fallback ───────────────────────────────────────────────────

if (existsSync(distPath)) {
  app.get('/{*path}', (_req: Request, res: Response) => {
    res.sendFile(join(distPath, 'index.html'))
  })
}

const PORT = Number(process.env.PORT) || 8002
app.listen(PORT, () => console.log(`SchemaForge v2 running on http://localhost:${PORT}`))
