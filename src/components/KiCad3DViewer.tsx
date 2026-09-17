import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Props { pcbFilename: string }

/** Interactive viewer for KiCad's real board GLB, including component models. */
export default function KiCad3DViewer({ pcbFilename }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const el = host.current
    if (!el) return
    setState('loading')

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

    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    animate()

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
    <div ref={host} data-testid="kicad-3d" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {state === 'loading' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#6b7079', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>KiCad 실제 3D 모델 불러오는 중…</div>}
      {state === 'error' && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        zIndex: 1, color: '#c0392b', fontFamily: 'var(--sf-font-mono)', fontSize: 12 }}>3D 모델을 불러오지 못했습니다.</div>}
    </div>
  )
}
