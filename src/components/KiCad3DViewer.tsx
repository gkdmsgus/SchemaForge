import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Props {
  pcbFilename: string
  selected?: string | null              // part picked for review: tinted violet
  reviewed?: string[]                   // parts a person confirmed: a check badge floats over each
  onPick?: (ref: string) => void        // click (not drag) on a part
}

// KiCad names each footprint's node in the GLB by its reference (C1, Q1, J2...).
const REF_NODE = /^[A-Za-z]+[0-9]+$/
const PICK_COLOR = new THREE.Color('#6a4cb5')
const OK = '#176b5d'

/** Interactive viewer for KiCad's real board GLB, including component models. */
export default function KiCad3DViewer({ pcbFilename, selected = null, reviewed = [], onPick }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [modelled, setModelled] = useState<string[]>([])        // parts that have a 3D model
  const partsRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const anchorsRef = useRef<Map<string, THREE.Vector3>>(new Map())  // top centre of each part
  const badgeEls = useRef<Record<string, HTMLDivElement | null>>({})
  const onPickRef = useRef(onPick)
  useEffect(() => { onPickRef.current = onPick }, [onPick])
  // a green tint is lost on a green board, so confirmed parts get a badge (as in 2D) instead
  const okRefs = reviewed.filter(r => modelled.includes(r)).sort()

  // tint the selected part; everything else keeps KiCad's own colours
  useEffect(() => {
    if (state !== 'ready') return
    for (const [ref, node] of partsRef.current) {
      const tint = ref === selected ? PICK_COLOR : null
      node.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!(m instanceof THREE.MeshStandardMaterial)) continue
          const base = m.userData.baseEmissive as THREE.Color | undefined
          m.emissive.copy(tint ?? base ?? new THREE.Color(0, 0, 0))
          m.emissiveIntensity = tint ? 0.75 : (m.userData.baseIntensity ?? 1)
        }
      })
    }
  }, [state, selected])

  useEffect(() => {
    const el = host.current
    if (!el) return
    setState('loading')
    setModelled([])

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

    const resize = () => {
      const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()

    // badges follow their part: project its top centre every frame (hidden behind the camera)
    const tmp = new THREE.Vector3()
    const placeBadges = () => {
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight
      for (const [ref, badge] of Object.entries(badgeEls.current)) {
        const at = anchorsRef.current.get(ref)
        if (!badge || !at) continue
        tmp.copy(at).project(camera)
        const off = tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05
        badge.style.display = off ? 'none' : 'grid'
        badge.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`
      }
    }
    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      placeBadges()
      frame = requestAnimationFrame(animate)
    }
    animate()

    // a click (pointer moved under 5 px) picks the nearest part under the cursor; a drag orbits
    const ray = new THREE.Raycaster()
    const refOf = (o: THREE.Object3D | null): string | null => {
      for (let cur = o; cur; cur = cur.parent) {
        if (partsRef.current.get(cur.name) === cur) return cur.name
      }
      return null
    }
    const pickAt = (clientX: number, clientY: number): string | null => {
      if (!model) return null
      const r = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      for (const hit of ray.intersectObject(model, true)) {
        const ref = refOf(hit.object)
        if (ref) return ref
      }
      return null
    }
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 5) return
      const ref = pickAt(e.clientX, e.clientY)
      if (ref) onPickRef.current?.(ref)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
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
      })
    }

    new GLTFLoader().load(
      `/board_model?pcb=${encodeURIComponent(pcbFilename)}`,
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
        partsRef.current = parts
        anchorsRef.current = new Map([...parts].map(([ref, node]) => {
          const b = new THREE.Box3().setFromObject(node)
          const c = b.getCenter(new THREE.Vector3())
          return [ref, new THREE.Vector3(c.x, b.max.y, c.z)]       // GLB is Y-up
        }))
        setModelled([...parts.keys()].sort())

        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const radius = Math.max(sphere.radius, 0.01)
        controls.target.copy(center)
        camera.near = radius / 1000
        camera.far = radius * 100
        // Fit the bounding sphere to the smaller viewport dimension. The extra
        // margin keeps long rectangular boards clear of the panel controls.
        const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2)
        const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect)
        const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov)
        const distance = (radius / Math.sin(limitingHalfFov)) * 1.35
        // above the board, looking down the diagonal like the reel's 3D shot (+Y is up in the GLB)
        camera.position.copy(center).add(new THREE.Vector3(0.9, 1.1, 1).normalize().multiplyScalar(distance))
        camera.up.set(0, 1, 0)
        camera.updateProjectionMatrix()
        controls.minDistance = radius * 0.35
        controls.maxDistance = radius * 8
        controls.update()
        setState('ready')
      },
      undefined,
      () => { if (!disposed) setState('error') },
    )

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
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
  }, [pcbFilename])

  return (
    <div ref={host} data-testid="kicad-3d" data-state={state} data-parts={modelled.join(',')}
      data-selected={selected ?? ''} data-reviewed={okRefs.join(',')}
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
      {state === 'loading' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#6b7079', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>KiCad 실제 3D 모델 불러오는 중…</div>}
      {state === 'error' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#c0392b', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>3D 모델을 불러오지 못했습니다.</div>}
    </div>
  )
}
