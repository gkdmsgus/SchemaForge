// Dev-only harness: runs /generate_pcb_stream against an existing netlist and mounts
// BoardView with it, so the board view (placement, routing, checks, AI rounds, 3D) can
// be looked at and scripted without signing in. Not part of the app bundle.
//
//   http://localhost:3000/dev/board.html?net=ai_check.net&style=smd&ai=0
//
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import BoardView from '../src/components/BoardView'
import type {
  BoardPart, BoardFrame, BoardModel, RouteEvent, DrcResult, AiRound,
} from '../src/types'

interface Board {
  parts: BoardPart[]
  frames: BoardFrame[]
  routes: RouteEvent[]
  target: [number, number, number, number] | null
  final: BoardModel | null
  drc: DrcResult | null
  ai: AiRound[]
  status: 'streaming' | 'done' | 'error'
}

function Harness() {
  const q = new URLSearchParams(location.search)
  const [b, setB] = useState<Board>({
    parts: [], frames: [], routes: [], target: null, final: null, drc: null, ai: [], status: 'streaming',
  })
  const [shelf, setShelf] = useState<number | undefined>()
  const [pcbFile, setPcbFile] = useState<string | undefined>()

  useEffect(() => {
    const body = {
      filename: q.get('net') || 'ai_check.net',
      style: q.get('style') || 'smd',
      ai: q.get('ai') === '1',
    }
    let stop = false
    ;(async () => {
      const res = await fetch('/generate_pcb_stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      // same block-by-block reader as ResultPanel, so the harness cannot drift from the app
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (!stop) {
        const chunk = await reader.read()
        if (chunk.done) break
        buf += dec.decode(chunk.value, { stream: true })
        const blocks = buf.split('\n\n')
        buf = blocks.pop() ?? ''
        for (const block of blocks) {
          const ev = /^event: (\w+)/m.exec(block)?.[1]
          const raw = /^data: (.*)$/m.exec(block)?.[1]
          if (!ev || !raw) continue
          const d = JSON.parse(raw)
          setB(prev => {
            switch (ev) {
              case 'parts': return { ...prev, parts: d.parts }
              case 'init': return { ...prev, target: d.frame }
              case 'frame': return { ...prev, frames: [...prev.frames, d as BoardFrame] }
              case 'route': case 'rip': return { ...prev, routes: [...prev.routes, d as RouteEvent] }
              case 'drc': return { ...prev, drc: d as DrcResult }
              case 'ai': return { ...prev, ai: [...prev.ai, d as AiRound] }
              case 'done': return { ...prev, final: d.board, status: 'done' }
              case 'error': return { ...prev, status: 'error' }
              default: return prev
            }
          })
          if (ev === 'done') { setShelf(d.summary?.hpwl_shelf); setPcbFile(d.pcbFilename) }
        }
      }
    })().catch(() => setB(p => ({ ...p, status: 'error' })))
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <BoardView pcbFilename={pcbFile} parts={b.parts} frames={b.frames} routes={b.routes} target={b.target}
        final={b.final} drc={b.drc} ai={b.ai} status={b.status} hpwlShelf={shelf} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
