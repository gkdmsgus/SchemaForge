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

// SF_AI_MODEL picks another model (e.g. behind an OpenAI-compatible gateway set with OPENAI_BASE_URL).
// SF_AI_JSON=1 is for gateways that drop `tools`: the model answers with the same object as plain JSON.
export const AI_MODEL = process.env.SF_AI_MODEL || 'gpt-4o-mini'
const JSON_MODE = process.env.SF_AI_JSON === '1'
export const MAX_ROUNDS = 3

export interface Metrics {
  drcErrors: number
  unrouted: number
  hpwl: number
  vias: number
  trackLength: number
  overlaps: number
  outside: number
  /** Sum of decoupling-capacitor distances to the nearest IC pin on the same supply net (mm). */
  decap: number
  /** Power nets feeding a relay, motor or regulator whose narrowest track is under HEAVY_POWER_WIDTH_MM. */
  powerWidth: number
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

type Box = [number, number, number, number]

interface BoardPart {
  ref: string; value: string; part: string; x: number; y: number; rot: number
  pads: { num: string; net: string | null }[]
  courtyard?: Box
  /** courtyard + silkscreen + reference text: what the generator's overlap check uses */
  keepout?: Box
  pads_abs?: { num: string; x: number; y: number; net: string | null }[]
}

interface BoardJson {
  parts: BoardPart[]
  nets: string[]
  outline: [number, number, number, number]
  unrouted?: unknown[]
  erc?: { severity: string; message: string }[]
  tracks?: { net: string; width: number }[]
}

/** A decoupling change smaller than this is treated as no change, so it cannot buy a longer route. */
export const DECAP_STEP_MM = 1.0

/**
 * Lower is better, compared in order: DRC errors, unrouted, overlaps, outside, then decoupling
 * distance (only when it moves by DECAP_STEP_MM or more), then narrow heavy power nets, then HPWL,
 * vias, track length.
 * Decoupling goes ahead of wire length because the rule it measures (cap right at the IC supply
 * pin) is worth a slightly longer route — but not for a fraction of a millimetre.
 */
export function better(a: Metrics, b: Metrics): boolean {
  const hard = (m: Metrics) => [m.drcErrors, m.unrouted, m.overlaps, m.outside]
  const soft = (m: Metrics) => [Math.round(m.hpwl * 100), m.vias, Math.round(m.trackLength * 100)]
  const cmp = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? 1 : -1; return 0 }
  const h = cmp(hard(a), hard(b))
  if (h) return h > 0
  const d = (a.decap ?? 0) - (b.decap ?? 0)
  if (Math.abs(d) >= DECAP_STEP_MM - 1e-9) return d < 0
  const w = (a.powerWidth ?? 0) - (b.powerWidth ?? 0)
  if (w) return w < 0
  return cmp(soft(a), soft(b)) > 0
}

export function metricsOf(summary: Record<string, unknown>, drcErrors: number, board?: BoardJson): Metrics {
  return {
    decap: board ? Math.round(decouplingPairs(board).reduce((a, d) => a + d.dist, 0) * 100) / 100 : 0,
    powerWidth: board ? heavyPowerNets(board).filter(n => n.width !== null && n.width < HEAVY_POWER_WIDTH_MM - 1e-9).length : 0,
    drcErrors,
    unrouted: (summary.unrouted as unknown[] | undefined)?.length ?? 0,
    hpwl: (summary.hpwl as number) ?? 0,
    vias: (summary.vias as number) ?? 0,
    trackLength: (summary.track_length as number) ?? 0,
    overlaps: (summary.overlaps as unknown[] | undefined)?.length ?? 0,
    outside: (summary.outside as string[] | undefined)?.length ?? 0,
  }
}

const GND_NET = /^(GND|VSS|AGND|DGND|PGND)$/i
const SUPPLY_NET = /^(VCC|VDD|VIN|VBAT|VBUS|VPP|V\+|3V3|\+?\d+(\.\d+)?V\d*)$/i

/** Recommended minimum track width on a power net that feeds a relay, motor or regulator (mm). */
export const HEAVY_POWER_WIDTH_MM = 0.8

