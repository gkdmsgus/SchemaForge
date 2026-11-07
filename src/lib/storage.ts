// This browser's storage, read in one place: the results saved here (App, ResultPanel and the side drawer each read
// them) and the guarded handle the assembly and review checklists keep their state in.
import type { ChatMessage, GenerateResult, NetGraph } from '../types'

/** A result saved in this browser (sf_saved_results), newest first. */
export interface StoredEntry { id: number; name: string; prompt: string; result?: GenerateResult; time: number; messages?: ChatMessage[]; graph?: NetGraph | null }

/** The saved results; missing or broken storage reads as none. */
export function getSavedResults(): StoredEntry[] {
  try { return JSON.parse(localStorage.getItem('sf_saved_results') || '[]') } catch { return [] }
}

/** localStorage, or null where there is none (a check run in node) or it is blocked. */
export function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
