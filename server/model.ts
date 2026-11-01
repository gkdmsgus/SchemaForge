// The model provider. OpenAI by default; any OpenAI-compatible chat completions API by OPENAI_BASE_URL
// (xAI's Grok: https://api.x.ai/v1, read 2026-10-29), which the OpenAI SDK clients read by themselves.
//   SF_MODEL             circuit code and its ERC repair (default gpt-4o)
//   SF_MODEL_MINI        questions, plan, AI editor, and AI 다듬기 unless SF_AI_MODEL (default gpt-4o-mini)
//   SF_REASONING_EFFORT  sent as reasoning_effort when set: Grok models reason first and the reasoning counts
//                        against the answer's tokens; grok-4.3 takes "none"

export const MODEL_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
export const MODEL = process.env.SF_MODEL || 'gpt-4o'
export const MODEL_MINI = process.env.SF_MODEL_MINI || 'gpt-4o-mini'

/** extra request fields for every model call ({} on OpenAI by default) */
export const modelExtra = (): Record<string, string> =>
  process.env.SF_REASONING_EFFORT ? { reasoning_effort: process.env.SF_REASONING_EFFORT } : {}

/** the name the screen shows: gpt-4o → GPT-4o, gpt-4o-mini → GPT-4o mini, grok-4.3 → Grok 4.3 */
export function modelLabel(id: string): string {
  const gpt = /^gpt-(.+?)(-mini)?$/i.exec(id)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' mini' : ''}`
  const grok = /^grok-(.+)$/i.exec(id)
  return grok ? `Grok ${grok[1]}` : id
}

const DEMO = '데모(?demo=motor)는 그대로 쓸 수 있습니다.'
export const MODEL_NO_CREDIT = `AI 모델 사용 한도(크레딧)가 다 떨어져 지금은 회로 생성과 AI 편집을 할 수 없습니다. 운영자가 결제 한도를 채우면 다시 됩니다. ${DEMO}`
export const MODEL_BUSY = 'AI 모델에 요청이 몰려 잠시 거절됐습니다. 1분쯤 뒤에 다시 시도해 주세요.'
export const MODEL_KEY_REFUSED = `서버의 AI 모델 키가 거절됐습니다. 운영자가 키를 확인해야 합니다. ${DEMO}`

/**
 * A failed model call in words for the screen, with the HTTP status to answer with, or null when it is not one of
 * these (the caller keeps its own message). OpenAI answers 429 with code insufficient_quota when the credit is gone
 * (the screen showed "Request failed with status code 429"), and 429 with rate_limit_exceeded when busy; xAI says
 * "credits" in the message. Reads the OpenAI SDK's APIError (status, code, error) and axios's error (response).
 */
export function modelFailure(e: unknown): { status: number; text: string } | null {
  type Body = { code?: unknown; type?: unknown; message?: unknown }
  const err = (e ?? {}) as { status?: number; code?: unknown; type?: unknown; message?: unknown; error?: Body;
    response?: { status?: number; data?: { error?: Body | string } } }
  const data = typeof err.response?.data?.error === 'object' ? err.response.data.error : { message: err.response?.data?.error }
  const status = err.status ?? err.response?.status
  const said = [err.code, err.type, err.error?.code, err.error?.type, err.error?.message, data?.code, data?.type, data?.message,
    status === 429 ? err.message : ''].map(x => String(x ?? '')).join(' ')
  if (status === 429 && /insufficient_quota|quota|credit|billing/i.test(said)) return { status: 503, text: MODEL_NO_CREDIT }
  if (status === 429) return { status: 429, text: MODEL_BUSY }
  if (status === 401 || /invalid_api_key/i.test(said)) return { status: 503, text: MODEL_KEY_REFUSED }
  return null
}

/** who runs the model, for the screen: OpenAI, xAI, or the gateway's host */
export function modelProvider(base = MODEL_BASE): string {
  const host = (() => { try { return new URL(base).hostname } catch { return base } })()
  return host === 'api.openai.com' ? 'OpenAI' : host === 'api.x.ai' ? 'xAI' : host
}