/** Same test as pcb/router.py is_power(), so "power net" means what the router widens by default. */
export function isPowerNet(net: string): boolean {
  const n = net.toUpperCase()
  return ['GND', 'VCC', 'VDD', 'VIN', 'VBAT', 'VEE', 'VSS', '+', 'PWR'].some(h => n.includes(h)) || /^\d+V\d*$/.test(n)
}

/** Parts that draw real current: relays (K), motors (M), and regulators recognised by name. */
const HEAVY_PART = (p: BoardPart) =>
  /^(K|M)\d/i.test(p.ref) ||
  /REG|LDO|^78\d\d|^79\d\d|LM317|AMS1117|LM2596|MP1584/i.test(`${p.part} ${p.value}`)

export interface HeavyNet { net: string; parts: string[]; width: number | null }

/**
 * Power nets that carry a relay, motor or regulator's current — the ones the part sits on, plus the
 * power net of a transistor switching it — and the narrowest track currently on each (null = no tracks).
 */
export function heavyPowerNets(board: BoardJson): HeavyNet[] {
  const byNet = new Map<string, Set<string>>()
  const add = (net: string, label: string) => {
    if (!byNet.has(net)) byNet.set(net, new Set())
    byNet.get(net)!.add(label)
  }
  for (const p of board.parts) {
    if (!HEAVY_PART(p)) continue
    for (const pad of p.pads) {
      if (!pad.net) continue
      if (isPowerNet(pad.net)) { add(pad.net, p.ref); continue }
      // The load current also returns through the switch that drives it: a transistor (Q*) on one of
      // the heavy part's other nets (e.g. the relay's COIL_LOW) carries it to its own power net (GND).
      for (const q of board.parts) {
        if (!/^Q\d/i.test(q.ref) || !q.pads.some(qp => qp.net === pad.net)) continue
        for (const qp of q.pads) if (qp.net && isPowerNet(qp.net)) add(qp.net, `${q.ref} for ${p.ref}`)
      }
    }
  }
  return [...byNet].map(([net, parts]) => {
    const widths = (board.tracks || []).filter(t => t.net === net).map(t => t.width)
    return { net, parts: [...parts], width: widths.length ? Math.min(...widths) : null }
  })
}

/** Gap between two boxes in mm (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]))
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]))
  return Math.hypot(dx, dy)
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

export interface DecapPair { cap: string; net: string; ic: string; pin: string; dist: number }

/** Two-pad capacitors between a supply net and ground, and how far each sits from the nearest IC pin on that supply. */
export function decouplingPairs(board: BoardJson): DecapPair[] {
  const out: DecapPair[] = []
  for (const c of board.parts) {
    if (!/^C\d/i.test(c.ref) || !c.pads_abs || c.pads_abs.length !== 2) continue
    const supply = c.pads_abs.find(p => p.net && SUPPLY_NET.test(p.net))
    const ground = c.pads_abs.find(p => p.net && GND_NET.test(p.net))
    if (!supply || !ground) continue
    let best: DecapPair | null = null
    for (const u of board.parts) {
      if (!/^U\d/i.test(u.ref)) continue
      for (const p of u.pads_abs || []) {
        if (p.net !== supply.net) continue
        const dist = Math.hypot(p.x - supply.x, p.y - supply.y)
        if (!best || dist < best.dist) best = { cap: c.ref, net: supply.net as string, ic: u.ref, pin: p.num, dist }
      }
    }
    if (best) out.push({ ...best, dist: Math.round(best.dist * 100) / 100 })
  }
  return out
}

/** The box neighbours must stay out of — the same one pcb/board.py `overlaps()` uses. */
const areaOf = (p: BoardPart): Box | undefined => p.keepout ?? p.courtyard

/** Keep-out box a part would have at (x, y) with rotation rot, turning its current box about its origin. */
function movedArea(p: BoardPart, x: number, y: number, rot: number): Box | null {
  const area = areaOf(p)
  if (!area) return null
  const [x1, y1, x2, y2] = area
  const turn = (((rot - p.rot) % 360) + 360) % 360
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([cx, cy]) => {
    let rx = cx - p.x, ry = cy - p.y
    for (let t = 0; t < turn; t += 90) [rx, ry] = [ry, -rx]   // 90-degree steps only
    return [x + rx, y + ry]
  })
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * Cheap geometric check before the reroute: would a moved or rotated part's keep-out box overlap
 * another one or leave the board? Returns readable problems (empty = go ahead).
 */
