import { useState } from 'react'

const COMP_NAMES = { R:'저항', C:'캐패시터', Q:'트랜지스터', D:'다이오드/LED', L:'인덕터', U:'IC', Y:'크리스탈', SW:'스위치', J:'커넥터', K:'릴레이', LS:'스피커/버저', BT:'배터리' }

function getCompColor(ref) {
  return ({ R:'#fbbf24', C:'#60a5fa', Q:'#34d399', D:'#f87171', L:'#a78bfa', U:'#22d3ee', K:'#fb923c', LS:'#e879f9', BT:'#4ade80' })[ref.replace(/\d+/g, '')] || '#94a3b8'
}

function shopLink(value, ref) {
  if (!value || value === '-') return null
  const q = encodeURIComponent(value)
  return (
    <a className="shop-link mouser" href={`https://kr.mouser.com/Search/Refine?Keyword=${q}`} target="_blank" rel="noopener">검색</a>
  )
}

export default function BomTable({ components, guide }) {
  if (!components?.length) return null
  const [mouserData, setMouserData] = useState(null)   // API 검색 결과
  const [loading, setLoading] = useState(false)
  const [cartUrl, setCartUrl] = useState(null)
  const [cartLoading, setCartLoading] = useState(false)
  const [mockMode, setMockMode] = useState(false)

  const roles = {}
  if (guide) {
    guide.split('\n').forEach(line => {
      const m = line.match(/^-\s+([A-Z]+\d+)[^:]*:\s*(.+)/)
      if (m) roles[m[1]] = m[2].trim()
    })
  }

  async function searchMouser() {
    setLoading(true)
    try {
      const res = await fetch('/mouser_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      // ref → mouser 결과 매핑
      const map = {}
      data.results.forEach(r => { map[r.ref] = r })
      setMouserData(map)
      setCartUrl(data.cartUrl)
      setMockMode(!!data.mockMode)
    } catch (e) {
      console.error('Mouser search failed:', e)
      alert('Mouser 검색 실패: ' + e.message)
    }
    setLoading(false)
  }

  function downloadBomCsv() {
    const header = 'Qty,Mouser Part Number,Manufacturer Part,Reference,Value,Description\n'
    const rows = components.map(c => {
      const type = c.ref.replace(/\d+/g, '')
      const desc = roles[c.ref] || COMP_NAMES[type] || type
      const m = mouserData?.[c.ref]
      const mouserPart = m?.mouserPart || ''
      const mfgPart = m?.mfgPart || ''
      return `1,"${mouserPart}","${mfgPart}","${c.ref}","${c.value || ''}","${desc}"`
    }).join('\n')
    const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'SchemaForge_BOM.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  // Compute total estimated cost when Mouser data available
  let totalCost = 0
  let pricedCount = 0
  if (mouserData) {
    components.forEach(c => {
      const m = mouserData[c.ref]
      if (m?.priceNum) { totalCost += m.priceNum; pricedCount += 1 }
      else if (m?.price) {
        const num = parseFloat(String(m.price).replace(/[^\d.]/g, ''))
        if (!isNaN(num)) { totalCost += num; pricedCount += 1 }
      }
    })
  }

  return (
    <div className="card">
      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="dot" style={{background:'var(--amber)'}}></span>
        필요한 부품 (BOM)
        {mockMode && (
          <span style={{
            fontFamily: 'var(--sf-font-mono)', fontSize: 10,
            color: 'var(--sf-amber)', letterSpacing: '0.14em',
            padding: '3px 8px',
            background: 'var(--sf-amber-soft)',
            border: '1px solid var(--sf-amber-line)',
            borderRadius: 'var(--sf-r-pill)',
          }}>MOCK · API 승인 대기 중</span>
        )}
      </div>

      <div className="bom-actions">
        {!mouserData ? (
          <button className="bom-btn mouser-btn" onClick={searchMouser} disabled={loading}>
            {loading ? '⏳ Mouser 검색 중...' : '🔍 Mouser 부품 자동 매칭'}
          </button>
        ) : (
          <>
            <button className="bom-btn csv-btn" onClick={downloadBomCsv}>
              ↓ BOM CSV 다운로드
            </button>
            <button className="bom-btn cart-btn" onClick={() => {
              const matched = Object.values(mouserData).filter(m => m?.mouserPart)
              if (!matched.length) { alert('매칭된 부품이 없습니다'); return }
              // 각 부품의 상세 페이지를 열어서 바로 장바구니에 담을 수 있게
              matched.forEach((m, i) => {
                setTimeout(() => window.open(m.url, '_blank'), i * 400)
              })
            }}>
              🛒 Mouser에서 구매하기 ({Object.values(mouserData).filter(m => m?.mouserPart).length}개)
            </button>
            <button className="bom-btn search-btn" onClick={() => {
              // 매칭된 각 부품 상세 페이지를 개별 탭으로 열기
              const matched = Object.values(mouserData).filter(m => m?.url)
              matched.forEach((m, i) => {
                setTimeout(() => window.open(m.url, '_blank'), i * 300)
              })
            }}>
              🔗 각 부품 페이지 열기
            </button>
            <button className="bom-btn csv-btn" style={{opacity:0.7}} onClick={searchMouser} disabled={loading}>
              ↻ 다시 검색
            </button>
          </>
        )}
      </div>

      <div className="bom-table-wrap">
        <table className="bom-table">
          <thead>
            <tr>
              <th>#</th><th>부품번호</th><th>종류</th><th>값</th><th>역할</th>
              {mouserData && <th>Mouser 파트</th>}
              {mouserData && <th>가격</th>}
              {mouserData && <th>재고</th>}
              <th>구매</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c, i) => {
              const type = c.ref.replace(/\d+/g, '')
              const m = mouserData?.[c.ref]
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><span className="bom-ref" style={{color: getCompColor(c.ref)}}>{c.ref}</span></td>
                  <td>{COMP_NAMES[type] || type}</td>
                  <td className="bom-val">{c.value || '-'}</td>
                  <td className="bom-role">{roles[c.ref] || '-'}</td>
                  {mouserData && (
                    <td className="bom-mouser-part">
                      {m?.mouserPart ? (
                        <a href={m.url} target="_blank" rel="noopener" className="mouser-part-link">
                          {m.mouserPart}
                        </a>
                      ) : <span className="no-match">매칭 없음</span>}
                    </td>
                  )}
                  {mouserData && (
                    <td className="bom-price">{m?.price || '-'}</td>
                  )}
                  {mouserData && (
                    <td className="bom-stock" style={{
                      fontFamily: 'var(--sf-font-mono)', fontSize: 12,
                      color: m?.stock && Number(m.stock) > 1000 ? '#5dc8a3' :
                             m?.stock && Number(m.stock) > 0    ? '#ffc56f' : 'var(--sf-fg-dim)',
                    }}>
                      {m?.stock ? Number(m.stock).toLocaleString() : '-'}
                    </td>
                  )}
                  <td className="bom-shop">
                    {m?.url ? (
                      <a className="shop-link mouser" href={m.url} target="_blank" rel="noopener">Mouser</a>
                    ) : shopLink(c.value, c.ref)}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            {mouserData && pricedCount > 0 && (
              <tr className="bom-total" style={{ background: 'var(--sf-bg-3)' }}>
                <td colSpan={6} style={{ textAlign: 'right', fontFamily: 'var(--sf-font-mono)', fontSize: 12, color: 'var(--sf-fg-muted)' }}>
                  단가 합계 (1개씩 기준)
                </td>
                <td colSpan={3} style={{
                  fontFamily: 'var(--sf-font-mono)', fontWeight: 700,
                  color: 'var(--sf-amber)', fontSize: 13,
                }}>
                  ${totalCost.toFixed(2)}
                  <span style={{ fontWeight: 400, color: 'var(--sf-fg-dim)', fontSize: 11, marginLeft: 6 }}>
                    · {pricedCount}/{components.length}개 매칭
                  </span>
                </td>
              </tr>
            )}
            <tr className="bom-total">
              <td colSpan={mouserData ? 8 : 5}>총 부품 수</td>
              <td><strong>{components.length}개</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
