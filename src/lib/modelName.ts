import { useEffect, useState } from 'react'

/** The model the server writes circuits with and who runs it (GET /health: model, provider), e.g. GPT-4o by
 *  OpenAI or Grok 4.3 by xAI. Asked once per page; "AI" until the answer comes or when the server does not say. */
export type ModelName = { model: string; provider: string }

const UNKNOWN: ModelName = { model: 'AI', provider: 'AI' }
let asked: Promise<ModelName> | null = null
let known: ModelName | null = null

export function useModelName(): ModelName {
  const [name, setName] = useState<ModelName>(known ?? UNKNOWN)
  useEffect(() => {
    let live = true
    asked ??= fetch('/health')
      .then(r => r.json())
      .then((j: { model?: unknown; provider?: unknown }) => (known = {
        model: typeof j.model === 'string' && j.model ? j.model : UNKNOWN.model,
        provider: typeof j.provider === 'string' && j.provider ? j.provider : UNKNOWN.provider,
      }))
      .catch(() => UNKNOWN)
    asked.then(n => { if (live) setName(n) })
    return () => { live = false }
  }, [])
  return name
}

/** a host on this machine or the operator's own network: a container name (no dot), localhost, a private address */
function operatorsOwn(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes('.') && !h.includes(':')) return true   // localhost, ollama
  return h === '::1' || h.endsWith('.local') || h.endsWith('.lan') || h === 'host.docker.internal'
    || /^(127|10)\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)
}

/**
 * Where the circuit goes, for the terms and the privacy policy: /health's provider in words. OpenAI and xAI by name, a
 * host of the operator's own (a local model) as such, any other host by its name, and before /health answers (or when
 * it does not) the server's default. The policy named OpenAI alone while OPENAI_BASE_URL could send it anywhere.
 */
export function modelCompany(provider: string): string {
  if (provider === UNKNOWN.provider) return '이 서버가 쓰는 AI 모델 API(기본은 OpenAI)'
  if (provider === 'OpenAI' || provider === 'xAI') return `${provider}의 API`
  if (operatorsOwn(provider)) return '운영자의 컴퓨터에서 도는 AI 모델'
  return `${provider}의 AI 모델 API`
}
