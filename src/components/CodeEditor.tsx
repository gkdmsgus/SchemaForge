import { useState, Dispatch, SetStateAction } from 'react'
import type { GenerateResult } from '../types'

const API = ''

interface CodeEditorProps {
  result: GenerateResult
  setResult: Dispatch<SetStateAction<GenerateResult | null>>
}

export default function CodeEditor({ result, setResult }: CodeEditorProps) {
  const [editing, setEditing] = useState(false)
  const [editCode, setEditCode] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function rerunCode() {
    if (!editCode.trim() || editLoading) return
    setEditLoading(true)
    try {
      const res = await fetch(`${API}/test_code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: editCode }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setResult(prev => prev ? ({ ...prev, code: editCode, filename: data.filename, graph: data.graph }) : null)
        setEditing(false)
        setError(null)
      }
    } catch (e) {
      setError(`실행 오류: ${(e as Error).message}`)
    } finally {
      setEditLoading(false)
    }
  }

  return (
    <>
      {error && (
        <div className="status-error">
          <span style={{flex:1}}>{error}</span>
        </div>
      )}
      <div className="card code-card">
        <div className="code-header">
          <span className="code-title">생성된 skidl 코드</span>
          <div style={{display:'flex',gap:'6px'}}>
            {!editing ? (
              <>
                <button className="copy-btn" onClick={e => {
                  navigator.clipboard.writeText(result.code ?? '')
                  const btn = e.target as HTMLButtonElement
                  btn.textContent = '복사됨!'
                  btn.style.color = 'var(--green)'
                  setTimeout(() => { btn.textContent = '복사'; btn.style.color = '' }, 2000)
                }}>복사</button>
                <button className="copy-btn edit-btn" onClick={() => { setEditCode(result.code ?? ''); setEditing(true) }}>수정</button>
              </>
            ) : (
              <>
                <button className="copy-btn" onClick={() => setEditing(false)}>취소</button>
                <button className="copy-btn run-btn" disabled={editLoading} onClick={rerunCode}>
                  {editLoading ? '실행 중...' : '실행'}
                </button>
              </>
            )}
          </div>
        </div>
        {editing ? (
          <textarea className="code-editor" value={editCode} onChange={e => setEditCode(e.target.value)} spellCheck={false} />
        ) : (
          <pre>{result.code}</pre>
        )}
      </div>
    </>
  )
}
