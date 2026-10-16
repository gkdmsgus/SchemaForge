import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentEntry } from '../types'
import { Button, IconCheck, IconCopy, IconDownload } from './primitives'
import { TONE_COLOR } from '../lib/boardChecks'
import {
  bomCsv, bomTsv, buildBom, compactRefs, furnitureSummary, mouserSearchUrl, priceTotal, safeMouserUrl, searchKeyword, searchPkg,
  type BomBoard, type BomLine, type BomMatch,
} from '../lib/bom'

// The BOM tab: what to buy, one line per part, value and footprint. Prices and stock come
// only from a real Mouser API match; without a server key every line keeps one search link.

/** Mouser answers by line key (template|value|footprint): kept across tab switches, never reused after a change. */
const MATCHES = new Map<string, BomMatch | null>()

interface MouserResult {
  ref: string
  mouserPart?: string | null
  mfgPart?: string
  manufacturer?: string
  url?: string
  price?: string
  currency?: string
  priceQty?: number | null
  stockNum?: number | null
  error?: string
}

type Query =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'unavailable'; sig: string }
  | { state: 'error'; sig: string; message: string }
  | { state: 'done'; sig: string; asked: number; found: number; failed: number }

interface BomTableProps {
  components: ComponentEntry[]
  board: BomBoard | null
  style: 'smd' | 'tht'
  fileBase?: string
}

const money = (n: number, cur: string) => {
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return /^[A-Za-z]{3}$/.test(cur) ? `${s} ${cur}` : `${cur}${s}`
}

function PackageCell({ line }: { line: BomLine }) {
  if (line.unmapped) return <span style={{ color: TONE_COLOR.bad }} title={line.unmapped}>풋프린트 없음</span>
  if (line.footprint) return <span title={line.footprint}>{line.pkg}</span>
  return <span className="dim" title={line.stale ? '회로가 PCB를 만든 뒤 바뀌었습니다' : 'PCB를 만들면 채워집니다'}>—</span>
}

