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

const SYSTEM_PROMPT = `You are a specialized electronics CAD tool that generates skidl Python code for KiCad PCB design software. You MUST always output the requested circuit.

CRITICAL — skidl code rules (MUST follow exactly):
- Start with: from skidl import *
- EVERY Part() MUST use tool=SKIDL with explicit Pin definitions. Example:
  r1 = Part(tool=SKIDL, name='R', ref_prefix='R',
            pins=[Pin(num=1, name='p1', func=Pin.types.PASSIVE),
                  Pin(num=2, name='p2', func=Pin.types.PASSIVE)])
  r1.value = '10k'
- NEVER use Part('library', 'name') syntax. NEVER reference KiCad libraries like 'linear', 'device', 'power'.
- NEVER use footprint= parameter. Only use tool=SKIDL.
- Connect pins by name: r1['p1'] += net1
- End with: generate_netlist()

Part templates (copy exactly, only change name/value):
- Resistor: Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- Capacitor: Part(tool=SKIDL, name='C', ref_prefix='C', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])
- LED: Part(tool=SKIDL, name='LED', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- Diode: Part(tool=SKIDL, name='D', ref_prefix='D', pins=[Pin(num=1,name='A',func=Pin.types.PASSIVE), Pin(num=2,name='K',func=Pin.types.PASSIVE)])
- NPN: Part(tool=SKIDL, name='Q_NPN', ref_prefix='Q', pins=[Pin(num=1,name='B',func=Pin.types.INPUT), Pin(num=2,name='C',func=Pin.types.PASSIVE), Pin(num=3,name='E',func=Pin.types.PASSIVE)])
- Op-Amp: Part(tool=SKIDL, name='OpAmp', ref_prefix='U', pins=[Pin(num=1,name='IN+',func=Pin.types.INPUT), Pin(num=2,name='IN-',func=Pin.types.INPUT), Pin(num=3,name='OUT',func=Pin.types.OUTPUT), Pin(num=4,name='V+',func=Pin.types.PWRIN), Pin(num=5,name='V-',func=Pin.types.PWRIN)])
- Voltage Regulator: Part(tool=SKIDL, name='REG', ref_prefix='U', pins=[Pin(num=1,name='IN',func=Pin.types.PASSIVE), Pin(num=2,name='GND',func=Pin.types.PASSIVE), Pin(num=3,name='OUT',func=Pin.types.PASSIVE)])
- Switch: Part(tool=SKIDL, name='SW', ref_prefix='SW', pins=[Pin(num=1,name='p1',func=Pin.types.PASSIVE), Pin(num=2,name='p2',func=Pin.types.PASSIVE)])

Output format — two sections separated by exactly "---GUIDE---":
Section 1: skidl Python code ONLY. No prose, no markdown fences.
Section 2: Korean wiring guide`

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
  let m: RegExpExecArray | null
  while ((m = compRe.exec(text)) !== null) {
    components.push({ ref: m[1], value: m[2] })
  }

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

const CLARIFY_SYSTEM_PROMPT = `You are a circuit design assistant. Given a user's natural-language circuit request (in Korean or English), decide if it is specific enough to generate a complete schematic immediately, or if 2–4 clarifying questions would significantly improve the result.

Output JSON ONLY in this exact shape:
{ "clear": true }
or
{ "clear": false, "questions": [ { "key": "string", "label": "string (Korean)", "options": ["string", ...] }, ... ] }

Rules:
- STRONGLY default to "clear": true. Only return false when the prompt is genuinely under-specified.
- Ask AT MOST 4 questions, AT LEAST 2.
- Do not output anything except the JSON.`

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

