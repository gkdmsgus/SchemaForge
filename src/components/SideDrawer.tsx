import React, { useState, useEffect } from 'react'
import type { SavedSession, ChatMessage, NetGraph, GenerateResult } from '../types'
import {
  getSessions, deleteSession as dbDeleteSession, deleteAllSessions, getFavorites, removeFavorite, renameSession,
  type AuthUser, type DbFavorite,
} from '../api'

interface StoredEntry {
  id: number
  name: string
  prompt: string
  result?: GenerateResult
  time: number
  messages?: ChatMessage[]
  graph?: NetGraph | null
  _dbId?: string
}

function getSavedResults(): StoredEntry[] {
  try { return JSON.parse(localStorage.getItem('sf_saved_results') || '[]') } catch { return [] }
}

const MONO = "'IBM Plex Mono','JetBrains Mono',monospace"
const SANS = "'Space Grotesk','Inter',sans-serif"

function groupByDate(items: StoredEntry[]): [string, StoredEntry[]][] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(today.getTime() - 6 * 86400000)
  const monthAgo = new Date(today.getTime() - 29 * 86400000)

  const groups: Record<string, StoredEntry[]> = { '오늘': [], '이번 주': [], '이번 달': [], '이전': [] }
  items.forEach((item: StoredEntry) => {
    const d = new Date(item.time)
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    if (day >= today) groups['오늘'].push(item)
    else if (day >= weekAgo) groups['이번 주'].push(item)
    else if (day >= monthAgo) groups['이번 달'].push(item)
    else groups['이전'].push(item)
  })
  return Object.entries(groups).filter(([, items]) => items.length > 0)
}

function formatTime(ts: number) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts), now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

interface SideDrawerProps {
  open: boolean
  onClose: () => void
  onLoadSession: (session: SavedSession) => void
  user?: AuthUser | null
}

type Tab = 'history' | 'favorites'

