// Assembly checklist: which parts a person has already placed (soldered) on the real board.
// Kept per board file in this browser; a regenerated PCB is a new file and starts empty.
import { FURNITURE, naturalRef } from './bom'
import type { BoardModel } from '../types'

export const PLACED_STORE = 'sf_assembly_v1'
const MAX_BOARDS = 50

/** The parts there is something to place: everything but test pads and mounting holes, R2 before R10. */
export function assemblyRefs(final: Pick<BoardModel, 'parts'> | null | undefined): string[] {
  return (final?.parts ?? []).filter(p => !FURNITURE.has(p.part)).map(p => p.ref).sort(naturalRef)
}

type Store = Record<string, { at: number; refs: string[] }>

function readStore(storage: Pick<Storage, 'getItem'> | null): Store {
  try {
    const raw = storage?.getItem(PLACED_STORE)
    const data = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Store : {}
  } catch {
    return {}
  }
}

/** Refs placed on this board file, only those the board still has. Missing or broken storage reads as none. */
export function loadPlaced(board: string | null | undefined, refs: string[],
  storage: Pick<Storage, 'getItem'> | null = safeStorage()): Set<string> {
  if (!board) return new Set()
  const entry = readStore(storage)[board]
  const known = new Set(refs)
  return new Set(Array.isArray(entry?.refs) ? entry.refs.filter(r => typeof r === 'string' && known.has(r)) : [])
}

/** Save this board's placed refs (the most recent boards kept); storage failures keep the state in memory only. */
export function savePlaced(board: string | null | undefined, placed: Set<string>,
  storage: (Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'>) | null = safeStorage(), now = Date.now()): void {
  if (!board) return
  try {
    const store = readStore(storage)
    store[board] = { at: now, refs: [...placed].sort(naturalRef) }
    const kept = Object.fromEntries(Object.entries(store).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MAX_BOARDS))
    storage?.setItem(PLACED_STORE, JSON.stringify(kept))
  } catch { /* private mode or full: keep in memory */ }
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}
