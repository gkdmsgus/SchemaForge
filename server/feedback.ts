// What a visitor's opinion (의견 남기기, POST /feedback) may hold, and how often one visitor may send it. Asked for by the
// user for the 2026-11-18 presentation in place of a separate survey form. Kept out of index.ts so check_inputs.ts and
// check_auth_flow.ts test the rules the server uses. Nothing here reads or keeps an address: the limit is counted under
// clientKey(req.ip) in memory only, and gone when the server restarts.

/** the longest opinion and the longest circuit name, in characters (a Korean syllable is one) */
export const COMMENT_MAX = 500
export const CIRCUIT_MAX = 80

export const FEEDBACK_SAYS = {
  body: '보낸 의견을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 보내 주세요.',
  rating: '별점을 1점에서 5점 사이로 골라 주세요.',
  comment: `의견은 ${COMMENT_MAX}자까지 적을 수 있습니다. 줄여서 다시 보내 주세요.`,
  circuit: '회로 이름을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 보내 주세요.',
  unknown: '알 수 없는 항목이 함께 왔습니다. 페이지를 새로고침한 뒤 다시 보내 주세요.',
  failed: '의견을 저장하지 못했습니다. 잠시 후 다시 보내 주세요.',
  full: '의견함이 가득 찼습니다. 프로젝트 저장소의 이슈로 남겨 주세요.',
}

export interface Feedback { rating: number; comment: string | null; circuit: string | null }

const FIELDS = new Set(['rating', 'comment', 'circuit'])
const chars = (s: string) => [...s].length
/** control characters other than a line break and a tab go (Postgres refuses \u0000 in text) */
const kept = (c: string) => c === '\n' || c === '\t' || (c.codePointAt(0)! >= 32 && c !== '\u007f')
const clean = (s: string) => [...s.replace(/\r\n?/g, '\n')].filter(kept).join('').trim()

/** the opinion as it will be stored, or the Korean reason it is refused */
export function readFeedback(body: unknown): Feedback | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: FEEDBACK_SAYS.body }
  const b = body as Record<string, unknown>
  if (Object.keys(b).some(k => !FIELDS.has(k))) return { error: FEEDBACK_SAYS.unknown }
  if (typeof b.rating !== 'number' || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) return { error: FEEDBACK_SAYS.rating }
  if (b.comment != null && typeof b.comment !== 'string') return { error: FEEDBACK_SAYS.body }
  if (b.circuit != null && typeof b.circuit !== 'string') return { error: FEEDBACK_SAYS.circuit }
  const comment = clean(String(b.comment ?? ''))
  const circuit = clean(String(b.circuit ?? '')).replace(/\s+/g, ' ')
  if (chars(comment) > COMMENT_MAX) return { error: FEEDBACK_SAYS.comment }
  if (chars(circuit) > CIRCUIT_MAX) return { error: FEEDBACK_SAYS.circuit }
  return { rating: b.rating, comment: comment || null, circuit: circuit || null }
}

/**
 * How many opinions one key (a visitor's address, job_slots.ts clientKey) and everyone together may send in a window.
 * Only an opinion that was read is counted, so a refused one costs nothing; it is counted before it is stored, so
 * opinions sent at once cannot pass the limit together.
 */
export class FeedbackLimit {
  private readonly sent = new Map<string, number[]>()
  private all: number[] = []

  constructor(readonly perKey: number, readonly perAll: number, readonly windowMs: number) {}

  /** null when it may go (and it is counted), else the Korean reason */
  take(key: string, now = Date.now()): string | null {
    const since = now - this.windowMs
    this.all = this.all.filter(t => t > since)
    // a key with nothing left in the window is dropped, so the map does not keep every visitor for good
    for (const [k, ts] of this.sent) if (!ts.some(t => t > since)) this.sent.delete(k)
    const mine = (this.sent.get(key) ?? []).filter(t => t > since)
    if (mine.length >= this.perKey) {
      return `의견은 ${Math.round(this.windowMs / 60000)}분에 ${this.perKey}번까지 보낼 수 있습니다. 잠시 뒤 다시 보내 주세요.`
    }
    if (this.all.length >= this.perAll) return '지금 의견이 많이 몰렸습니다. 잠시 뒤 다시 보내 주세요.'
    mine.push(now)
    this.sent.set(key, mine)
    this.all.push(now)
    return null
  }
}