export default function SideDrawer({ open, onClose, onLoadSession, user }: SideDrawerProps) {
  const [tab, setTab] = useState<Tab>('history')
  const [savedResults, setSavedResults] = useState<StoredEntry[]>([])
  const [favorites, setFavorites] = useState<DbFavorite[]>([])
  const [dbMode, setDbMode] = useState(false)
  // why a server action failed (list, delete, rename): shown above the list instead of failing silently
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNotice(null)
    if (user) {
      setDbMode(true)
      getSessions().then(sessions => {
        const entries: StoredEntry[] = sessions.map((s, i) => ({
          id: i,
          name: s.name || s.prompt,
          prompt: s.prompt,
          result: s.graph
            ? { graph: s.graph as NetGraph, filename: s.filename ?? '', code: s.code ?? undefined, guide: s.guide ?? undefined }
            : undefined,
          time: new Date(s.created_at).getTime(),
          graph: s.graph as NetGraph | null,
          _dbId: s.id,
        }))
        setSavedResults(entries)
      }).catch(e => {
        // the server list did not come: this browser's records are shown, and deletes act on them
        setDbMode(false)
        setSavedResults(getSavedResults())
        setNotice(`서버 기록을 불러오지 못해 이 브라우저의 기록을 보여 줍니다. (${(e as Error).message})`)
      })
      getFavorites().then(setFavorites).catch(e => {
        setFavorites([])
        setNotice(`즐겨찾기를 불러오지 못했습니다. (${(e as Error).message})`)
      })
    } else {
      setDbMode(false)
      setTab('history')
      setSavedResults(getSavedResults())
    }
  }, [open, user])

  async function deleteSaved(e: React.MouseEvent, id: number) {
    e.stopPropagation()
    if (!dbMode) {
      const next = getSavedResults().filter(s => s.id !== id)
      localStorage.setItem('sf_saved_results', JSON.stringify(next))
      setSavedResults(next)
      return
    }
    const entry = savedResults.find(s => s.id === id)
    if (!entry) return
    setSavedResults(prev => prev.filter(s => s.id !== id))
    if (!entry._dbId) return
    try {
      await dbDeleteSession(entry._dbId)
      // the server drops the session's favourites with it
      setFavorites(prev => prev.filter(f => f.sessionId !== entry._dbId))
    } catch (err) {
      // not deleted on the server: the record goes back where it was (newest first)
      setSavedResults(prev => [...prev, entry].sort((a, b) => b.time - a.time))
      setNotice(`기록을 삭제하지 못했습니다: ${(err as Error).message}`)
    }
  }

  async function deleteAll() {
    if (!confirm(dbMode ? '서버에 저장된 기록을 모두 삭제할까요? 되돌릴 수 없습니다.' : '모든 저장 기록을 삭제할까요?')) return
    if (dbMode) {
      try {
        await deleteAllSessions()
      } catch (err) {
        // nothing is cleared: the list stays as the server has it
        setNotice(`기록을 삭제하지 못했습니다: ${(err as Error).message}`)
        return
      }
      setFavorites([])
    }
    localStorage.removeItem('sf_saved_results')
    setSavedResults([])
  }

  async function renameSaved(entry: StoredEntry, name: string) {
    if (!entry._dbId) return
    const before = entry.name
    setSavedResults(prev => prev.map(x => x.id === entry.id ? { ...x, name } : x))
    try {
      await renameSession(entry._dbId, name)
    } catch (err) {
      // the server kept the old name: show that one again
      setSavedResults(prev => prev.map(x => x.id === entry.id ? { ...x, name: before } : x))
      setNotice(`이름을 바꾸지 못했습니다: ${(err as Error).message}`)
    }
  }

  async function unfavorite(e: React.MouseEvent, f: DbFavorite) {
    e.stopPropagation()
    try {
      await removeFavorite(f.id)
      setFavorites(prev => prev.filter(x => x.id !== f.id))
    } catch (err) {
      setNotice(`즐겨찾기를 해제하지 못했습니다: ${(err as Error).message}`)
    }
  }

  /** a favourite opens the whole session from the history list when it is there (code, guide), else its circuit */
  function openFavorite(f: DbFavorite) {
    const full = savedResults.find(x => x._dbId === f.sessionId)
    const result = full?.result ?? (f.graph ? { graph: f.graph as NetGraph, filename: f.filename ?? '' } : undefined)
    if (!result?.graph) return
    onLoadSession({ prompt: f.prompt, graph: result.graph, circuitName: f.prompt, messages: [], result, dbId: f.sessionId || undefined })
    onClose()
  }

  const groups = groupByDate(savedResults)

  return (
    <>
      {open && (
        <div onClick={onClose} style={{
          position: 'fixed', inset: 0, zIndex: 39,
          background: 'rgba(26, 22, 17, 0.35)', backdropFilter: 'blur(2px)',
        }} />
      )}

      <div style={{
        position: 'fixed', top: 0, left: 0, bottom: 0,
        width: 280,
        background: 'var(--sf-bg-2)',
        borderRight: '1px solid var(--sf-line)',
        zIndex: 40,
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.22s cubic-bezier(.4,0,.2,1)',
        boxShadow: open ? 'var(--sf-shadow-lg)' : 'none',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 16px 0',
          borderBottom: `1px solid var(--sf-line)`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--sf-violet)', display: 'block' }} />
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--sf-violet)', fontWeight: 700, letterSpacing: '0.12em' }}>SCHEMAFORGE</span>
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: 'var(--sf-fg-dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px',
            }}>×</button>
          </div>
          {/* Tabs — only show when logged in */}
          {user && (
            <div style={{ display: 'flex', gap: 0, marginBottom: -1 }}>
              {(['history', 'favorites'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    flex: 1, padding: '7px 0',
                    background: 'none', border: 'none',
                    borderBottom: `2px solid ${tab === t ? 'var(--sf-amber)' : 'transparent'}`,
                    fontFamily: MONO, fontSize: 10, fontWeight: 700,
                    color: tab === t ? 'var(--sf-amber)' : 'var(--sf-fg-dim)',
                    cursor: 'pointer', letterSpacing: '0.08em',
                    transition: 'color 0.15s',
                  }}
                >
                  {t === 'history' ? '히스토리' : '⭐ 즐겨찾기'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 8px' }}>
          {notice && (
            <div role="alert" data-testid="drawer-notice" style={{
              margin: '8px 12px 4px', padding: '6px 8px 6px 10px', borderRadius: 6,
              border: '1px solid var(--sf-danger)', color: 'var(--sf-danger)', background: 'var(--sf-bg-1)',
              fontFamily: SANS, fontSize: 11, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6,
            }}>
              <span style={{ flex: 1 }}>{notice}</span>
              <button onClick={() => setNotice(null)} aria-label="알림 닫기" style={{
                background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0,
              }}>×</button>
            </div>
          )}
          {tab === 'favorites' && user ? (
            favorites.length === 0 ? (
              <p style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--sf-fg-dim)', fontSize: 11, fontFamily: SANS }}>
                즐겨찾기한 회로가 없어요<br/>
                <span style={{ fontSize: 10, opacity: 0.6 }}>결과 화면 상단의 북마크 버튼으로 추가하세요</span>
              </p>
            ) : favorites.map(f => (
              <SessionItem
                key={f.id}
                title={savedResults.find(x => x._dbId === f.sessionId)?.name || f.prompt || '이름 없는 회로'}
                time={formatTime(new Date(f.createdAt).getTime())}
                msgCount={0}
                isFavorite
                onClick={() => openFavorite(f)}
                onDelete={e => unfavorite(e, f)}
              />
            ))
          ) : (
            savedResults.length === 0 ? (
              <p style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--sf-fg-dim)', fontSize: 11, fontFamily: SANS }}>
                저장된 회로가 없습니다
              </p>
            ) : groups.map(([label, items]) => (
              <div key={label}>
                <div style={{
                  padding: '12px 16px 4px',
                  fontFamily: MONO, fontSize: 9, fontWeight: 700,
                  color: 'var(--sf-fg-faint)', letterSpacing: '0.1em', textTransform: 'uppercase',
                }}>{label}</div>
                {items.map(s => (
                  <SessionItem
                    key={s.id}
                    title={s.name || s.prompt}
                    time={formatTime(s.time)}
                    msgCount={s.messages?.length || 0}
                    dbId={s._dbId}
                    onClick={() => {
                      onLoadSession({ prompt: s.prompt, graph: s.result?.graph ?? undefined, circuitName: s.prompt, messages: s.messages || [], result: s.result, dbId: s._dbId })
                      onClose()
                    }}
                    onDelete={(e) => deleteSaved(e, s.id)}
                    onRename={(newName) => renameSaved(s, newName)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid #151821' }}>
          <button
            onClick={deleteAll}
            style={{
              width: '100%', padding: '6px', borderRadius: 6,
              border: '1px solid #1c2030', background: 'transparent',
              color: '#2a3040', cursor: 'pointer', fontFamily: MONO, fontSize: 9,
              transition: 'color 0.1s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
            onMouseLeave={e => e.currentTarget.style.color = '#2a3040'}
          >전체 삭제</button>
        </div>
      </div>
    </>
  )
}

function SessionItem({ title, time, msgCount, onClick, onDelete, onRename, dbId, isFavorite }: {
  title: string; time: string; msgCount: number
  onClick: () => void
  onDelete: (e: React.MouseEvent) => void | Promise<void>
  onRename?: (name: string) => void
  dbId?: string
  isFavorite?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState(title)
  const inputRef = React.useRef<HTMLInputElement>(null)

  function startEdit(e: React.MouseEvent) {
    if (isFavorite || !onRename || !dbId) return
    e.stopPropagation()
    setEditVal(title)
    setEditing(true)
    setTimeout(() => { inputRef.current?.select() }, 20)
  }

  function commitEdit() {
    const trimmed = editVal.trim()
    // the drawer sends it to the server and puts the old name back if that fails
    if (trimmed && trimmed !== title && dbId) onRename?.(trimmed)
    setEditing(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') { setEditing(false) }
  }

  return (
    <div
      onClick={editing ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '8px 12px 8px 16px',
        cursor: editing ? 'default' : 'pointer',
        background: hovered ? '#0d1018' : 'transparent',
        transition: 'background 0.1s',
        gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            ref={inputRef}
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
            onClick={e => e.stopPropagation()}
            maxLength={100}
            aria-label="기록 이름"
            style={{
              width: '100%', background: '#0a0d14', border: '1px solid #2a3555',
              borderRadius: 4, color: '#c0cce8', fontFamily: SANS, fontSize: 12,
              padding: '2px 6px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        ) : (
          <div
            style={{
              fontSize: 12, color: hovered ? '#c0cce8' : '#8090b0',
              fontFamily: SANS, lineHeight: 1.4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              transition: 'color 0.1s',
            }}
          >{title}</div>
        )}
        <div style={{ fontSize: 9, color: '#2a3040', fontFamily: MONO, marginTop: 2 }}>
          {time}{msgCount > 0 ? ` · 대화 ${msgCount}개` : ''}
        </div>
      </div>
      {/* a button, not a double-click: the first click of a double-click already opened the circuit and closed the drawer */}
      {!isFavorite && onRename && dbId && !editing && (
        <button
          onClick={startEdit}
          title="이름 바꾸기"
          aria-label="이름 바꾸기"
          style={{
            flexShrink: 0,
            background: 'none', border: 'none', cursor: 'pointer',
            color: hovered ? '#3a4055' : 'transparent',
            fontSize: 13, lineHeight: 1, padding: '2px 4px',
            borderRadius: 4, transition: 'color 0.1s, background 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = '#15122a' }}
          onMouseLeave={e => { e.currentTarget.style.color = hovered ? '#3a4055' : 'transparent'; e.currentTarget.style.background = 'none' }}
        >✎</button>
      )}
      <button
        onClick={onDelete}
        style={{
          flexShrink: 0,
          background: 'none', border: 'none', cursor: 'pointer',
          color: hovered ? '#3a4055' : 'transparent',
          fontSize: 13, lineHeight: 1, padding: '2px 4px',
          borderRadius: 4, transition: 'color 0.1s, background 0.1s',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = '#1a1015' }}
        onMouseLeave={e => { e.currentTarget.style.color = hovered ? '#3a4055' : 'transparent'; e.currentTarget.style.background = 'none' }}
      >✕</button>
    </div>
  )
}
