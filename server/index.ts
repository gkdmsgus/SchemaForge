import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { spawn } from 'child_process'
import {
  mkdirSync, existsSync,
  readdirSync, writeFileSync, readFileSync, unlinkSync,
} from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import {
  MAX_ROUNDS, applyEdit, askModel, backup, better, describeBoard, describeOutcome, metricsOf, precheck, splitEdit,
  readBoard, roundFeedback, runGenerator,
  type AiRound, type Metrics, type Overrides,
} from './ai_layout'
import { runSkidl as runSkidlIn } from './skidl_run'
import {
  errorKeys, errorSites, fixableErrors, repairErc, runErc, splitOutput, stripFences, stubErcFix,
  type ErcFinding, type ErcRun,
} from './erc_repair'
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
    .select('id, prompt, code, guide, graph, filename, created_at')
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
- Every pin in a Part's pins=[...] list needs its own += line. Before generate_netlist(),
  walk each IC pin by pin; a pin with no += line is floating.
- The power source is a real part (BT for a battery, J for a jack/USB inlet), never a
  bare net with nothing driving it.

Values:
- Real E12/E24 values with units: '4.7k', '470', '100nF', '10uF', '1N4148', 'NE555'.
- Bare numbers ('10000') and placeholders ('R1', 'resistor') are wrong.
- An LED's value is its colour word: 'RED', 'GREEN', 'YELLOW', 'BLUE' or 'WHITE' — never
  'LED' or a blank. Use 'RED' when the user names no colour. Size its resistor for about
  2 V forward drop (red, yellow) or about 3 V (green, blue, white) at 10-20 mA.
- Include what a working board actually needs: a decoupling cap on every IC supply pin,
  a current-limiting resistor on every LED, a bulk cap on the input rail, a flyback
  diode across any relay or motor, a pull-up on any open-drain or reset line.
- Size the parts from the user's numbers. If they ask for 1 Hz or 3.3 V or 15 mA, the
  values you pick must actually produce that.

IC wiring — the pins most often left floating:
- NE555: pin 1 GND → GND. Pin 8 VCC → VCC, with a 100nF capacitor from VCC to GND.
  Pin 4 RESET → VCC (u1['RESET'] += vcc) unless the user asked for a reset input; never
  leave it open, never tie it to GND or OUT.
  Pin 5 CTRL → a 10nF capacitor to GND; never tie CTRL straight to VCC or GND.
  Astable (blinker, oscillator, tone): pin 2 TRIG and pin 6 THRES on one net, the timing
  capacitor from that net to GND, RA from VCC to pin 7 DISCH, RB from DISCH to
  TRIG/THRES. f = 1.44 / ((RA + 2·RB) · C).
  Pin 3 OUT drives the load through its own series resistor.

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

/**
 * The ERC repair's one model call (the current code and guide as its previous answer). Only its own
 * axios timeout: a slow answer fails the repair and keeps the netlist we have, it never aborts the
 * whole generation. `signal` is the request's, so a closed tab still cancels it.
 */
async function askErcFix(userMsg: string, code: string, guide: string, feedback: string, signal: AbortSignal): Promise<string> {
  if (process.env.SF_AI_STUB === '1') return stubErcFix(code)
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
      { role: 'assistant', content: `${code}\n---GUIDE---\n${guide}` },
      { role: 'user', content: feedback },
    ],
    temperature: 0.05,
    max_tokens: 2500,
  }, {
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 45000,
    signal,
  })
  return String(r.data.choices[0]?.message?.content || '').trim()
}

/** What /generate reports about the netlist check in its done event (src/types.ts GenerateResult.erc). */
interface GenerateRepair { tried: boolean; kept: boolean; before: number; after: number; note: string }
interface GenerateErc { findings: ErcFinding[] | null; reason?: string; repair: GenerateRepair | null }

/** SSE data is one line (see sse()); fold any newline in a message. */
const flat = (s: string) => s.replace(/\s*\r?\n\s*/g, ' / ').trim()

