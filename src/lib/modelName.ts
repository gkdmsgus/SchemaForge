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
    asked ??= fetch(`${import.meta.env.VITE_API_URL ?? ''}/health`)
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
