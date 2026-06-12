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