/** Run skidl code (secrets stripped from its environment, temp folder removed); the netlist lands in outputs/. */
const runSkidl = (code: string): Promise<string> => runSkidlIn(code, OUTPUTS_DIR)

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
  // ref.pin: an edit that lists a net's pins copies the real ones instead of guessing them
  const netSummary  = (graph.nets || []).map(n => `${n.name}:[${n.nodes.map(nd => `${nd.ref}.${nd.pin}`).join(',')}]`).join(', ')

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
- add_net / remove_net: always set "name" to the net's name. To connect a pin to an existing
  net, use add_net with that net's name from the list above. "nodes" must list every ref+pin on
  that net, not just the new one. Pins are the numbers shown as ref.pin above (write "2", not "K" or "-").
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
                name:  { type: 'string', description: 'add_component: the part type (R, LED, ...). add_net / remove_net: the net name (required; an existing net from the list to add pins to it)' },
                value: { type: 'string' },
                nodes: { type: 'array', description: 'add_net: every ref+pin on the net', items: { type: 'object', properties: { ref: { type: 'string' }, pin: { type: 'string', description: 'pin number as in ref.pin' } }, required: ['ref','pin'] } },
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
  // The '자동 재시도' setting: one model fix for a code error and one for netlist (ERC) errors.
  // Older clients send nothing and keep both.
  const autoFix = req.body?.autoFix !== false

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

    let { code: skidlCode, guide } = splitOutput(raw, '')

    if (abort.signal.aborted) return res.end()
    res.write(sse('status', '⚙️ Generating netlist...'))
    let outputPath: string
    try {
      outputPath = await runSkidl(skidlCode)
    } catch (firstErr) {
      if (abort.signal.aborted) return res.end()
      if (!autoFix) {
        res.write(sse('error', JSON.stringify({
          message: 'skidl execution error',
          detail: (firstErr as Error).message,
          code: skidlCode,
        })))
        return res.end()
      }
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
        const fix = splitOutput((fixAxiosRes.data.choices[0].message.content as string).trim(), guide)
        skidlCode = fix.code
        guide = fix.guide
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

    // Netlist check (ERC) before any PCB, with at most one model repair. Every status names the
    // netlist (App.tsx detectStep keeps the wizard on that step) and stays on one line (sse()).
    if (abort.signal.aborted) return res.end()
    res.write(sse('status', 'ERC: netlist 점검 중...'))
    let erc: ErcRun = await runErc(outputPath, process.cwd())
    let repair: GenerateRepair | null = null
    if (abort.signal.aborted) return res.end()
    if (!erc.ok) {
      res.write(sse('status', `ERC: netlist 점검을 돌리지 못했습니다 (${flat(erc.reason)})`))
    } else {
      const errors = errorKeys(fixableErrors(erc.findings)).length
      const warnings = erc.findings.length - erc.findings.filter(f => f.severity === 'error').length
      if (!errors) {
        res.write(sse('status', `ERC: netlist 오류 없음${warnings ? `, 경고 ${warnings}개` : ''}`))
      } else if (!autoFix) {
        repair = { tried: false, kept: false, before: errors, after: errors, note: '자동 수정이 꺼져 있습니다' }
        res.write(sse('status', `ERC: netlist 오류 ${errors}개(${errorSites(erc.findings)}). 자동 수정이 꺼져 있어 그대로 둡니다`))
      } else {
        res.write(sse('status', `ERC: netlist 오류 ${errors}개(${errorSites(erc.findings)})를 한 번 고칩니다...`))
        const code = skidlCode, g = guide
        const r = await repairErc({ code, guide: g, netPath: outputPath, erc }, {
          ask: feedback => askErcFix(userMsg, code, g, feedback, abort.signal),
          run: c => runSkidl(c),
          erc: p => runErc(p, process.cwd()),
        })
        if (r.discard) try { unlinkSync(r.discard) } catch { /* already gone */ }
        if (abort.signal.aborted) return res.end()
        if (r.kept) ({ code: skidlCode, guide, netPath: outputPath, erc } = r)
        repair = { tried: true, kept: r.kept, before: r.before, after: r.after, note: r.note }
        res.write(sse('status', r.kept
          ? `ERC: netlist를 고쳤습니다 (오류 ${r.before} → ${r.after})`
          : `ERC: 원래 netlist를 유지합니다 (${flat(r.note)})`))
      }
    }

    const filename = basename(outputPath)
    let graph: NetGraph = { components: [], nets: [] }
    try {
      const netContent = readFileSync(outputPath, 'utf8')
      graph = parseNetlist(netContent)
    } catch (_) {}

    // The session row is saved by the client after 'done' (POST /sessions, with code and guide), which
    // also keeps its id for the chat; saving here too made two rows per generation.

    const ercDone: GenerateErc = erc.ok
      ? { findings: erc.findings, repair }
      : { findings: null, reason: erc.reason, repair }
    res.write(sse('done', JSON.stringify({ code: skidlCode, guide, filename, sources: sourceUrls, graph, erc: ercDone })))
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
// Runs the code tab's code exactly as sent (untrimmed, so traceback line numbers match the editor)
// and reports the netlist check. The code is the user's own: no model repair here.

app.post('/test_code', requireAuth as any, async (req: AuthRequest, res: Response) => {
  const code: string = typeof req.body?.code === 'string' ? req.body.code : ''
  if (!code.trim()) return res.status(400).json({ error: 'No code provided.' })
  let outputPath: string
  try {
    outputPath = await runSkidl(code)
  } catch (e) {
    return res.json({ error: (e as Error).message })
  }
  const drop = (error: string) => {
    try { unlinkSync(outputPath) } catch { /* already gone */ }
    return res.json({ error })
  }
  let graph: NetGraph
  try {
    graph = parseNetlist(readFileSync(outputPath, 'utf8'))
  } catch (e) {
    return drop(`The netlist could not be read: ${(e as Error).message}`)
  }
  if (!graph.components.length) return drop('The netlist has no parts.')
  const filename = basename(outputPath)
  const erc = await runErc(outputPath, process.cwd())
  res.json(erc.ok ? { filename, graph, erc: erc.findings } : { filename, graph, erc: null, ercError: erc.reason })
})

// ── POST /erc_graph ────────────────────────────────────────────────
// The netlist check on a circuit the AI editor changed (the schematic graph, not code): the same
// check /generate and /test_code run, so a fix made by chat shows whether it fixed anything.
// Report-only; the netlist is written to a temp file and removed.

/** a name as the netlist can carry it inside its quotes: no quote, backslash or line break, at most 64 characters */
const netName = (v: unknown) => String(v ?? '').replace(/["\\\r\n\t]/g, '').trim().slice(0, 64)

app.post('/erc_graph', async (req: Request, res: Response) => {
  const g = (req.body || {}).graph as NetGraph | undefined
  if (!g || !Array.isArray(g.components) || !Array.isArray(g.nets) || g.components.length > 300 || g.nets.length > 600
    || g.nets.some(n => !Array.isArray(n?.nodes) || n.nodes.length > 300)) {
    return res.status(400).json({ error: 'graph with components and nets required' })
  }
  // names an AI edit wrote ("LED (red)", pin "+") are cleaned, not refused; empty refs and nets are dropped
  const clean: NetGraph = {
    components: g.components.map(c => ({ ref: netName(c?.ref), value: netName(c?.value), ...(c?.name ? { name: netName(c.name) } : {}) })).filter(c => c.ref),
    nets: g.nets.map(n => ({ name: netName(n.name), nodes: n.nodes.map(nd => ({ ref: netName(nd?.ref), pin: netName(nd?.pin) })).filter(nd => nd.ref && nd.pin) }))
      .filter(n => n.name && n.nodes.length),
  }
  const netPath = join(tmpdir(), `sf_ercgraph_${randomUUID().slice(0, 8)}.net`)
  try {
    writeFileSync(netPath, graphToNetlist(clean), 'utf8')
    const erc = await runErc(netPath, process.cwd())
    res.json(erc.ok ? { erc: erc.findings } : { erc: null, ercError: erc.reason })
  } finally {
    try { unlinkSync(netPath) } catch { /* already gone */ }
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
    res.json({ pcbFilename, summary, drc: await runDrc(pcbPath), message: 'PCB layout generated successfully' })
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
    res.json({ pcbFilename, summary, drc: await runDrc(pcbPath), message: 'PCB layout generated from edited graph' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

interface DrcResult {
  available: boolean
  reason?: string
  seconds?: number
  violations?: { type: string; severity: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }[]
  unconnected?: number
  errors?: number
  warnings?: number
}

/** Run KiCad's design rule check on a finished board. Never throws. */
async function runDrc(pcbPath: string): Promise<DrcResult> {
  const out = join(tmpdir(), `sf_drc_${randomUUID().slice(0, 8)}.json`)
  const t0 = Date.now()
  const seconds = () => Math.round((Date.now() - t0) / 100) / 10
  try {
    // A warm DRC takes about 4 s here; the first call after the server starts has timed out at 30 s.
    await runKicadCli(['pcb', 'drc', '--format', 'json', '--severity-all', '--output', out, pcbPath], 'DRC', 90000)
    const d = JSON.parse(readFileSync(out, 'utf8')) as {
      violations: { severity: string }[]; unconnected_items: unknown[]
    }
    const violations = d.violations as DrcResult['violations']
    return {
      available: true,
      seconds: seconds(),
      violations,
      unconnected: Array.isArray(d.unconnected_items) ? d.unconnected_items.length : 0,
      errors: (violations || []).filter(v => v.severity === 'error').length,
      warnings: (violations || []).filter(v => v.severity === 'warning').length,
    }
  } catch (e) {
    return { available: false, reason: (e as Error).message, seconds: seconds() }
  } finally {
    try { unlinkSync(out) } catch { /* nothing to clean up */ }
  }
}

/**
 * Stage 4: let the model improve the finished board, but keep a round only when the
 * numbers improve. Returns the final done payload and DRC, or null if nothing was kept.
 */
async function runAiLoop(
  netPath: string, pcbPath: string, style: PcbStyle,
  doneEvent: Record<string, unknown>, drc: DrcResult,
  emit: (r: AiRound) => void,
): Promise<{ done: Record<string, unknown>; drc: DrcResult } | null> {
  const jsonPath = pcbPath.replace(/\.kicad_pcb$/, '') + '.board.json'
  try {
    // Every round is judged on DRC errors, so an unavailable DRC must not read as "0 errors".
    if (!drc.available) drc = await runDrc(pcbPath)
    if (!drc.available) throw new Error(`DRC를 돌리지 못해 판정할 수 없습니다 (${drc.reason})`)
    let board = readBoard(jsonPath)
    let summary = (doneEvent.summary || {}) as Record<string, unknown>
    let best = metricsOf(summary, drc.errors ?? 0, board)
    let bestDrc = drc
    let bestDone = doneEvent
    const ov: Overrides = {
      parts: Object.fromEntries(board.parts.map(p => [p.ref, [p.x, p.y, p.rot] as [number, number, number]])),
      net_width: { ...((summary.net_width as Record<string, number>) || {}) },
    }
    const history: string[] = []
    const feedback: string[] = []   // what happened to each earlier proposal, fed back to the model
    let kept = false

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const drcTypes = (bestDrc.violations || []).map(v => v.type)
      const edit = await askModel(describeBoard(board, best, drcTypes) + roundFeedback(feedback), history)
      history.push(JSON.stringify(edit))
      if (edit.stop) {
        emit({ round, reason: edit.reason || '더 고칠 것이 없습니다', actions: edit, before: best, kept: false, note: 'stop' })
        break
      }
      // A proposal often mixes a width change with a move. Judge them one after the other so a good
      // width change is not thrown away with a bad move (or a bad move carried in by a good width change).
      for (const [part, sub] of splitEdit(edit)) {
        const label = part === 'width' ? '선 폭' : '배치'
        const trial: Overrides = { parts: { ...ov.parts }, net_width: { ...ov.net_width } }
        const notes = applyEdit(trial, sub, board)
        // Reject collisions before paying for a reroute and DRC, and tell the model exactly what hit what.
        const problems = precheck(board, trial)
        if (problems.length) {
          const why = `rejected before routing: ${problems.join('; ')}`
          feedback.push(describeOutcome(round, sub, best, undefined, false, why))
          emit({ round, part, reason: edit.reason || '', actions: sub, before: best, kept: false,
                 note: [...notes, `${label} 사전 검사 불합격: ${problems.join(', ')}`].join(', ') })
          continue
        }
        const restore = backup([pcbPath, jsonPath])
        let after: Metrics | undefined
        let note = notes.join(', ')
        try {
          const s2 = await runGenerator(netPath, pcbPath, style, trial, process.cwd())
          const drc2 = await runDrc(pcbPath)
          if (!drc2.available) throw new Error(`DRC 실패로 판정 불가 (${drc2.reason})`)
          after = metricsOf(s2, drc2.errors ?? 0, readBoard(jsonPath))
          if (better(after, best)) {
            const before = best
            best = after
            bestDrc = drc2
            bestDone = { ...doneEvent, summary: s2, board: readBoard(jsonPath) }
            board = readBoard(jsonPath)
            ov.parts = trial.parts
            ov.net_width = trial.net_width
            kept = true
            feedback.push(describeOutcome(round, sub, before, after, true))
            emit({ round, part, reason: edit.reason || '', actions: sub, before, after, kept: true, note })
            continue
          }
          note = note ? `${note} · 개선 없음` : '개선 없음'
        } catch (e) {
          note = `적용 실패: ${(e as Error).message}`
        }
        restore()                                   // put the previous board back
        feedback.push(describeOutcome(round, sub, best, after, false))
        emit({ round, part, reason: edit.reason || '', actions: sub, before: best, after, kept: false, note })
      }
    }
    return kept ? { done: bestDone, drc: bestDrc } : null
  } catch (e) {
    emit({ round: 0, reason: `AI 다듬기를 건너뜁니다: ${(e as Error).message}`, actions: {},
           before: metricsOf((doneEvent.summary || {}) as Record<string, unknown>, drc.errors ?? 0), kept: false })
    return null
  }
}

// ── GET /board_model ───────────────────────────────────────────────
// KiCad's real board geometry and component models as binary glTF. The browser
// loads this once and renders it with WebGL, so rotation/zoom stay interactive.
app.get('/board_model', async (req: Request, res: Response) => {
  const file = basename(String(req.query.pcb || ''))
  if (!file.endsWith('.kicad_pcb')) return res.status(400).json({ error: 'pcb must be a .kicad_pcb file' })
  const pcbPath = join(OUTPUTS_DIR, file)
  if (!existsSync(pcbPath)) return res.status(404).json({ error: 'board not found' })
  const out = join(tmpdir(), `sf_model_${randomUUID().slice(0, 8)}.glb`)
  try {
    await runKicadCli(['pcb', 'export', 'glb', '--output', out, '--force',
      '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen',
      '--include-soldermask', pcbPath], '3D model export', 180000)
    res.setHeader('Content-Type', 'model/gltf-binary')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(readFileSync(out))
  } catch (e) {
    res.status(503).json({ error: (e as Error).message })
  } finally {
    try { unlinkSync(out) } catch { /* already gone */ }
  }
})

// ── GET /render_board ──────────────────────────────────────────────
// KiCad's own 3D renderer, for the photo view next to the schematic-style board.
// ?pcb=<file in outputs>&rot=X,Y,Z&w=&h=  -> image/png
app.get('/render_board', async (req: Request, res: Response) => {
  const file = basename(String(req.query.pcb || ''))
  if (!file.endsWith('.kicad_pcb')) return res.status(400).json({ error: 'pcb must be a .kicad_pcb file' })
  const pcbPath = join(OUTPUTS_DIR, file)
  if (!existsSync(pcbPath)) return res.status(404).json({ error: 'board not found' })
  const rot = /^-?\d{1,3},-?\d{1,3},-?\d{1,3}$/.test(String(req.query.rot || '')) ? String(req.query.rot) : '-30,0,35'
  const side = String(req.query.side || 'top') === 'bottom' ? 'bottom' : 'top'
  const w = Math.min(2000, Math.max(400, Number(req.query.w) || 1400))
  const h = Math.min(1400, Math.max(300, Number(req.query.h) || 900))
  const out = join(tmpdir(), `sf_render_${randomUUID().slice(0, 8)}.png`)
  try {
    await runKicadCli(['pcb', 'render', '--output', out, '--width', String(w), '--height', String(h),
      '--quality', 'high', '--floor', '--perspective', '--rotate', rot, '--side', side,
      '--background', 'opaque', pcbPath], '3D render', 180000)
    const png = readFileSync(out)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store')
    res.send(png)
  } catch (e) {
    res.status(503).json({ error: (e as Error).message })
  } finally {
    try { unlinkSync(out) } catch { /* already gone */ }
  }
})

// ── POST /generate_pcb_stream (SSE) ────────────────────────────────
// Streams the placement as it happens: parts (local geometry) → init → frame… → done.
// Body: { filename } for a generated netlist, or { graph, baseName } for an edited one; plus style.

app.post('/generate_pcb_stream', (req: Request, res: Response) => {
  const { filename, graph, baseName, style, ai } = req.body || {}
  const useAi = ai === true && (process.env.SF_AI_STUB === '1' || !!process.env.OPENAI_API_KEY)
  let netPath: string
  let pcbFilename: string
  if (graph) {
    const netFilename = `${(baseName as string) || 'edited'}_${randomUUID().slice(0, 8)}.net`
    netPath = join(OUTPUTS_DIR, netFilename)
    writeFileSync(netPath, graphToNetlist(graph as NetGraph), 'utf8')
    pcbFilename = netFilename.replace('.net', '.kicad_pcb')
  } else if (filename) {
    netPath = join(OUTPUTS_DIR, basename(filename as string))
    if (!existsSync(netPath)) return res.status(404).json({ error: 'Netlist file not found.' })
    pcbFilename = basename(filename as string, '.net') + '.kicad_pcb'
  } else {
    return res.status(400).json({ error: 'filename or graph required' })
  }
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  if (res.socket) res.socket.setNoDelay(true)

  const proc = spawn('python', [join(process.cwd(), 'pcb_generator.py'), netPath, pcbPath,
    '--style', pcbStyle(style), '--stream'])
  let buf = ''
  let stderr = ''
  let finished = false
  let awaitingDrc = false
  const end = (event: string, data: unknown) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    res.write(sse(event, JSON.stringify(data)))
    res.end()
  }
  let timer = setTimeout(() => { proc.kill(); end('error', { error: 'PCB generation timed out' }) }, 60000)
  res.on('close', () => { if (!finished) { finished = true; clearTimeout(timer); proc.kill() } })

  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim() || finished) continue
      try {
        const ev = JSON.parse(line) as { type: string }
        if (ev.type === 'done') {
          // KiCad checks the finished board; the generator itself stays KiCad-free.
          // The python process exits while DRC runs, so hold the close handler back.
          awaitingDrc = true
          // The 60 s budget is for generation. DRC and the AI loop (up to MAX_ROUNDS model calls,
          // each followed by a reroute and DRC) get their own, longer budget.
          clearTimeout(timer)
          timer = setTimeout(() => end('error', { error: 'DRC / AI loop timed out' }), useAi ? 420000 : 120000)
          runDrc(pcbPath).then(async drc => {
            if (finished) return
            res.write(sse('drc', JSON.stringify(drc)))
            let final = ev as Record<string, unknown>
            let lastDrc = drc
            if (useAi) {
              const out = await runAiLoop(netPath, pcbPath, pcbStyle(style), final, drc,
                                          r => res.write(sse('ai', JSON.stringify(r))))
              if (out) {
                final = out.done
                lastDrc = out.drc
                res.write(sse('drc', JSON.stringify(lastDrc)))
              }
            }
            end('done', { ...final, pcbFilename, drc: lastDrc })
          })
        } else res.write(sse(ev.type, line))
      } catch { /* not an event line */ }
    }
  })
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  proc.on('error', (e: Error) => end('error', { error: e.message }))
  proc.on('close', (code: number | null) => {
    if (awaitingDrc) return          // the done event is on its way out after DRC
    if (code !== 0) end('error', { error: stderr || 'PCB generation failed' })
    else end('error', { error: 'PCB generator ended without a result' })
  })
})

// ── GET /download_pcb/:filename ────────────────────────────────────

app.get('/download_pcb/:filename', (req: Request, res: Response) => {
  const filename = basename(req.params['filename'] as string)
  const filePath = join(OUTPUTS_DIR, filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found.' })
  res.download(filePath, filename)
})

// ── POST /mouser_search ────────────────────────────────────────────
// One request per BOM line (the client groups parts). Without MOUSER_API_KEY nothing is made
// up: the answer says available:false and the BOM keeps its search links.

const MOUSER_MAX_LINES = 60
// same words as src/lib/bom.ts SEARCH_WORD (the server image does not ship src/)
const MOUSER_WORD: Record<string, string> = {
  R: 'resistor', C: 'capacitor', CP: 'electrolytic capacitor', L: 'inductor', LED: 'LED', D: 'diode',
  Q_NPN: 'NPN transistor', Q_NMOS: 'MOSFET', REG: 'regulator', NE555: '555', OpAmp: 'op amp',
  Relay: 'relay', Buzzer: 'buzzer', SW: 'switch', Battery: 'battery', Crystal: 'crystal',
}

/** name = part template, pkg = the board's package as a shop knows it (src/lib/bom.ts searchPkg) */
interface MouserQuery { ref: string; value: string; name?: string; pkg?: string | null }

/** part type + value + package, as src/lib/bom.ts searchKeyword builds the BOM's search links */
function mouserKeyword(q: MouserQuery): string {
  const conn = /^Conn_01x(\d+)$/.exec(String(q.name ?? ''))
  if (conn) return `pin header 1x${conn[1]} 2.54mm`
  const value = String(q.value).trim()
  const word = MOUSER_WORD[String(q.name ?? '')] ?? ''
  const keepWord = word && !value.toLowerCase().includes(word.toLowerCase())
  const pkg = typeof q.pkg === 'string' && /^[\w.-]{1,24}$/.test(q.pkg) ? q.pkg : ''
  return [keepWord ? word : '', value, pkg].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 80)
}

app.post('/mouser_search', async (req: Request, res: Response) => {
  const { components } = req.body || {}
  if (!Array.isArray(components) || !components.length) return res.status(400).json({ error: 'No components' })
  if (components.length > MOUSER_MAX_LINES) return res.status(400).json({ error: `Too many components (max ${MOUSER_MAX_LINES})` })

  const apiKey = process.env.MOUSER_API_KEY
  if (!apiKey) return res.json({ available: false, reason: 'MOUSER_API_KEY not set', results: [] })

  const results = []
  for (const comp of components as MouserQuery[]) {
    const ref = String(comp?.ref ?? '')
    if (!comp?.value || comp.value === '-') {
      results.push({ ref, value: comp?.value, mouserPart: null })
      continue
    }
    const keyword = mouserKeyword({ ...comp, ref })
    try {
      const resp = await axios.post(
        `https://api.mouser.com/api/v1/search/keyword?apiKey=${apiKey}`,
        { SearchByKeywordRequest: { keyword, records: 1, startingRecord: 0, searchOptions: '1', searchWithYourSignUpLanguage: '' } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      )
      const apiErrors = (resp.data?.Errors || []) as { Message?: string }[]
      if (apiErrors.length) {
        // not "no such part": the line stays retryable on the client
        results.push({ ref, value: comp.value, keyword, mouserPart: null, error: apiErrors[0]?.Message || 'Mouser API error' })
        continue
      }
      const parts = resp.data?.SearchResults?.Parts || []
      if (parts.length > 0) {
        const p = parts[0]
        // Unverified against a live response: AvailabilityInStock (digits) and PriceBreaks[].Currency.
        // Availability is a phrase ("4,521 In Stock"), so the stock number is only taken from AvailabilityInStock.
        const stock = String(p.AvailabilityInStock ?? '').trim()
        results.push({
          ref, value: comp.value, keyword,
          mouserPart: p.MouserPartNumber, mfgPart: p.ManufacturerPartNumber,
          manufacturer: p.Manufacturer, description: p.Description,
          price: p.PriceBreaks?.[0]?.Price || '', currency: p.PriceBreaks?.[0]?.Currency || '',
          // the first price break may start above one piece (reels): the client does not call it a unit price
          priceQty: Number(p.PriceBreaks?.[0]?.Quantity) || null,
          url: p.ProductDetailUrl, imageUrl: p.ImagePath,
          stockNum: /^\d+$/.test(stock) ? Number(stock) : null,
        })
      } else {
        results.push({ ref, value: comp.value, keyword, mouserPart: null })
      }
    } catch (e) {
      results.push({ ref, value: comp.value, keyword, mouserPart: null, error: (e as Error).message })
    }
  }

  res.json({ available: true, results })
})

// ── POST /generate_gerber (local KiCad CLI only) ───────────────────

// KICAD_CLI_PATH wins; otherwise the per-user Windows install, otherwise PATH.
const WIN_KICAD_CLI = join(process.env.LOCALAPPDATA || '', 'Programs', 'KiCad', '10.0', 'bin', 'kicad-cli.exe')
const KICAD_CLI = process.env.KICAD_CLI_PATH || (existsSync(WIN_KICAD_CLI) ? WIN_KICAD_CLI : 'kicad-cli')

function runKicadCli(args: string[], label: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(KICAD_CLI, args)
    let stderr = ''
    proc.stdout.on('data', () => { /* drain so a chatty kicad-cli never blocks on a full pipe */ })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${label} timed out`)) }, timeoutMs)
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

// ── GET /demo_result/:name ────────────────────────────────────────
// Loads one of the checked-in test circuits without calling OpenAI. This keeps
// the interactive 2D/3D board demo usable on development machines with no API
// key while still exercising the real SKiDL → placement → routing pipeline.
app.get('/demo_result/:name', async (req: Request, res: Response) => {
  const demos: Record<string, string> = {
    led: 'led_basic',
    ne555: 'ne555_blink',
    relay: 'npn_relay',
    motor: 'nmos_motor',
    // the same circuits with one deliberate fault each, for the operating check
    led_bad: 'led_bad',
    ne555_bad: 'ne555_bad',
    relay_bad: 'relay_bad',
  }
  const fixture = demos[String(req.params['name'] || '')]
  if (!fixture) return res.status(404).json({ error: 'Unknown demo circuit.' })

  try {
    const code = readFileSync(join(process.cwd(), 'test_circuits', `${fixture}.py`), 'utf8')
    const outputPath = await runSkidl(code)
    const filename = basename(outputPath)
    const graph = parseNetlist(readFileSync(outputPath, 'utf8'))
    res.json({ filename, graph, code, guide: '내장 검증 회로 — OpenAI API 키 없이 실행됩니다.' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── GET /health ────────────────────────────────────────────────────

// Asked once at startup: a deploy without KiCad still serves boards, but gerbers
// and DRC need kicad-cli, so the health check says which one this server is.
let kicadVersion: string | null = null
{
  const proc = spawn(KICAD_CLI, ['version'])
  let out = ''
  proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
  proc.on('error', () => { kicadVersion = null })
  proc.on('close', (code: number | null) => { kicadVersion = code === 0 ? out.trim() || null : null })
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '2.0.0', db: !!process.env.SUPABASE_URL, kicad: kicadVersion })
})

// ── SPA fallback ───────────────────────────────────────────────────

if (existsSync(distPath)) {
  app.get('/{*path}', (_req: Request, res: Response) => {
    res.sendFile(join(distPath, 'index.html'))
  })
}

const PORT = Number(process.env.PORT) || 8002
app.listen(PORT, () => console.log(`SchemaForge v2 running on http://localhost:${PORT}`))