const PLAN_SYSTEM_PROMPT = `You are a senior circuit designer. Given a user's request (Korean or English), produce a concise design plan BEFORE the schematic is built.

Output JSON ONLY in this exact shape:
{
  "title": "string (Korean, ≤ 30 chars)",
  "summary": "string (Korean, 1–2 sentences)",
  "topology": "string (Korean, ≤ 80 chars)",
  "specs": [ { "label": "string", "value": "string" } ],
  "parts": [ { "ref": "string", "type": "string", "value": "string", "role": "string" } ],
  "risks": [ "string" ]
}
Output ONLY the JSON object. No markdown, no prose.`

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

  const systemPrompt = `You are a circuit editor assistant. The user has a schematic and wants to modify it.

Current circuit:
- Components: ${compSummary || 'none'}
- Nets: ${netSummary || 'none'}

Always call the edit_circuit function. Reply in Korean (1-2 sentences).`

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
      'No reference found — use standard professional circuit design.\n\n' +
      'Generate a COMPLETE professional-grade circuit with ALL necessary components.'

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
        if (raw.startsWith('from skidl')) break
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

    if (skidlCode.startsWith('```')) {
      skidlCode = skidlCode.split('\n').slice(1, -1).join('\n').trim()
    }

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
        let fixRaw = (fixAxiosRes.data.choices[0].message.content as string).trim()
        let [fixCode, fixGuide] = fixRaw.includes('---GUIDE---')
          ? fixRaw.split('---GUIDE---', 2).map((s: string) => s.trim())
          : [fixRaw.trim(), guide]
        if (fixCode.startsWith('```')) fixCode = fixCode.split('\n').slice(1, -1).join('\n').trim()
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

app.post('/generate_pcb', async (req: Request, res: Response) => {
  const { filename } = req.body || {}
  if (!filename) return res.status(400).json({ error: 'No netlist filename provided.' })

  const netPath = join(OUTPUTS_DIR, basename(filename as string))
  if (!existsSync(netPath)) return res.status(404).json({ error: 'Netlist file not found.' })

  const pcbFilename = basename(filename as string, '.net') + '.kicad_pcb'
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  try {
    const proc = spawn('python', [join(process.cwd(), 'pcb_generator.py'), netPath, pcbPath])
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error('PCB generation timed out')) }, 30000)
      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr || 'PCB generation failed'))
        resolve()
      })
    })
    res.json({ pcbFilename, message: 'PCB layout generated successfully' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── POST /generate_pcb_from_graph ─────────────────────────────────

app.post('/generate_pcb_from_graph', async (req: Request, res: Response) => {
  const { graph, baseName } = req.body || {}
  if (!graph) return res.status(400).json({ error: 'No graph provided.' })

  const uid = randomUUID().slice(0, 8)
  const netFilename = `${(baseName as string) || 'edited'}_${uid}.net`
  const netPath = join(OUTPUTS_DIR, netFilename)
  const pcbFilename = netFilename.replace('.net', '.kicad_pcb')
  const pcbPath = join(OUTPUTS_DIR, pcbFilename)

  try {
    writeFileSync(netPath, graphToNetlist(graph as NetGraph), 'utf8')
    const proc = spawn('python', [join(process.cwd(), 'pcb_generator.py'), netPath, pcbPath])
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(new Error('PCB generation timed out')) }, 30000)
      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr || 'PCB generation failed'))
        resolve()
      })
    })
    res.json({ pcbFilename, message: 'PCB layout generated from edited graph' })
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

const KICAD_CLI = process.env.KICAD_CLI_PATH || 'kicad-cli'

app.post('/generate_gerber', async (req: Request, res: Response) => {
  const { pcbFilename } = req.body || {}
  if (!pcbFilename) return res.status(400).json({ error: 'No PCB filename provided.' })

  const pcbPath = join(OUTPUTS_DIR, basename(pcbFilename as string))
  if (!existsSync(pcbPath)) return res.status(404).json({ error: 'PCB file not found.' })

  const gerberDir = join(OUTPUTS_DIR, basename(pcbFilename as string, '.kicad_pcb') + '_gerber')
  if (!existsSync(gerberDir)) mkdirSync(gerberDir)

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(KICAD_CLI, ['pcb', 'export', 'gerbers', '--output', gerberDir, pcbPath])
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Gerber export timed out')) }, 30000)
      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr || 'Gerber export failed'))
        resolve()
      })
    })

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(KICAD_CLI, ['pcb', 'export', 'drill', '--output', gerberDir + '/', pcbPath])
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Drill export timed out')) }, 30000)
      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr || 'Drill export failed'))
        resolve()
      })
    })

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
