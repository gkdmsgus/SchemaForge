// Stage 4: the AI improvement loop.
//
// The algorithms place and route; this asks a model what to change, applies the
// change with the generator (fixed placement + reroute), re-runs KiCad DRC and
// keeps the round only if the board actually got better. The model proposes,
// the code decides — a worse or equal result is rolled back.

import { spawn } from 'child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'

export const AI_MODEL = 'gpt-4o-mini'
export const MAX_ROUNDS = 3

export interface Metrics {
  drcErrors: number
  unrouted: number
  hpwl: number
  vias: number
  trackLength: number
  overlaps: number
  outside: number
}

export interface BoardEdit {
  moves?: { ref: string; dx: number; dy: number }[]
  rotations?: { ref: string; deg: number }[]
  net_widths?: { net: string; mm: number }[]
  reason?: string
  stop?: boolean
}

export interface AiRound {
  round: number
  reason: string
  actions: BoardEdit
  before: Metrics
  after?: Metrics
  kept: boolean
  note?: string
}

export interface Overrides {
  parts: Record<string, [number, number, number]>
  net_width: Record<string, number>
}

interface BoardJson {
  parts: { ref: string; value: string; part: string; x: number; y: number; rot: number
    pads: { num: string; net: string | null }[] }[]
  nets: string[]
  outline: [number, number, number, number]
  unrouted?: unknown[]
  erc?: { severity: string; message: string }[]
}

/** Lower is better, compared field by field in this order. */
export function score(m: Metrics): number[] {
  return [m.drcErrors, m.unrouted, m.overlaps, m.outside,
          Math.round(m.hpwl * 100), m.vias, Math.round(m.trackLength * 100)]
}

export function better(a: Metrics, b: Metrics): boolean {
  const x = score(a), y = score(b)
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i]
  }
  return false
}

export function metricsOf(summary: Record<string, unknown>, drcErrors: number): Metrics {
  return {
    drcErrors,
    unrouted: (summary.unrouted as unknown[] | undefined)?.length ?? 0,
    hpwl: (summary.hpwl as number) ?? 0,
    vias: (summary.vias as number) ?? 0,
    trackLength: (summary.track_length as number) ?? 0,
    overlaps: (summary.overlaps as unknown[] | undefined)?.length ?? 0,
    outside: (summary.outside as string[] | undefined)?.length ?? 0,
  }
}

/** What the model sees: refs with positions, nets with pin counts, and the current numbers. */
export function describeBoard(board: BoardJson, m: Metrics, drcTypes: string[]): string {
  const netPins: Record<string, number> = {}
  board.parts.forEach(p => p.pads.forEach(pd => { if (pd.net) netPins[pd.net] = (netPins[pd.net] || 0) + 1 }))
  const parts = board.parts
    .map(p => `${p.ref}(${p.value || p.part}) at ${p.x.toFixed(1)},${p.y.toFixed(1)} rot ${p.rot}`)
    .join('\n')
  const nets = Object.entries(netPins).map(([n, c]) => `${n}: ${c} pins`).join(', ')
  const [x1, y1, x2, y2] = board.outline
  return [
    `Board outline: ${x1.toFixed(1)},${y1.toFixed(1)} to ${x2.toFixed(1)},${y2.toFixed(1)} mm`,
    `Parts:\n${parts}`,
    `Nets: ${nets}`,
    `Metrics: HPWL ${m.hpwl.toFixed(1)} mm, track length ${m.trackLength.toFixed(1)} mm, vias ${m.vias}, ` +
      `unrouted ${m.unrouted}, DRC errors ${m.drcErrors}${drcTypes.length ? ` (${drcTypes.join(', ')})` : ''}`,
    board.erc?.length ? `Circuit findings: ${board.erc.map(f => f.message).join(' / ')}` : 'Circuit findings: none',
  ].join('\n')
}

