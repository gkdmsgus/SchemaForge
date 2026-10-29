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

/** who runs the model, for the screen: OpenAI, xAI, or the gateway's host */
export function modelProvider(base = MODEL_BASE): string {
  const host = (() => { try { return new URL(base).hostname } catch { return base } })()
  return host === 'api.openai.com' ? 'OpenAI' : host === 'api.x.ai' ? 'xAI' : host
}
