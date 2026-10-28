import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react'
import { authFetch } from '../api'
import type { ErcFinding, NetGraph } from '../types'
import { indentLines, lineRange, summarizeError, toLF, tokenizePython, type CodeEdit } from '../lib/pythonCode'
import { ercErrorCount } from '../lib/boardChecks'

const API = ''
/** px; the same integer line height as .sf-code-textarea and .sf-code-gutter in _code.scss */
const LINE_H = 20

/** One successful run of edited code, handed to ResultPanel to apply. */
export interface CodeRun {
  code: string
  filename: string
  graph: NetGraph
  /** report-only netlist checks (server/pcb/erc.py) of the new circuit; null when they could not run */
  erc?: ErcFinding[] | null
  ercError?: string
}

/** What the last run changed, shown while its netlist is still the current one. */
export interface CodeRunNote {
  filename: string
  parts: number
  nets: number
  added: string[]
  removed: string[]
  modified: string[]
  erc?: ErcFinding[] | null
  ercError?: string
}

/** POST /test_code: { error } on a failed run, otherwise the new netlist and its checks. */
interface TestCodeResponse { error?: string; filename?: string; graph?: NetGraph; erc?: ErcFinding[] | null; ercError?: string }

interface CodeEditorProps {
  code: string
  /** the draft lives in ResultPanel so switching drawer tabs keeps it */
  edit: CodeEdit | null
  setEdit: Dispatch<SetStateAction<CodeEdit | null>>
  onApplied: (run: CodeRun) => void
  lastRun: CodeRunNote | null
  onDismissRun: () => void
  /** the AI chat changed the circuit, so the code no longer describes it */
  aiEdited: boolean
  /** the board was built from a different circuit than the one shown now */
  pcbStale: boolean
  onRegeneratePcb: () => void
  /** /test_code needs a login */
  canRun: boolean
  /** the server rejected the saved login (expired, or a dev server that restarted) */
  onAuthExpired?: () => void
}