export function precheck(board: BoardJson, ov: Overrides): string[] {
  const boxes = new Map<string, Box>()
  const changed = new Set<string>()
  for (const p of board.parts) {
    const pose = ov.parts[p.ref]
    const moved = !!pose && (Math.abs(pose[0] - p.x) > 1e-6 || Math.abs(pose[1] - p.y) > 1e-6 || pose[2] !== p.rot)
    const box = moved ? movedArea(p, pose[0], pose[1], pose[2]) : areaOf(p)
    if (box) boxes.set(p.ref, box)
    if (moved) changed.add(p.ref)
  }
  const problems: string[] = []
  const [bx1, by1, bx2, by2] = board.outline
  for (const ref of changed) {
    const a = boxes.get(ref)
    if (!a) continue
    for (const [other, b] of boxes) {
      if (other !== ref && boxesOverlap(a, b)) problems.push(`${ref} would overlap ${other}`)
    }
    if (a[0] < bx1 || a[1] < by1 || a[2] > bx2 || a[3] > by2) problems.push(`${ref} would leave the board outline`)
  }
  return problems
}

/** What the model sees: parts with keep-out box and nearest neighbour, nets, decoupling distances and the current numbers. */
export function describeBoard(board: BoardJson, m: Metrics, drcTypes: string[]): string {
  const netPins: Record<string, number> = {}
  board.parts.forEach(p => p.pads.forEach(pd => { if (pd.net) netPins[pd.net] = (netPins[pd.net] || 0) + 1 }))
  const parts = board.parts
    .map(p => {
      let line = `${p.ref}(${p.value || p.part}) at ${p.x.toFixed(1)},${p.y.toFixed(1)} rot ${p.rot}`
      const cy = areaOf(p)
      if (cy) {
        line += `, keep-out ${cy[0].toFixed(1)},${cy[1].toFixed(1)} to ${cy[2].toFixed(1)},${cy[3].toFixed(1)}` +
          ` (${(cy[2] - cy[0]).toFixed(1)} x ${(cy[3] - cy[1]).toFixed(1)} mm)`
        const near = board.parts
          .filter(o => o.ref !== p.ref && areaOf(o))
          .map(o => ({ ref: o.ref, gap: boxGap(cy, areaOf(o) as Box) }))
          .sort((a, b) => a.gap - b.gap)[0]
        if (near) line += `, nearest ${near.ref} gap ${near.gap.toFixed(1)} mm`
      }
      return line
    })
    .join('\n')
  const decap = decouplingPairs(board)
  const heavy = heavyPowerNets(board)
  const nets = Object.entries(netPins).map(([n, c]) => `${n}: ${c} pins`).join(', ')
  const [x1, y1, x2, y2] = board.outline
  return [
    `Board outline: ${x1.toFixed(1)},${y1.toFixed(1)} to ${x2.toFixed(1)},${y2.toFixed(1)} mm`,
    `Parts:\n${parts}`,
    `Nets: ${nets}`,
    decap.length
      ? `Decoupling capacitors (distance from the cap's supply pad to the nearest IC pin on that net):\n` +
        decap.map(d => `${d.cap} on ${d.net}: ${d.dist.toFixed(1)} mm to ${d.ic} pin ${d.pin}`).join('\n')
      : 'Decoupling capacitors: none found',
    heavy.length
      ? `Power nets feeding a relay, motor or regulator (recommended track width >= ${HEAVY_POWER_WIDTH_MM} mm):\n` +
        heavy.map(h => `${h.net} (${h.parts.join(', ')}): narrowest track ${h.width === null ? 'none' : `${h.width} mm`}`).join('\n')
      : 'Power nets feeding a relay, motor or regulator: none',
    `Metrics: decoupling distance total ${m.decap.toFixed(1)} mm, heavy power nets below ${HEAVY_POWER_WIDTH_MM} mm ${m.powerWidth}, HPWL ${m.hpwl.toFixed(1)} mm, track length ${m.trackLength.toFixed(1)} mm, vias ${m.vias}, ` +
      `unrouted ${m.unrouted}, DRC errors ${m.drcErrors}${drcTypes.length ? ` (${drcTypes.join(', ')})` : ''}`,
    board.erc?.length ? `Circuit findings: ${board.erc.map(f => f.message).join(' / ')}` : 'Circuit findings: none',
  ].join('\n')
}

