import React, { useState, useEffect } from 'react'
import type { SavedSession, ChatMessage, NetGraph, GenerateResult } from '../types'
import { getSessions, deleteSession as dbDeleteSession, getFavorites, removeFavorite, renameSession, type AuthUser, type DbFavorite } from '../api'

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

  useEffect(() => {
    if (!open) return
    if (user) {
      setDbMode(true)
      getSessions().then(sessions => {
        const entries: StoredEntry[] = sessions.map((s, i) => ({
          id: i,
          name: s.name ?? s.prompt,
          prompt: s.prompt,
          result: s.graph ? { graph: s.graph as NetGraph, filename: s.filename ?? '' } : undefined,
          time: new Date(s.created_at).getTime(),
          graph: s.graph as NetGraph | null,
          _dbId: s.id,
        }))
        setSavedResults(entries)
      }).catch(() => setSavedResults(getSavedResults()))
      getFavorites().then(setFavorites).catch(() => {})
    } else {
      setDbMode(false)
      setTab('history')
      setSavedResults(getSavedResults())
    }
  }, [open, user])

  function deleteSaved(e: React.MouseEvent, id: number) {
    e.stopPropagation()
    if (dbMode) {
      const entry = savedResults.find(s => s.id === id) as (StoredEntry & { _dbId?: string }) | undefined
      if (entry?._dbId) {
        dbDeleteSession(entry._dbId).catch(() => {})
      }
      setSavedResults(prev => prev.filter(s => s.id !== id))
    } else {
      const next = getSavedResults().filter(s => s.id !== id)
      localStorage.setItem('sf_saved_results', JSON.stringify(next))
      setSavedResults(next)
    }
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
          {tab === 'favorites' && user ? (
            favorites.length === 0 ? (
              <p style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--sf-fg-dim)', fontSize: 11, fontFamily: SANS }}>
                즐겨찾기한 회로가 없어요<br/>
                <span style={{ fontSize: 10, opacity: 0.6 }}>결과 화면 상단의 북마크 버튼으로 추가하세요</span>
              </p>
            ) : favorites.map((f, i) => (
              <SessionItem
                key={f.id}
                title={f.prompt}
                time={new Date(f.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                msgCount={0}
                isFavorite
                onClick={() => {
                  if (f.graph) {
                    onLoadSession({ prompt: f.prompt, graph: f.graph as NetGraph, circuitName: f.prompt, messages: [], result: { graph: f.graph as NetGraph, filename: f.filename ?? '' } })
                    onClose()
                  }
                }}
                onDelete={async (e) => {
                  e.stopPropagation()
                  await removeFavorite(f.id).catch(() => {})
                  setFavorites(prev => prev.filter(x => x.id !== f.id))
                }}
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
                      onLoadSession({ prompt: s.prompt, graph: s.result?.graph ?? undefined, circuitName: s.prompt, messages: s.messages || [], result: s.result })
                      onClose()
                    }}
                    onDelete={(e) => deleteSaved(e, s.id)}
                    onRename={(newName) => {
                      setSavedResults(prev => prev.map(x => x.id === s.id ? { ...x, name: newName } : x))
                    }}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid #151821' }}>
          <button
            onClick={() => {
              if (confirm('모든 저장 기록을 삭제할까요?')) {
                localStorage.removeItem('sf_saved_results')
                setSavedResults([])
              }
            }}
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
    if (trimmed && trimmed !== title && dbId) {
      renameSession(dbId, trimmed).catch(() => {})
      onRename?.(trimmed)
    }
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
            style={{
              width: '100%', background: '#0a0d14', border: '1px solid #2a3555',
              borderRadius: 4, color: '#c0cce8', fontFamily: SANS, fontSize: 12,
              padding: '2px 6px', outline: 'none', boxSizing: 'border-box',
            }}
          />
        ) : (
          <div
            onDoubleClick={startEdit}
            title={!isFavorite && dbId ? '더블클릭으로 이름 수정' : undefined}
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