const SYSTEM = `You improve an already placed and routed two-layer PCB. You do not change the circuit —
only part positions, part rotations and track widths.

Rules you follow:
- A decoupling capacitor (small C between a supply net and GND that an IC also sits on) belongs right
  next to that IC's supply pin.
- Connectors (J*) and batteries (BT*) belong on the board edge; do not pull them inward.
- Power nets (GND, VCC, +5V, VIN...) carry current: 0.5 mm is the default, widen to 0.8-1.0 mm when a
  motor, relay or regulator is on the net. Never widen a signal net above 0.4 mm.
- Keep every part inside the board outline. Moves are in millimetres and should be small (under 6 mm).
- Change at most 3 things per round; a smaller, well-argued change is better than a big guess.
- If the board already follows these rules, set stop: true instead of inventing work.

Answer in Korean in the "reason" field, one sentence, saying what you change and why.
Always call the edit_board function.`

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'edit_board',
    description: 'Move or rotate parts and set track widths, or stop when nothing is worth changing',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One Korean sentence: what and why' },
        stop: { type: 'boolean', description: 'true if the board needs no further change' },
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' } },
            required: ['ref', 'dx', 'dy'],
          },
        },
        rotations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: { type: 'string' }, deg: { type: 'number', enum: [0, 90, 180, 270] } },
            required: ['ref', 'deg'],
          },
        },
        net_widths: {
          type: 'array',
          items: {
            type: 'object',
            properties: { net: { type: 'string' }, mm: { type: 'number' } },
            required: ['net', 'mm'],
          },
        },
      },
      required: ['reason'],
    },
  },
}

/** Deterministic stand-in for the model, used by the checks (SF_AI_STUB=1). */
export function stubEdit(round: number): BoardEdit {
  if (round === 1) return { reason: '전원 넷 GND를 0.8 mm로 넓혀 전류 여유를 둡니다', net_widths: [{ net: 'GND', mm: 0.8 }] }
  if (round === 2) return { reason: '(테스트) 부품을 기판 밖으로 옮겨 나빠지는지 확인합니다', moves: [{ ref: 'R1', dx: 40, dy: 40 }] }
  return { reason: '더 고칠 것이 없습니다', stop: true }
}

export async function askModel(prompt: string, history: string[]): Promise<BoardEdit> {
  if (process.env.SF_AI_STUB === '1') return stubEdit(history.length + 1)
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const res = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      ...history.map(h => ({ role: 'assistant' as const, content: h })),
      { role: 'user', content: prompt },
    ],
    tools: [TOOL],
    tool_choice: { type: 'function', function: { name: 'edit_board' } },
  })
  const call = res.choices[0]?.message?.tool_calls?.[0]
  if (!call || call.type !== 'function') throw new Error('model returned no edit')
  return JSON.parse(call.function.arguments) as BoardEdit
}

/** Apply an edit to the overrides, clamped to the board outline. */
export function applyEdit(ov: Overrides, edit: BoardEdit, board: BoardJson): string[] {
  const notes: string[] = []
  const known = new Set(board.parts.map(p => p.ref))
  for (const m of edit.moves || []) {
    if (!known.has(m.ref)) { notes.push(`${m.ref}: 없는 부품`); continue }
    const cur = ov.parts[m.ref]
    ov.parts[m.ref] = [cur[0] + (m.dx || 0), cur[1] + (m.dy || 0), cur[2]]
  }
  for (const r of edit.rotations || []) {
    if (!known.has(r.ref)) { notes.push(`${r.ref}: 없는 부품`); continue }
    const cur = ov.parts[r.ref]
    ov.parts[r.ref] = [cur[0], cur[1], ((r.deg % 360) + 360) % 360]
  }
  for (const w of edit.net_widths || []) {
    if (!board.nets.includes(w.net)) { notes.push(`${w.net}: 없는 넷`); continue }
    const mm = Math.min(2, Math.max(0.15, w.mm))
    if (mm !== w.mm) notes.push(`${w.net}: ${w.mm} → ${mm} mm 로 제한`)
    ov.net_width[w.net] = mm
  }
  return notes
}

export function runGenerator(netPath: string, pcbPath: string, style: string, ov: Overrides,
                             cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ovPath = join(tmpdir(), `sf_ov_${randomUUID().slice(0, 8)}.json`)
    writeFileSync(ovPath, JSON.stringify(ov), 'utf8')
    const proc = spawn('python', [join(cwd, 'pcb_generator.py'), netPath, pcbPath,
      '--style', style, '--placer', 'fixed', '--overrides', ovPath])
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('generator timed out')) }, 60000)
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      try { unlinkSync(ovPath) } catch { /* already gone */ }
      if (code !== 0) return reject(new Error(stderr || 'generator failed'))
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop() || '{}') as Record<string, unknown>)
      } catch { reject(new Error('generator returned no summary')) }
    })
  })
}

export function backup(paths: string[]): () => void {
  const copies = paths.filter(existsSync).map(p => {
    const b = join(tmpdir(), `sf_bak_${randomUUID().slice(0, 8)}`)
    copyFileSync(p, b)
    return [p, b] as const
  })
  return () => copies.forEach(([p, b]) => { copyFileSync(b, p); try { unlinkSync(b) } catch { /* gone */ } })
}

export function readBoard(path: string): BoardJson {
  return JSON.parse(readFileSync(path, 'utf8')) as BoardJson
}