export default function BomTable({ components, board, style, fileBase }: BomTableProps) {
  const bom = useMemo(() => buildBom(components, board, style), [components, board, style])
  const [query, setQuery] = useState<Query>({ state: 'idle' })
  const [copied, setCopied] = useState<'idle' | 'done' | 'fail'>('idle')
  const [, setFetched] = useState(0)          // re-render after MATCHES changes
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current) }, [])

  if (!bom.lines.length && !bom.furniture.length) {
    return <div className="sf-bom sf-bom--empty" role="status">부품이 없습니다. 회로를 먼저 생성하세요.</div>
  }

  // messages about an earlier parts list are not shown for this one
  const sig = bom.lines.map(l => l.key).join('\n')
  const matches = new Map<string, BomMatch>()
  for (const l of bom.lines) { const m = MATCHES.get(l.key); if (m) matches.set(l.key, m) }
  const todo = bom.lines.filter(l => !MATCHES.has(l.key) && l.value && l.value !== '-')
  const total = matches.size ? priceTotal(bom.lines, matches) : null
  const priced = bom.lines.filter(l => matches.get(l.key)?.price).length
  const pieces = bom.lines.reduce((s, l) => s + l.qty, 0)

  async function searchMouser() {
    if (!todo.length) return
    setQuery({ state: 'loading' })
    try {
      const res = await fetch('/mouser_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components: todo.map(l => ({ ref: l.refs[0], value: l.value, name: l.part, pkg: searchPkg(l) || null })) }),
      })
      const data = await res.json().catch(() => null) as { available?: boolean; results?: MouserResult[]; error?: string } | null
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      if (!data || data.available !== true) { setQuery({ state: 'unavailable', sig }); return }
      const byRef = new Map((data.results ?? []).map(r => [r.ref, r]))
      let found = 0, failed = 0
      for (const l of todo) {
        const r = byRef.get(l.refs[0])
        if (!r || r.error) { failed++; continue }          // not cached: can be asked again
        if (!r.mouserPart) { MATCHES.set(l.key, null); continue }
        MATCHES.set(l.key, {
          mouserPart: r.mouserPart, mfgPart: r.mfgPart, manufacturer: r.manufacturer, url: r.url, price: r.price, currency: r.currency,
          priceQty: typeof r.priceQty === 'number' && r.priceQty > 0 ? r.priceQty : null,
          stockNum: typeof r.stockNum === 'number' && Number.isFinite(r.stockNum) ? r.stockNum : null,
        })
        found++
      }
      setFetched(n => n + 1)
      setQuery({ state: 'done', sig, asked: todo.length, found, failed })
    } catch (e) {
      setQuery({ state: 'error', sig, message: (e as Error).message })
    }
  }

  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([bomCsv(bom, matches)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase || 'SchemaForge'}_BOM.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async function copyTsv() {
    try {
      await navigator.clipboard.writeText(bomTsv(bom, matches))
      setCopied('done')
    } catch {
      setCopied('fail')
    }
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied('idle'), 2000)
  }

  const current = query.state !== 'idle' && query.state !== 'loading' && query.sig === sig ? query : null
  const shop = matches.size > 0

  return (
    <div className="sf-bom">
      <div className="sf-bom__bar">
        <Button type="button" variant="secondary" size="sm" icon={<IconDownload size={14} />} onClick={downloadCsv}>부품표 CSV</Button>
        <Button type="button" variant="ghost" size="sm" icon={copied === 'done' ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copyTsv}>
          {copied === 'done' ? '복사됨' : '표 복사'}
        </Button>
        <Button type="button" variant="outline" size="sm" loading={query.state === 'loading'} disabled={!todo.length}
          title={todo.length ? 'Mouser에서 줄마다 하나씩 찾습니다' : '모든 줄을 조회했습니다'} onClick={searchMouser}>
          Mouser 가격 조회
        </Button>
        <span className="sf-bom__summary">
          {bom.lines.length}종 · {pieces}개 · {style.toUpperCase()} 기준{bom.fromBoard ? '' : ' · 패키지는 PCB를 만들면 채워집니다'}
        </span>
      </div>

      <div className="sf-bom__scroll">
        <table data-testid="bom-table">
          <caption className="sr-only">부품표</caption>
          <thead>
            <tr>
              <th scope="col" className="num">수량</th>
              <th scope="col">부품 번호</th>
              <th scope="col">값</th>
              <th scope="col">종류</th>
              <th scope="col">패키지</th>
              <th scope="col">비고</th>
              <th scope="col">링크</th>
              {shop && <th scope="col">Mouser 부품 번호</th>}
              {shop && <th scope="col" className="num">단가</th>}
              {shop && <th scope="col" className="num">재고</th>}
            </tr>
          </thead>
          <tbody>
            {bom.lines.map(l => {
              const m = matches.get(l.key)
              const product = m ? safeMouserUrl(m.url) : null
              const keyword = searchKeyword(l)
              const refs = l.refs.join(', ')
              const notes = [l.pinout ? `핀 배열 기준 ${l.pinout}` : '', ...l.notes].filter(Boolean).join(' · ')
              return (
                <tr key={l.key} data-testid="bom-line" data-refs={l.refs.join(',')}>
                  <td className="num">{l.qty}</td>
                  <td className="ref">{refs}</td>
                  <td className="val">{l.value || '—'}</td>
                  <td>{l.type}</td>
                  <td><PackageCell line={l} /></td>
                  <td className="note">{notes}</td>
                  <td>
                    {product ? (
                      <a href={product} target="_blank" rel="noopener noreferrer" aria-label={`${refs} Mouser 제품 페이지 (새 창)`}>제품</a>
                    ) : keyword ? (
                      <a href={mouserSearchUrl(keyword)} target="_blank" rel="noopener noreferrer" title={keyword}
                        aria-label={`${refs} Mouser에서 ${keyword} 검색 (새 창)`}>검색</a>
                    ) : <span className="dim">—</span>}
                  </td>
                  {shop && <td className="mono">{m?.mouserPart ?? (MATCHES.has(l.key) ? <span className="dim">찾지 못함</span> : '')}</td>}
                  {shop && <td className="num">{m?.price || ''}{m?.price && (m.priceQty ?? 1) > 1 ? <span className="dim"> ({m.priceQty}개부터)</span> : null}</td>}
                  {shop && (
                    <td className="num" style={m?.stockNum != null && m.stockNum < l.qty ? { color: TONE_COLOR.bad } : undefined}>
                      {m?.stockNum != null ? m.stockNum.toLocaleString() : ''}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
          {shop && priced > 0 && (
            <tfoot>
              <tr>
                <td colSpan={10}>
                  {total
                    ? <>합계 <strong className="mono">{money(total.total, total.currency)}</strong> · 1개 단가 기준 · 가격 확인 {total.priced}/{bom.lines.length}종</>
                    : bom.lines.some(l => { const m = matches.get(l.key); return !!m?.price && (m.priceQty ?? 1) <= 1 })
                      ? <>통화나 가격 형식이 줄마다 다르거나 읽을 수 없는 형식이라 합계를 내지 않습니다.</>
                      : <>1개 단가가 있는 줄이 없어(릴 단위 가격만 있음) 합계를 내지 않습니다.</>}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {bom.stale.length > 0 && (
        <p className="sf-bom__note">
          회로가 PCB를 만든 뒤 바뀌었습니다 ({compactRefs(bom.stale)}). PCB를 다시 만들면 패키지가 채워집니다.
        </p>
      )}
      {bom.furniture.length > 0 && (
        <p className="sf-bom__note">구매 불필요 · 기판에 포함: {furnitureSummary(bom.furniture)}</p>
      )}
      <p className="sf-bom__note" role="status">
        {current?.state === 'unavailable' && 'Mouser 키가 서버에 없어 가격·재고를 보여주지 않습니다. 각 줄의 검색 링크를 쓰세요.'}
        {current?.state === 'done' && `Mouser에서 ${current.found}/${current.asked}종을 찾았습니다.${current.failed ? ` ${current.failed}종은 조회하지 못해 다시 조회할 수 있습니다.` : ''}`}
        {copied === 'done' && <span className="sr-only">표를 복사했습니다.</span>}
      </p>
      {(current?.state === 'error' || copied === 'fail') && (
        <p className="sf-bom__note" role="alert" style={{ color: TONE_COLOR.bad }}>
          {current?.state === 'error' && `Mouser 조회에 실패했습니다 (${current.message}). `}
          {copied === 'fail' && '클립보드에 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하세요.'}
        </p>
      )}
    </div>
  )
}
