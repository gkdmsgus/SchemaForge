// ── 회로 데이터 타입 ──────────────────────────────────────────────────────────

export interface NetNode {
  ref: string
  pin: string
}

export interface NetEntry {
  name: string
  nodes: NetNode[]
}

export interface ComponentEntry {
  ref: string
  value: string
  name?: string
}

export interface NetGraph {
  components: ComponentEntry[]
  nets: NetEntry[]
}

/** Summary returned by /generate_pcb (from server/pcb_generator.py). */
export interface PcbSummary {
  components: number
  nets: number
  unmapped: { ref: string; part: string; reason: string }[]
  warnings: string[]
  style: 'smd' | 'tht'
  board: { w: number; h: number }
  boardJson: string
  hpwl?: number
  hpwl_shelf?: number
  rotated?: number
  connections?: number
  tracks?: number
  vias?: number
  track_length?: number
  route_ms?: number
  unrouted?: { net: string; from: string; to: string }[]
}

// ── Board model streamed by /generate_pcb_stream (server/pcb/board.py) ─────────
// mm, y down, rot in degrees CCW on screen (KiCad convention).

export interface BoardPad {
  num: string
  type: string            // smd | thru_hole | np_thru_hole
  shape: string           // rect | roundrect | circle | oval | trapezoid | custom
  x: number               // footprint-local
  y: number
  angle: number
  w: number
  h: number
  drill: number | null
  net: string | null
}

/** F.SilkS graphics in footprint-local mm, as pcb/board.py exports them. */
export type SilkItem =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number }
  | { t: 'circle'; cx: number; cy: number; r: number; w: number }
  | { t: 'arc'; x1: number; y1: number; mx: number; my: number; x2: number; y2: number; w: number }
  | { t: 'poly'; pts: [number, number][]; w: number }

export interface BoardPart {
  ref: string
  value: string
  part: string
  footprint: string
  bbox: [number, number, number, number]   // local courtyard
  pads: BoardPad[]
  silk?: SilkItem[]
  ref_text?: { x: number; y: number; angle: number; w: number; h: number } | null
}

/** One placement snapshot: ref -> [x, y, rot]. */
export interface BoardFrame {
  iter: number
  phase: 'force' | 'legalize' | 'refine'
  hpwl: number
  parts: Record<string, [number, number, number]>
}

