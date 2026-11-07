// This browser's storage, read in one place: the results saved here (App, ResultPanel and the side drawer each read
// them; App saves a new one) and the guarded handle the assembly and review checklists keep their state in.
import type { ChatMessage, GenerateResult, NetGraph } from '../types'

/** A result saved in this browser (sf_saved_results), newest first. */
export interface StoredEntry { id: number; name: string; prompt: string; result?: GenerateResult; time: number; messages?: ChatMessage[]; graph?: NetGraph | null }

/** The saved results; missing or broken storage reads as none. */
export function getSavedResults(): StoredEntry[] {
  try { return JSON.parse(localStorage.getItem('sf_saved_results') || '[]') } catch { return [] }
}

/** A new result goes first, in place of an earlier one of the same description; the newest 30 are kept. */
export function saveResultToLocal(result: GenerateResult, prompt: string) {
  const saved = getSavedResults()
  const existing = saved.findIndex(s => s.prompt === prompt)
  if (existing >= 0) saved.splice(existing, 1)
  const entry = { id: Date.now(), name: prompt.slice(0, 40), prompt, result, time: Date.now() }
  saved.unshift(entry)
  while (saved.length > 30) saved.pop()
  localStorage.setItem('sf_saved_results', JSON.stringify(saved))
  return saved
}

/** localStorage, or null where there is none (a check run in node) or it is blocked. */
export function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