export default function CodeEditor({
  code: rawCode, edit, setEdit, onApplied, lastRun, onDismissRun, aiEdited, pcbStale, onRegeneratePcb, canRun, onAuthExpired,
}: CodeEditorProps) {
  const code = useMemo(() => toLF(rawCode), [rawCode])
  const lines = useMemo(() => tokenizePython(code), [code])
  const editLines = useMemo(() => (edit ? edit.text.split('\n').length : 0), [edit])
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const editBtnRef = useRef<HTMLButtonElement>(null)
  // Esc, then Tab, leaves the textarea: Tab indents otherwise, which would trap keyboard users
  const releaseTab = useRef(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  const dirty = !!edit && edit.text !== code
  const running = !!edit?.running
  const errLine = edit?.error?.line ?? null

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
  }

  function download(text: string) {
    // (source "circuit.py") in the netlist names the script the same way
    const url = URL.createObjectURL(new Blob([text], { type: 'text/x-python;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'circuit.py'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // focus moves into the editor on 수정 and back to 수정 after Esc, in the same commit as the switch
  const focusNext = useRef<'editor' | 'editButton' | null>(null)
  useLayoutEffect(() => {
    if (focusNext.current === 'editor') taRef.current?.focus()
    else if (focusNext.current === 'editButton') editBtnRef.current?.focus()
    focusNext.current = null
  }, [!!edit])

  function startEdit() {
    focusNext.current = 'editor'
    releaseTab.current = false
    setEdit({ text: code, error: null })
  }

  function cancel(fromKeyboard = false) {
    if (!edit || edit.running) return
    if (edit.text !== code && !window.confirm('수정한 코드를 버리시겠습니까?')) return
    if (fromKeyboard) focusNext.current = 'editButton'
    setEdit(null)
  }

  async function run() {
    if (!edit || edit.running || !canRun) return
    const sent = edit.text
    if (!sent.trim() || sent === code) return
    if (aiEdited && !window.confirm('AI 편집으로 바꾼 회로 대신 이 코드의 회로를 씁니다. 계속하시겠습니까?')) return
    setEdit({ text: sent, error: null, running: true })
    const fail = (headline: string, detail = '') => setEdit({ text: sent, error: { headline, detail, line: null } })
    try {
      // an expired token is renewed once and the run sent again (api.ts)
      const res = await authFetch(`${API}/test_code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: sent }),
      })
      if (res.status === 401) {
        // the draft stays; the app logs out and opens the login so the run can be repeated
        fail('로그인이 만료되었습니다. 다시 로그인한 뒤 실행하세요.')
        onAuthExpired?.()
        return
      }
      const data = (await res.json().catch(() => null)) as TestCodeResponse | null
      if (data?.error) return setEdit({ text: sent, error: summarizeError(data.error) })
      const graph = data?.graph
      if (!res.ok || !data) return fail(`서버가 실행 결과를 보내지 않았습니다 (HTTP ${res.status}).`)
      if (typeof data.filename !== 'string' || !graph || !Array.isArray(graph.components) || !Array.isArray(graph.nets)) {
        return fail('서버 응답 형식이 맞지 않습니다.', JSON.stringify(data).slice(0, 400))
      }
      if (!graph.components.length) return fail('넷리스트에 부품이 없습니다.')
      onApplied({ code: sent, filename: data.filename, graph, erc: data.erc, ercError: data.ercError })
      // keyboard users land on 수정 again instead of the page body (not when they moved on elsewhere)
      const ae = document.activeElement
      if (!ae || ae === document.body || paneRef.current?.contains(ae)) focusNext.current = 'editButton'
      setEdit(null)
    } catch (e) {
      fail(`실행 요청이 실패했습니다: ${(e as Error).message}`)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return
    const ta = e.currentTarget
    if (e.key === 'Escape') {
      e.preventDefault()
      releaseTab.current = true
      cancel(true)
      return
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (releaseTab.current || running) { releaseTab.current = false; return }
      e.preventDefault()
      const ed = indentLines(ta.value, ta.selectionStart, ta.selectionEnd, e.shiftKey)
      if (!ed) return
      ta.setSelectionRange(ed.start, ed.end)
      // execCommand keeps the browser's undo history; without it, fall back to a plain state update
      if (document.execCommand(ed.text ? 'insertText' : 'delete', false, ed.text)) {
        ta.setSelectionRange(ed.selStart, ed.selEnd)
      } else {
        const next = ta.value.slice(0, ed.start) + ed.text + ta.value.slice(ed.end)
        setEdit(prev => prev && { ...prev, text: next })
        requestAnimationFrame(() => taRef.current?.setSelectionRange(ed.selStart, ed.selEnd))
      }
      return
    }
    // Shift (for Shift+Tab) and other modifiers keep the Esc release, so focus can leave either way
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) releaseTab.current = false
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      run()
    }
  }

  function jumpTo(line: number) {
    const ta = taRef.current
    if (!ta || !edit) return
    const [start, end] = lineRange(edit.text, line)
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(start, end)
    ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 3)
  }

  const notes = (
    <>
      {pcbStale && (
        <div className="sf-code-note is-warn" role="status">
          <span className="sf-code-note-text">회로가 바뀌었습니다. PCB는 바뀌기 전 회로로 만든 것입니다.</span>
          <button className="sf-code-btn" onClick={onRegeneratePcb}>PCB 다시 생성</button>
        </div>
      )}
      {aiEdited && (
        <div className="sf-code-note is-info">
          <span className="sf-code-note-text">AI 편집으로 바꾼 회로는 이 코드에 없습니다. 코드를 실행하면 이 코드의 회로로 바뀝니다.</span>
        </div>
      )}
      {lastRun && <RunNotes run={lastRun} onDismiss={onDismissRun} />}
      {edit && !canRun && (
        <div className="sf-code-note is-info">
          <span className="sf-code-note-text">로그인 후 실행할 수 있습니다. 수정한 코드는 .py로 저장할 수 있습니다.</span>
        </div>
      )}
    </>
  )

  if (!edit) {
    return (
      <div className="sf-code-pane" ref={paneRef}>
        <div className="sf-code-head">
          <span className="sf-code-title">SKIDL 코드</span>
          {code && <span className="sf-code-meta">{lines.length}줄</span>}
          {code && (
            <div className="sf-code-actions">
              <button className={'sf-code-btn' + (copied === 'ok' ? ' is-ok' : copied === 'fail' ? ' is-bad' : '')} onClick={copy}>
                {copied === 'ok' ? '복사됨' : copied === 'fail' ? '복사 실패' : '복사'}
              </button>
              <button className="sf-code-btn" onClick={() => download(code)} title="circuit.py 파일로 저장">.py</button>
              <button ref={editBtnRef} className="sf-code-btn" onClick={startEdit}>수정</button>
            </div>
          )}
        </div>
        {notes}
        {code ? (
          <div className="sf-code-body">
            <div className="sf-code-rows">
              <div className="sf-code-gutter" aria-hidden="true">
                {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
              </div>
              <pre className="sf-code-view"><code>
                {lines.map((toks, i) => (
                  <span key={i}>
                    {i > 0 && '\n'}
                    {toks.map((t, j) => (t.k === 'txt' ? t.t : <span key={j} className={'tk-' + t.k}>{t.t}</span>))}
                  </span>
                ))}
              </code></pre>
            </div>
          </div>
        ) : (
          <div className="sf-code-empty">이 결과에는 저장된 코드가 없습니다.</div>
        )}
      </div>
    )
  }

  const runTitle = !canRun ? '로그인 후 실행할 수 있습니다' : !dirty ? '바뀐 내용이 없습니다' : 'Ctrl+Enter (Mac: ⌘+Enter)'
  return (
    <div className="sf-code-pane" ref={paneRef}>
      <div className="sf-code-head">
        <span className="sf-code-title">코드 수정</span>
        <span className={'sf-code-meta' + (dirty ? ' is-dirty' : '')}>{running ? '실행 중' : dirty ? '바뀜' : '바뀐 내용 없음'}</span>
        <span className="sf-code-meta" id="sf-code-keys">Tab 들여쓰기 · Ctrl+Enter 실행 · Esc 취소 · Esc 후 Tab으로 칸 나가기</span>
        <div className="sf-code-actions">
          <button className="sf-code-btn" onClick={() => download(edit.text)} title="수정한 코드를 circuit.py 파일로 저장">.py</button>
          <button className="sf-code-btn" onClick={() => cancel()} disabled={running}>취소</button>
          <button className="sf-code-btn is-primary" onClick={run} title={runTitle}
            disabled={!canRun || running || !dirty || !edit.text.trim()}>
            {running ? '실행 중…' : '실행'}
          </button>
        </div>
      </div>
      {notes}
      {edit.error && (
        <div className="sf-code-error" role="alert">
          <div className="sf-code-error-head">
            <span className="sf-code-error-title" title={edit.error.headline}>{edit.error.headline}</span>
            {errLine !== null && errLine <= editLines && (
              <button className="sf-code-btn is-bad" onClick={() => jumpTo(errLine)}>줄 {errLine}</button>
            )}
          </div>
          {edit.error.detail && edit.error.detail !== edit.error.headline && (
            <details>
              <summary>전체 출력</summary>
              <pre className="sf-code-error-detail">{edit.error.detail}</pre>
            </details>
          )}
        </div>
      )}
      <div className="sf-code-edit">
        <div className="sf-code-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: editLines }, (_, i) => <div key={i} className={i + 1 === errLine ? 'is-error' : undefined}>{i + 1}</div>)}
        </div>
        <textarea ref={taRef} className="sf-code-textarea" value={edit.text} readOnly={running}
          onChange={e => { const text = e.target.value; setEdit(prev => prev && { ...prev, text }) }}
          onKeyDown={onKeyDown}
          onBlur={() => { releaseTab.current = false }}
          onScroll={e => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop }}
          wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
          aria-label="skidl 코드 편집" aria-describedby="sf-code-keys" />
      </div>
    </div>
  )
}

/** The last run: what changed, and the report-only netlist checks of the new circuit. */
function RunNotes({ run, onDismiss }: { run: CodeRunNote; onDismiss: () => void }) {
  const changes = [
    run.added.length ? `추가 ${run.added.join(', ')}` : '',
    run.removed.length ? `삭제 ${run.removed.join(', ')}` : '',
    run.modified.length ? `변경 ${run.modified.join(', ')}` : '',
  ].filter(Boolean)
  const erc = run.erc
  const errors = erc ? ercErrorCount(erc) : 0
  const warnings = erc ? erc.filter(f => f.severity !== 'error').length : 0
  return (
    <>
      <div className="sf-code-note is-ok" role="status">
        <span className="sf-code-note-text">
          코드를 실행했습니다 · 부품 {run.parts}개 · 넷 {run.nets}개 · {changes.length ? changes.join(' · ') : '바뀐 부품 없음'}
          {erc && erc.length === 0 && ' · 회로 연결 점검 통과'}
        </span>
        <button className="sf-code-btn" onClick={onDismiss} aria-label="실행 결과 알림 닫기">닫기</button>
      </div>
      {erc && erc.length > 0 && (
        <div className="sf-code-note is-warn" role="status">
          <span className="sf-code-note-text">
            회로 연결 점검 · 오류 {errors} · 경고 {warnings}
            <ul>{erc.slice(0, 3).map((f, i) => <li key={i}>{f.message}</li>)}</ul>
            {erc.length > 3 && `외 ${erc.length - 3}건`}
          </span>
        </div>
      )}
      {erc === null && (
        <div className="sf-code-note is-info">
          <span className="sf-code-note-text">회로 연결 점검을 실행하지 못했습니다{run.ercError ? `: ${run.ercError}` : '.'}</span>
        </div>
      )}
    </>
  )
}