export interface BoardTrack {
  net: string
  layer: 'F.Cu' | 'B.Cu'
  width: number
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface BoardVia {
  net: string
  x: number
  y: number
}

/** One KiCad DRC violation; items carry the position on the board (mm). */
export interface DrcViolation {
  type: string
  severity: 'error' | 'warning' | string
  description: string
  items: { description: string; pos?: { x: number; y: number } }[]
}

export interface DrcResult {
  available: boolean
  reason?: string
  violations?: DrcViolation[]
  unconnected?: number
  errors?: number
  warnings?: number
}

/** One finding from the netlist checks (server/pcb/erc.py). */
export interface ErcFinding {
  rule: string
  severity: 'error' | 'warning'
  message: string
  refs: { ref: string; pin: string }[]
  net: string | null
}

/** One round of the AI improvement loop (stage 4): the model proposes, the server judges. */
export interface AiRound {
  round: number
  reason: string
  actions: {
    moves?: { ref: string; dx: number; dy: number }[]
    rotations?: { ref: string; deg: number }[]
    net_widths?: { net: string; mm: number }[]
    stop?: boolean
  }
  before: AiMetrics
  after?: AiMetrics
  kept: boolean
  note?: string
}

export interface AiMetrics {
  drcErrors: number
  unrouted: number
  hpwl: number
  vias: number
  trackLength: number
  overlaps: number
  outside: number
  /** decoupling-capacitor distance to the IC supply pin, summed (mm) */
  decap?: number
  /** power nets feeding a relay/motor/regulator with a track under 0.8 mm */
  powerWidth?: number
}

/** Routing events in stream order: a connection routed, or a net ripped up to make room. */
export type RouteEvent =
  | { type: 'route'; net: string; segments: BoardTrack[]; vias: BoardVia[] }
  | { type: 'rip'; net: string }

/** One rectangle of the ground fill preview (the board file carries the zone, KiCad fills it). */
export interface PourRect { net: string; layer: 'F.Cu' | 'B.Cu'; x1: number; y1: number; x2: number; y2: number }

export interface BoardModel {
  outline: [number, number, number, number]
  parts: (BoardPart & { x: number; y: number; rot: number })[]
  nets: string[]
  tracks?: BoardTrack[]
  vias?: BoardVia[]
  unrouted?: { net: string; from: string; to: string }[]
  erc?: ErcFinding[]
  pour?: PourRect[]
}

export interface GenerateResult {
  code?: string
  filename?: string
  graph?: NetGraph
  error?: string
  guide?: string
  sources?: string[]
  netlist?: string
}

// ── 버전 히스토리 ─────────────────────────────────────────────────────────────

export interface Version {
  id: string
  prompt: string
  result: GenerateResult
  time: number
  label: string
}

// ── 설정 ──────────────────────────────────────────────────────────────────────

export interface AppSettings {
  layout: '2col' | '1col'
  skeleton: boolean
  autoRetry: boolean
  clarify: boolean
  plan: boolean
}

// ── 로그 라인 ─────────────────────────────────────────────────────────────────

export type LogKind = 'info' | 'plan' | 'route'

export interface LogLine {
  ts: string
  kind: LogKind
  msg: string
  cursor?: boolean
}

// ── 진행 상태 ─────────────────────────────────────────────────────────────────

export interface Progress {
  msg: string
  step: number
}

// ── Clarify ───────────────────────────────────────────────────────────────────

export interface ClarifyQuestion {
  key: string
  label: string
  options: string[]
}

export interface ClarifyData {
  originalPrompt: string
  questions: ClarifyQuestion[]
}

export interface ClarifyApiResponse {
  clear: boolean
  questions?: ClarifyQuestion[]
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface PlanData {
  originalPrompt: string
  plan: unknown
  loading: boolean
}

// ── Cached / Session ──────────────────────────────────────────────────────────

export interface ChatAction {
  type: string
  ref?: string
  name?: string
  value?: string
  nodes?: { ref: string; pin: string }[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  _streaming?: boolean
  actions?: ChatAction[]
}

export interface SavedSession {
  prompt: string
  result?: GenerateResult
  graph?: NetGraph
  circuitName?: string
  messages?: ChatMessage[]
}

export interface ChatSession {
  messages: ChatMessage[]
  graph: NetGraph | null
}

export interface PendingCached {
  prompt: string
  typeKey: string | undefined
  cached: SavedSession
}

// ── circuits.ts 데이터 타입 ────────────────────────────────────────────────────

export interface CircuitItem {
  name: string
  desc: string
  parts: string
  prompt: string
}

export interface CircuitCategory {
  icon: string
  name: string
  items: CircuitItem[]
}

export type CircuitKey = 'audio' | 'power' | 'led' | 'sensor' | 'timer' | 'motor'

export interface CategoryMeta {
  key: CircuitKey
  icon: string
  name: string
  desc: string
}

// ── qaTrees.ts 데이터 타입 ────────────────────────────────────────────────────

export interface QaOption {
  txt: string
  sub?: string
  val: string
}

export interface QaQuestion {
  id: string
  ask: string
  opts: QaOption[]
  showIf?: (answers: Record<string, string>) => boolean
}

export interface QaTree {
  label: string
  questions: QaQuestion[]
  build: (base: string, answers: Record<string, string>) => string
}

// ── optInfo.ts 데이터 타입 ────────────────────────────────────────────────────

export interface OptSpec {
  k: string
  v: string
}

export interface OptInfoEntry {
  name: string
  emoji: string
  desc: string
  specs: OptSpec[]
  pros: string[]
  con: string
  best: string
}
