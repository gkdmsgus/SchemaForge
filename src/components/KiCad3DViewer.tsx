import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MARK_COLOR, type BoardMark } from '../lib/humanReview'

interface Props {
  pcbFilename: string
  // the server keeps the file name when the same netlist is made again (SMD -> THT): a new value loads the new model
  // instead of the browser's cached copy of the old one
  version?: string | null
  selected?: string | null              // part picked: tinted violet
  checked?: string[]                    // a check badge floats over each (confirmed in the PCB view, placed in 배치하기)
  focus?: string[]                      // parts lit up from outside, e.g. the list line under the mouse
  marks?: BoardMark[]                   // labels drawn at board positions
  layout?: { ref: string; x: number; y: number }[]   // part origins in board mm, to put the marks on the model
  hoverLabel?: (ref: string) => string | null        // tooltip for the part under the mouse; none = no hover light
  view?: 'iso' | 'top'                  // camera: looking down the diagonal, or straight down like the 2D drawing
  resetKey?: number                     // a new value puts the camera back
  margin?: number                       // room around the board when the camera fits it (panels drawn over the view need more)
  onPick?: (ref: string) => void        // click (not drag) on a part
  onLoad?: (parts: string[], marksPlaced: boolean) => void   // parts with a 3D model; whether marks can be drawn on it
  onError?: () => void
}

// KiCad names each footprint's node in the GLB by its reference (C1, Q1, J2...).
const REF_NODE = /^[A-Za-z]+[0-9]+$/
const PICK_COLOR = new THREE.Color('#6a4cb5')
const LIGHT_COLOR = new THREE.Color('#e3a32e')
const OK = '#176b5d'
const NEAR_M = 0.001                    // a press on the board within 1 mm of a part (on the board plane) picks it
const MARK_OUT = 16                     // px from a pad to its label, away from the part's centre: + and − on a 2 mm part stay apart

/** The tooltip next to the pointer, flipped to its left or above it where it would leave the pane. */
function placeTip(pane: HTMLElement | null, tip: HTMLElement | null, at: { x: number; y: number } | null) {
  if (!pane || !tip || !at) return
  const w = tip.offsetWidth, h = tip.offsetHeight
  let x = at.x + 14, y = at.y + 16
  if (x + w > pane.clientWidth - 4) x = Math.max(4, at.x - 10 - w)
  if (y + h > pane.clientHeight - 4) y = Math.max(4, at.y - 10 - h)
  tip.style.transform = `translate(${x}px, ${y}px)`
}