function metricLine(m: Metrics): string {
  return `DRC errors ${m.drcErrors}, unrouted ${m.unrouted}, overlaps ${m.overlaps}, outside ${m.outside}, ` +
    `decoupling ${(m.decap ?? 0).toFixed(1)} mm, narrow heavy power nets ${m.powerWidth ?? 0}, ` +
    `HPWL ${m.hpwl.toFixed(1)} mm, vias ${m.vias}, track length ${m.trackLength.toFixed(1)} mm`
}

/** One line per finished round, so the next proposal knows what was kept and what was rolled back. */
export function describeOutcome(round: number, edit: BoardEdit, before: Metrics, after: Metrics | undefined,
                                kept: boolean, why?: string): string {
  const change = JSON.stringify({ moves: edit.moves, rotations: edit.rotations, net_widths: edit.net_widths })
  const result = after
    ? `${kept ? 'KEPT' : 'ROLLED BACK (the board got worse or did not improve)'}. before: ${metricLine(before)}; after: ${metricLine(after)}`
    : `ROLLED BACK (${why || 'the change could not be applied or checked'})`
  return `Round ${round} proposal ${change} -> ${result}`
}

export function roundFeedback(lines: string[]): string {
  return lines.length ? `\n\nEarlier rounds (the board above already reflects only the KEPT ones):\n${lines.join('\n')}` : ''
}

const SYSTEM = `You improve an already placed and routed two-layer PCB. You do not change the circuit —
only part positions, part rotations and track widths.

Rules you follow:
- A decoupling capacitor (small C between a supply net and GND that an IC also sits on) belongs right
  next to that IC's supply pin.
- Connectors (J*) and batteries (BT*) belong on the board edge; do not pull them inward.
- Power nets (GND, VCC, +5V, VIN...) carry current: 0.5 mm is the default, widen to 0.8-1.0 mm when a
  motor, relay or regulator is on the net. Never widen a signal net above 0.4 mm.
  The listed "power nets feeding a relay, motor or regulator" are scored: widening one to 0.8 mm or more
  counts as an improvement when DRC, routing and overlaps stay clean.
- Keep every part inside the board outline. Moves are in millimetres and should be small (under 6 mm).
- Each part lists its keep-out box (courtyard + silkscreen + reference text) and the gap to its nearest
  neighbour. A moved part's keep-out box must not overlap any other; leave at least 0.5 mm. The box moves
  with the part by the same dx, dy. Check the target spot against every nearby box first.
- The decoupling distance is scored: bringing a decoupling capacitor at least 1 mm closer to its IC supply pin
  counts as an improvement even if the route gets a little longer, as long as nothing overlaps and routing still
  completes. A smaller gain is judged on wire length and vias instead, so do not trade those for a few tenths.
- Change at most 3 things per round; a smaller, well-argued change is better than a big guess.
- If the board already follows these rules, set stop: true instead of inventing work.
- You are told what happened to your earlier proposals. Never repeat a change that was rolled back;
  if a move broke routing or caused overlaps, try a smaller or different move, or stop.

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
  if (JSON_MODE) return askModelJson(openai, prompt, history)
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

/** Same question without `tools`: the schema goes into the prompt and the reply is parsed as JSON. */
async function askModelJson(openai: OpenAI, prompt: string, history: string[]): Promise<BoardEdit> {
  const system = SYSTEM.replace('Always call the edit_board function.',
    'Reply with ONLY one JSON object, no prose and no code fence, matching this JSON schema:\n' +
    JSON.stringify(TOOL.function.parameters))
  const res = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: system },
      ...history.map(h => ({ role: 'assistant' as const, content: h })),
      { role: 'user', content: prompt },
    ],
  })
  const text = res.choices[0]?.message?.content || ''
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model returned no JSON edit')
  const edit = JSON.parse(text.slice(start, end + 1)) as BoardEdit
  if (typeof edit.reason !== 'string') throw new Error('model JSON edit has no reason')
  return edit
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
