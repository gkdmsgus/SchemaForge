import React, { useState, useEffect } from 'react'
import type { SavedSession, ChatMessage, NetGraph, GenerateResult } from '../types'

interface StoredEntry {
  id: number
  name: string
  prompt: string
  result?: GenerateResult
  time: number
  messages?: ChatMessage[]
  graph?: NetGraph | null
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
}

export default function SideDrawer({ open, onClose, onLoadSession }: SideDrawerProps) {
  const [savedResults, setSavedResults] = useState<StoredEntry[]>([])

  useEffect(() => {
    if (open) setSavedResults(getSavedResults())
  }, [open])

  function deleteSaved(e: React.MouseEvent, id: number) {
    e.stopPropagation()
    const next = getSavedResults().filter(s => s.id !== id)
    localStorage.setItem('sf_saved_results', JSON.stringify(next))
    setSavedResults(next)
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
          padding: '16px 16px 12px',
          borderBottom: '1px solid #151821',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#a78bfa', display: 'block' }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: '#a78bfa', fontWeight: 700, letterSpacing: '0.12em' }}>SCHEMAFORGE</span>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#3a4055', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px',
          }}>×</button>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 8px' }}>
          {savedResults.length === 0 ? (
            <p style={{ padding: '40px 16px', textAlign: 'center', color: '#2a3040', fontSize: 11, fontFamily: SANS }}>
              저장된 회로가 없습니다
            </p>
          ) : groups.map(([label, items]) => (
            <div key={label}>
              <div style={{
                padding: '12px 16px 4px',
                fontFamily: MONO, fontSize: 9, fontWeight: 700,
                color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>{label}</div>
              {items.map(s => (
                <SessionItem
                  key={s.id}
                  title={s.name || s.prompt}
                  time={formatTime(s.time)}
                  msgCount={s.messages?.length || 0}
                  onClick={() => {
                    onLoadSession({ prompt: s.prompt, graph: s.result?.graph ?? undefined, circuitName: s.prompt, messages: s.messages || [], result: s.result })
                    onClose()
                  }}
                  onDelete={(e) => deleteSaved(e, s.id)}
                />
              ))}
            </div>
          ))}
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

function SessionItem({ title, time, msgCount, onClick, onDelete }: { title: string; time: string; msgCount: number; onClick: () => void; onDelete: (e: React.MouseEvent) => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '8px 12px 8px 16px',
        cursor: 'pointer',
        background: hovered ? '#0d1018' : 'transparent',
        transition: 'background 0.1s',
        gap: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: hovered ? '#c0cce8' : '#8090b0',
          fontFamily: SANS, lineHeight: 1.4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          transition: 'color 0.1s',
        }}>{title}</div>
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