/** Interactive viewer for KiCad's real board GLB, including component models. */
export default function KiCad3DViewer({ pcbFilename, version = null, selected = null, checked = [], focus = [], marks = [], layout = [],
  hoverLabel, view = 'iso', resetKey = 0, margin = 1.35, onPick, onLoad, onError }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [modelled, setModelled] = useState<string[]>([])        // parts that have a 3D model
  const [hover, setHover] = useState<string | null>(null)
  const partsRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const anchorsRef = useRef<Map<string, THREE.Vector3>>(new Map())  // top centre of each part
  const badgeEls = useRef<Record<string, HTMLDivElement | null>>({})
  const markEls = useRef<Record<string, HTMLDivElement | null>>({})
  const tipEl = useRef<HTMLDivElement>(null)
  const tipAt = useRef<{ x: number; y: number } | null>(null)     // pointer in the viewer, for the tooltip
  const placeCamera = useRef<(v: 'iso' | 'top') => void>(() => {})
  const latest = useRef({ onPick, onLoad, onError, hoverLabel, marks, layout, view, margin })
  latest.current = { onPick, onLoad, onError, hoverLabel, marks, layout, view, margin }
  // a green tint is lost on a green board, so checked parts get a badge (as in 2D) instead
  const okRefs = checked.filter(r => modelled.includes(r)).sort()
  const focusKey = focus.join(',')
  const tip = hover ? hoverLabel?.(hover) ?? null : null

  // tint: the picked part violet, the part under the mouse and the parts lit from outside amber; light enough
  // that the part's own marks (an electrolytic's black half-moon, a chip LED's green line) still show
  useEffect(() => {
    if (state !== 'ready') return
    const lit = new Set(focusKey ? focusKey.split(',') : [])
    for (const [ref, node] of partsRef.current) {
      const [tint, strength]: [THREE.Color | null, number] = ref === selected ? [PICK_COLOR, 0.35]
        : ref === hover ? [LIGHT_COLOR, 0.45]
        : lit.has(ref) ? [LIGHT_COLOR, 0.4] : [null, 0]
      node.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!(m instanceof THREE.MeshStandardMaterial)) continue
          const base = m.userData.baseEmissive as THREE.Color | undefined
          m.emissive.copy(tint ?? base ?? new THREE.Color(0, 0, 0))
          m.emissiveIntensity = tint ? strength : (m.userData.baseIntensity ?? 1)
        }
      })
    }
  }, [state, selected, hover, focusKey])

  useEffect(() => { if (state === 'ready') placeCamera.current(view) }, [state, view, resetKey])

  // new text has a new size: place it again where the pointer is
  useEffect(() => { placeTip(host.current, tipEl.current, tipAt.current) }, [tip])

  useEffect(() => {
    const el = host.current
    if (!el) return
    setState('loading')
    setModelled([])
    setHover(null)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#e8e8e2')
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // CSS size follows the panel; the drawing buffer is panel size x devicePixelRatio. Without this the
    // canvas shows at DPR x its CSS size on HiDPI screens and only its top-left part is visible.
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    el.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x59606d, 2.2))
    // KiCad's GLB is Y-up in metres (the board lies in the X-Z plane), so lights come from +Y
    const key = new THREE.DirectionalLight(0xffffff, 3.2)
    key.position.set(4, 8, 5)
    key.castShadow = true
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xb9d0ff, 1.4)
    fill.position.set(-5, 3, -2)
    scene.add(fill)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.screenSpacePanning = true
    controls.minDistance = 0.01
    controls.maxDistance = 10000

    let frame = 0
    let disposed = false
    let model: THREE.Object3D | null = null
    let boxes = new Map<string, THREE.Box3>()                     // each part's box, for picking near a part
    let bases = new Map<string, THREE.Vector3>()                  // each part's centre on the board top: marks point away from it
    // board mm -> model: x/1000 + ox, top, y/1000 + oz (null until the parts confirm it)
    let toModel: { ox: number; oz: number; top: number } | null = null
    let fit: { center: THREE.Vector3; radius: number } | null = null

    const resize = () => {
      const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()

    // badges and marks follow the board: project each one every frame (hidden behind the camera)
    const tmp = new THREE.Vector3()
    const put = (node: HTMLDivElement | null | undefined, at: THREE.Vector3 | null) => {
      if (!node) return
      if (!at) { node.style.display = 'none'; return }
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight
      tmp.copy(at).project(camera)
      const off = tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05
      node.style.display = off ? 'none' : 'grid'
      node.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`
    }
    const markAt = new THREE.Vector3(), baseAt = new THREE.Vector3()
    const toScreen = (v: THREE.Vector3): [number, number, boolean] => {
      v.project(camera)
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h, v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05]
    }
    // a mark is a dot on its pad and a label pushed out from the part's centre, joined by a short line
    const placeMark = (node: HTMLDivElement, m: BoardMark) => {
      if (!toModel) { node.style.display = 'none'; return }
      const [px, py, off] = toScreen(markAt.set(m.x / 1000 + toModel.ox, toModel.top, m.y / 1000 + toModel.oz))
      if (off) { node.style.display = 'none'; return }
      const base = bases.get(m.key.slice(0, m.key.indexOf(':')))
      let dx = 0, dy = -1
      if (base) {
        const [bx, by] = toScreen(baseAt.copy(base))
        const len = Math.hypot(px - bx, py - by)
        if (len > 0.5) { dx = (px - bx) / len; dy = (py - by) / len }
      }
      node.style.display = 'block'
      node.style.transform = `translate(${px}px, ${py}px)`
      const [, line, label] = node.children as unknown as HTMLElement[]
      line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`
      label.style.transform = `translate(${dx * MARK_OUT}px, ${dy * MARK_OUT}px)`
    }
    const placeOverlays = () => {
      for (const [ref, badge] of Object.entries(badgeEls.current)) put(badge, anchorsRef.current.get(ref) ?? null)
      for (const m of latest.current.marks) {
        const node = markEls.current[m.key]
        if (node) placeMark(node, m)
      }
    }

    // a click (pointer moved under 5 px, 10 px for a finger) picks the part under the cursor; a drag orbits
    const ray = new THREE.Raycaster()
    const refOf = (o: THREE.Object3D | null): string | null => {
      for (let cur = o; cur; cur = cur.parent) {
        if (partsRef.current.get(cur.name) === cur) return cur.name
      }
      return null
    }
    const normal = new THREE.Vector3()
    /**
     * A small part is hard to hit exactly: a press on the board's top face picks the part whose outline on the
     * board is nearest, within 1 mm. Measured on the board plane, so a tall part's screen shadow never wins, and
     * only from above: seen from under the board, the parts on top are hidden and are not picked.
     */
    const nearPart = (hit: THREE.Intersection): string | null => {
      if (!hit.face) return null
      normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      if (normal.y < 0.5 || camera.position.y <= hit.point.y) return null
      let best: string | null = null, bestD = NEAR_M
      for (const [ref, b] of boxes) {
        const d = Math.hypot(Math.max(b.min.x - hit.point.x, 0, hit.point.x - b.max.x), Math.max(b.min.z - hit.point.z, 0, hit.point.z - b.max.z))
        if (d < bestD) { best = ref; bestD = d }
      }
      return best
    }
    const pickAt = (clientX: number, clientY: number): string | null => {
      if (!model) return null
      const r = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      // the first thing the ray meets decides: a part, or the board's top face (then a part within 1 mm of the spot)
      const first = ray.intersectObject(model, true)[0]
      return first ? refOf(first.object) ?? nearPart(first) : null
    }

    // the part under the mouse lights up (when the page gives it a label); worked out once per frame at most
    let pointer: { x: number; y: number } | null = null
    let hoverDirty = false, hoverNow: string | null = null
    const pressed = new Set<number>()
    const updateHover = () => {
      hoverDirty = false
      let ref = pointer && !pressed.size ? pickAt(pointer.x, pointer.y) : null
      if (ref && !latest.current.hoverLabel?.(ref)) ref = null
      if (ref === hoverNow) return
      hoverNow = ref
      renderer.domElement.style.cursor = ref ? 'pointer' : ''
      setHover(ref)
    }
    controls.addEventListener('change', () => { if (pointer) hoverDirty = true })

    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      placeOverlays()
      if (hoverDirty) updateHover()
      frame = requestAnimationFrame(animate)
    }
    animate()

    let down: { x: number; y: number; slop: number } | null = null
    const onDown = (e: PointerEvent) => {
      pressed.add(e.pointerId)
      // left button only (right drags pan, the wheel zooms); a second finger makes it a pinch, not a tap
      down = e.button === 0 && pressed.size === 1 ? { x: e.clientX, y: e.clientY, slop: e.pointerType === 'mouse' ? 5 : 10 } : null
      hoverDirty = true
    }
    const onUp = (e: PointerEvent) => {
      pressed.delete(e.pointerId)
      hoverDirty = true
      if (!down || e.button !== 0) { if (!pressed.size) down = null; return }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > down.slop
      down = null
      if (moved) return
      const ref = pickAt(e.clientX, e.clientY)
      if (ref) latest.current.onPick?.(ref)
    }
    const onCancel = (e: PointerEvent) => { pressed.delete(e.pointerId); down = null }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      pointer = { x: e.clientX, y: e.clientY }
      hoverDirty = true
      const r = el.getBoundingClientRect()
      tipAt.current = { x: e.clientX - r.left, y: e.clientY - r.top }
      placeTip(el, tipEl.current, tipAt.current)
    }
    const onLeave = () => { pointer = null; tipAt.current = null; hoverDirty = true }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onCancel)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    // dev builds: where a part's centre lands on screen, so UI checks can click it
    if (import.meta.env.DEV) {
      Object.assign(el, {
        __sfPartAt: (ref: string): [number, number] | null => {
          const node = partsRef.current.get(ref)
          if (!node) return null
          const c = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3()).project(camera)
          const r = renderer.domElement.getBoundingClientRect()
          return [r.left + ((c.x + 1) / 2) * r.width, r.top + ((1 - c.y) / 2) * r.height]
        },
        __sfPickAt: pickAt,
        // a point on the board's top face (board mm) on screen, or null before the model is matched to the board
        __sfBoardAt: (x: number, y: number): [number, number] | null => {
          if (!toModel) return null
          const c = new THREE.Vector3(x / 1000 + toModel.ox, toModel.top, y / 1000 + toModel.oz).project(camera)
          const r = renderer.domElement.getBoundingClientRect()
          return [r.left + ((c.x + 1) / 2) * r.width, r.top + ((1 - c.y) / 2) * r.height]
        },
      })
    }

    // the camera looks down the diagonal like the reel's 3D shot, or straight down with the board's top edge up
    placeCamera.current = (v: 'iso' | 'top') => {
      if (!fit) return
      // a flick just before keeps turning the camera after it is placed (damping): spend it first
      controls.enableDamping = false
      controls.update()
      controls.enableDamping = true
      // Fit the bounding sphere to the smaller viewport dimension, at the pane's size now (it may have
      // changed since the model came in). The margin keeps the board clear of panels drawn over the view.
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2)
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect)
      const distance = (fit.radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * latest.current.margin
      const dir = v === 'top' ? new THREE.Vector3(0, 1, 0.001) : new THREE.Vector3(0.9, 1.1, 1)   // +Y is up in the GLB
      controls.target.copy(fit.center)
      camera.position.copy(fit.center).add(dir.normalize().multiplyScalar(distance * (v === 'top' ? 0.92 : 1)))
      camera.up.set(0, 1, 0)
      camera.updateProjectionMatrix()
      controls.update()
    }

    new GLTFLoader().load(
      `/board_model?pcb=${encodeURIComponent(pcbFilename)}${version ? `&v=${encodeURIComponent(version)}` : ''}`,
      gltf => {
        if (disposed) return
        model = gltf.scene
        scene.add(model)
        model.traverse(o => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true
            o.receiveShadow = true
            // KiCad exports the solder mask as translucent green over a beige FR4 core; under these
            // lights that reads as pale mint. It stays translucent (opaque layers z-fight with the
            // copper under them) but gets the deeper green and cover of a real board.
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) {
              if (m instanceof THREE.MeshStandardMaterial && m.transparent &&
                  m.color.g > m.color.r && m.color.g > m.color.b) {
                m.color.setRGB(0.02, 0.16, 0.06)
                m.opacity = Math.max(m.opacity, 0.94)
                m.needsUpdate = true
              }
            }
          }
        })

        // parts by reference; each gets its own materials so tinting one does not tint its twins
        // (R1, R2 and R3 share one mesh and material in the file)
        const parts = new Map<string, THREE.Object3D>()
        model.traverse(o => { if (REF_NODE.test(o.name) && !parts.has(o.name)) parts.set(o.name, o) })
        for (const node of parts.values()) {
          node.traverse(o => {
            if (!(o instanceof THREE.Mesh)) return
            const own = (m: THREE.Material) => {
              const c = m.clone()
              if (c instanceof THREE.MeshStandardMaterial) {
                c.userData.baseEmissive = c.emissive.clone()
                c.userData.baseIntensity = c.emissiveIntensity
              }
              return c
            }
            o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material)
          })
        }
        model.updateMatrixWorld(true)
        partsRef.current = parts
        boxes = new Map([...parts].map(([ref, node]) => [ref, new THREE.Box3().setFromObject(node)]))
        anchorsRef.current = new Map([...boxes].map(([ref, b]) => {
          const c = b.getCenter(new THREE.Vector3())
          return [ref, new THREE.Vector3(c.x, b.max.y, c.z)]       // GLB is Y-up
        }))

        // KiCad puts each footprint's node at its position in metres (x, board top, y): check that against the
        // board file's own positions before drawing marks, so a different export never puts a + on the wrong pad
        const pairs = latest.current.layout.flatMap(p => {
          const node = parts.get(p.ref)
          if (!node) return []
          const w = node.getWorldPosition(new THREE.Vector3())
          return [{ dx: w.x - p.x / 1000, dz: w.z - p.y / 1000, top: w.y }]
        })
        const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
        if (pairs.length) {
          const ox = median(pairs.map(q => q.dx)), oz = median(pairs.map(q => q.dz))
          const off = Math.max(...pairs.map(q => Math.max(Math.abs(q.dx - ox), Math.abs(q.dz - oz))))
          toModel = off < 0.0003 ? { ox, oz, top: median(pairs.map(q => q.top)) } : null      // within 0.3 mm
        }

        bases = new Map([...boxes].map(([ref, b]) => {
          const c = b.getCenter(new THREE.Vector3())
          return [ref, new THREE.Vector3(c.x, toModel?.top ?? b.min.y, c.z)]
        }))

        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const radius = Math.max(sphere.radius, 0.01)
        camera.near = radius / 1000
        camera.far = radius * 100
        fit = { center, radius }
        controls.minDistance = radius * 0.35
        controls.maxDistance = radius * 8
        placeCamera.current(latest.current.view)
        el.dataset.marksPlaced = toModel ? '1' : '0'
        setModelled([...parts.keys()].sort())
        setState('ready')
        latest.current.onLoad?.([...parts.keys()].sort(), !!toModel)
      },
      undefined,
      () => {
        if (disposed) return
        setState('error')
        latest.current.onError?.()
      },
    )

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onCancel)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      placeCamera.current = () => {}
      partsRef.current = new Map()
      anchorsRef.current = new Map()
      observer.disconnect()
      controls.dispose()
      if (model) model.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return
        o.geometry.dispose()
        const materials = Array.isArray(o.material) ? o.material : [o.material]
        materials.forEach(m => m.dispose())
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [pcbFilename, version])

  return (
    <div ref={host} data-testid="kicad-3d" data-state={state} data-parts={modelled.join(',')}
      data-selected={selected ?? ''} data-checked={okRefs.join(',')} data-hover={hover ?? ''}
      data-focus={focusKey} data-view={view}
      // isolate: the badges' z-index stays inside the viewer, under panels drawn over it
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', isolation: 'isolate' }}>
      {state === 'ready' && okRefs.map(ref => (
        <div key={ref} data-badge-3d={ref} aria-hidden="true"
          ref={node => { badgeEls.current[ref] = node }}
          style={{ position: 'absolute', left: 0, top: 0, width: 16, height: 16, margin: '-20px 0 0 -8px',
            display: 'none', placeItems: 'center', borderRadius: '50%', background: OK,
            border: '1.5px solid #ffffff', pointerEvents: 'none', zIndex: 1 }}>
          <svg width={10} height={10} viewBox="-1 -1 2 2">
            <path d="M -0.55 0 L -0.15 0.4 L 0.6 -0.4" fill="none" stroke="#ffffff" strokeWidth={0.28}
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      ))}
      {state === 'ready' && marks.map(m => (
        <div key={m.key} data-mark-3d={m.key} data-label={m.label} aria-hidden="true"
          ref={node => { markEls.current[m.key] = node }}
          style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, display: 'none', pointerEvents: 'none', zIndex: 2 }}>
          <div style={{ position: 'absolute', left: -3.5, top: -3.5, width: 7, height: 7, boxSizing: 'border-box', borderRadius: '50%',
            background: MARK_COLOR(m.label), border: '1.5px solid #ffffff' }} />
          <div style={{ position: 'absolute', left: 0, top: -0.75, width: MARK_OUT, height: 1.5, background: MARK_COLOR(m.label),
            transformOrigin: '0 50%' }} />
          <div style={{ position: 'absolute', left: 0, top: 0 }}>
            <div style={{ minWidth: 18, height: 18, margin: '-9px 0 0 -9px', padding: '0 4px', boxSizing: 'border-box', display: 'grid',
              placeItems: 'center', borderRadius: 9, background: MARK_COLOR(m.label), border: '1.5px solid #ffffff',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)', color: '#ffffff', fontFamily: 'var(--sf-font-mono)', fontSize: 11,
              fontWeight: 700, lineHeight: 1, whiteSpace: 'nowrap' }}>
              {m.label}
            </div>
          </div>
        </div>
      ))}
      <div ref={tipEl} data-testid="kicad-3d-tip" role="tooltip"
        style={{ position: 'absolute', left: 0, top: 0, display: tip ? 'block' : 'none', maxWidth: 240, padding: '4px 8px',
          borderRadius: 6, background: 'rgba(35, 38, 43, 0.92)', color: '#ffffff', fontFamily: 'var(--sf-font-sans)',
          fontSize: 11.5, lineHeight: 1.4, pointerEvents: 'none', zIndex: 3, whiteSpace: 'pre-line' }}>
        {tip}
      </div>
      {state === 'loading' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#6b7079', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>KiCad 실제 3D 모델 불러오는 중…</div>}
      {state === 'error' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#c0392b', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>3D 모델을 불러오지 못했습니다.</div>}
    </div>
  )
}
