import { useMemo } from 'react'
import type { BoardPart, BoardTrack, BoardVia } from '../types'
import {
  type Camera, type Face,
  boardFaces, partFaces, trackFace, viaFaces, sortFaces, facesBounds, partHeight, project,
} from '../lib/board3d'

// The same board data as BoardView, drawn as a tilted 3D view in plain SVG.
// It is fed the interpolated poses of the 2D view, so both move together.

interface Props {
  parts: BoardPart[]
  poses: Record<string, [number, number, number]>
  tracks: BoardTrack[]
  vias: BoardVia[]
  outline: [number, number, number, number] | null
  cam: Camera
  zoom: number
  showLayer: Record<string, boolean>
  hoverNet?: string | null
}

export default function Board3D({ parts, poses, tracks, vias, outline, cam, zoom, showLayer, hoverNet }: Props) {
  const byRef = useMemo(() => Object.fromEntries(parts.map(p => [p.ref, p])), [parts])

  const faces = useMemo(() => {
    const out: Face[] = []
    if (outline) out.push(...boardFaces(outline, cam))
    for (const t of tracks) if (showLayer[t.layer] !== false) out.push(trackFace(t, cam))
    for (const v of vias) out.push(...viaFaces(v, cam))
    for (const [ref, [x, y, r]] of Object.entries(poses)) {
      const p = byRef[ref]
      if (p) out.push(...partFaces(p, x, y, r, cam))
    }
    return sortFaces(out)
  }, [parts, poses, tracks, vias, outline, cam, showLayer, byRef])

  // labels sit on top of each part's box, projected the same way
  const labels = useMemo(() => {
    return Object.entries(poses).map(([ref, [x, y]]) => {
      const p = byRef[ref]
      if (!p) return null
      const h = partHeight(p.footprint, p.part)
      const ax = (p.bbox[0] + p.bbox[2]) / 2, ay = (p.bbox[1] + p.bbox[3]) / 2
      const [sx, sy] = project(x + ax, y + ay, h, cam)
      const size = Math.max(0.5, Math.min(1.1, (p.bbox[2] - p.bbox[0]) * 0.3))
      return { ref, sx, sy, size }
    }).filter(Boolean) as { ref: string; sx: number; sy: number; size: number }[]
  }, [poses, byRef, cam])

  const view = useMemo(() => {
    const [x1, y1, x2, y2] = facesBounds(faces)
    const w = Math.max(x2 - x1, 1) / zoom, h = Math.max(y2 - y1, 1) / zoom
    const m = Math.max(w, h) * 0.06
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
    return `${cx - w / 2 - m} ${cy - h / 2 - m} ${w + m * 2} ${h + m * 2}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, cam, zoom, faces.length])

  return (
    <svg data-testid="board-3d" viewBox={view} width="100%" height="100%"
      style={{ display: 'block', background: '#efefe9' }}>
      {faces.map((f, k) => (
        <polygon key={k} data-kind={f.kind} data-ref={f.ref} data-net={f.net}
          points={f.pts.map(p => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ')}
          fill={f.fill} stroke={f.stroke} strokeWidth={f.strokeWidth}
          opacity={hoverNet && f.net && f.net !== hoverNet ? 0.3 : f.opacity} />
      ))}
      {labels.map(l => (
        <text key={l.ref} data-label={l.ref} x={l.sx} y={l.sy} fontSize={l.size} fill="#20242a"
          textAnchor="middle" dominantBaseline="central" fontFamily="var(--sf-font-mono)"
          opacity={0.85} style={{ pointerEvents: 'none' }}>{l.ref}</text>
      ))}
    </svg>
  )
}
