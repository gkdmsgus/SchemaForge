// Pieces shared by the full tour recording (scripts/record_tour.mjs): a caption bar, a pointer dot, a badge
// over sped-up waits, shots that log their time and keep going when one fails, and the ffmpeg edit.
import { execFileSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'

// the GPU draws the 3D view: without it a drag on the board took about a minute of video
// and a covered or minimised window keeps drawing: the logged-in take runs in a visible window, and behind other
// windows its schematic stayed on the old picture for 2 s after an undo (frame review of 2026-10-30)
export const GPU_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']
export const VIEW = { width: 1280, height: 720 }

/** drawn on every page the tour opens: caption bar (bottom or top), pointer dot, speed badge */
export function overlay() {
  const ready = () => {
    if (document.getElementById('sf-rec-caption')) return
    const cap = document.createElement('div')
    cap.id = 'sf-rec-caption'
    // keep-all: a two-line caption breaks between words, not inside one ("있습니/다" in the takes of 2026-10-29)
    cap.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:86%;padding:10px 20px;border-radius:10px;background:rgba(20,20,20,.84);color:#fff;font:600 20px/1.45 system-ui,sans-serif;text-align:center;word-break:keep-all;pointer-events:none;display:none;bottom:28px'
    const dot = document.createElement('div')
    dot.id = 'sf-rec-dot'
    dot.style.cssText = 'position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,140,0,.55);border:2px solid #fff;z-index:2147483647;pointer-events:none;left:-40px;top:-40px'
    const badge = document.createElement('div')
    badge.id = 'sf-rec-badge'
    badge.style.cssText = 'position:fixed;right:18px;top:64px;z-index:2147483647;padding:4px 12px;border-radius:8px;background:rgba(255,140,0,.92);color:#111;font:700 16px/1.4 system-ui,sans-serif;pointer-events:none;display:none'
    document.body.append(cap, dot, badge)
    addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
  }
  window.__caption = (text, pos) => {
    ready()
    const c = document.getElementById('sf-rec-caption')
    c.textContent = text
    c.style.display = text ? 'block' : 'none'
    c.style.top = pos === 'top' ? '70px' : ''
    c.style.bottom = pos === 'top' ? '' : '28px'
  }
  window.__badge = text => { ready(); const b = document.getElementById('sf-rec-badge'); b.textContent = text; b.style.display = text ? 'block' : 'none' }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready()
}

/** helpers bound to one recorded page; `t0` is when the page (and its video) started */
export function recorder(page, base, out) {
  mkdirSync(join(out, 'debug'), { recursive: true })
  const t0 = Date.now()
  let caption = ['', 'bottom']
  const rec = {
    page, base, out, t0, trimStart: 0, speedups: [], times: [], failed: [],
    // TOUR_ONLY=A2,A7,A9 runs just those scenes, to try a fixed scene without the whole tour
    only: process.env.TOUR_ONLY ? process.env.TOUR_ONLY.split(',') : null,
    at: () => (Date.now() - t0) / 1000,
    pause: ms => page.waitForTimeout(ms),
    /** the caption stays across page loads: shots call it again after goto */
    caption: (text, pos = 'bottom') => { caption = [text, pos]; return page.evaluate(([t, p]) => window.__caption?.(t, p), caption).catch(() => {}) },
    recaption: () => page.evaluate(([t, p]) => window.__caption?.(t, p), caption).catch(() => {}),
    async goto(url) { await page.goto(url.startsWith('http') ? url : base + url, { waitUntil: 'networkidle' }); await rec.recaption() },
    /** move the pointer to the middle of an element like a person would */
    async glide(locator, steps = 18) {
      const box = await locator.boundingBox()
      if (box) {
        await rec.clear(box)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps })
      }
      return box
    },
    /**
     * the caption moves to the other edge when it would cover what the pointer goes to (the frame review of
     * 2026-10-30 found it over the board's status row, the BOM, the gerber list and the input being typed in)
     */
    async clear(box) {
      // only the part on screen counts (a panel in a scrolled drawer reports its whole height)
      const vh = (page.viewportSize() || VIEW).height
      const y0 = Math.max(0, box.y), y1 = Math.min(vh, box.y + box.height)
      if (y1 <= y0) return
      box = { ...box, y: y0, height: y1 - y0 }
      const cap = await page.evaluate(() => {
        const c = document.getElementById('sf-rec-caption')
        if (!c || c.style.display === 'none') return null
        const r = c.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }).catch(() => null)
      if (!cap) return
      const hit = box.x < cap.x + cap.w && box.x + box.width > cap.x && box.y < cap.y + cap.h + 6 && box.y + box.height > cap.y - 6
      if (!hit) return
      const top = cap.y < (page.viewportSize() || VIEW).height / 2
      // only if the other edge is clear of the target too (a tall panel can reach both)
      const other = top ? { y0: 628, y1: 700 } : { y0: 62, y1: 140 }
      if (box.y < other.y1 && box.y + box.height > other.y0) return
      caption = [caption[0], top ? 'bottom' : 'top']
      await rec.recaption()
    },
    /** in the viewport, not just in the page: a closed drawer keeps its buttons, slid out to the left */
    async onScreen(locator) {
      const box = await locator.boundingBox().catch(() => null)
      const { width, height } = page.viewportSize() || VIEW
      return !!box && box.x + box.width > 0 && box.x < width && box.y + box.height > 0 && box.y < height
    },
    async press(locator, { timeout = 15000, ...click } = {}) {
      await locator.waitFor({ state: 'visible', timeout })
      await locator.scrollIntoViewIfNeeded()
      // fail now instead of a 30 s click timeout (B15, 2026-10-29: a button of the closed drawer)
      if (!(await rec.onScreen(locator))) throw new Error('press: the element is outside the screen')
      await rec.glide(locator)
      await rec.pause(250)
      await locator.click(click)
    },
    async hover(locator, ms = 1200, timeout = 10000) {
      await locator.waitFor({ state: 'visible', timeout })
      await locator.scrollIntoViewIfNeeded()
      await rec.glide(locator)
      await rec.pause(ms)
    },
    /** scroll with the wheel until the element's top sits near `offset` px, so the move shows on video */
    async scrollTo(locator, offset = 110) {
      await locator.waitFor({ state: 'attached', timeout: 10000 })
      for (let i = 0; i < 40; i++) {
        const b = await locator.boundingBox()
        if (!b) break
        const d = b.y - offset
        if (Math.abs(d) < 50) break
        await page.mouse.wheel(0, Math.sign(d) * Math.min(Math.abs(d), 140))
        await rec.pause(70)
        const after = await locator.boundingBox()
        if (after && Math.abs(after.y - b.y) < 2) break   // the page does not scroll further
      }
      await locator.scrollIntoViewIfNeeded()
    },
    /** a wait that is played faster in the edit, with a badge on screen while it lasts */
    async fast(fn, speed = 6) {
      await page.evaluate(t => window.__badge?.(t), `▶▶ ${speed}배속`).catch(() => {})
      const a = rec.at()
      try { return await fn() } finally {
        const b = rec.at()
        await page.evaluate(() => window.__badge?.('')).catch(() => {})
        if (b - a > 1.5) rec.speedups.push([a, b, speed])
      }
    },
    /** one scene: its time is logged, and a failure is logged with a screenshot instead of ending the tour */
    async shot(id, name, fn) {
      if (rec.only && !rec.only.includes(id)) return
      const a = Date.now()
      try {
        await fn()
        rec.times.push([id, name, (Date.now() - a) / 1000, 'ok'])
      } catch (e) {
        const msg = String(e?.message || e).split('\n')[0]
        rec.times.push([id, name, (Date.now() - a) / 1000, 'FAIL'])
        rec.failed.push([id, name, msg])
        console.log(`  ${id} FAIL: ${msg}`)
        await page.screenshot({ path: join(out, 'debug', `${id}.png`) }).catch(() => {})
        await page.keyboard.press('Escape').catch(() => {})
      }
    },
  }
  return rec
}

/** slow full turn of a three.js OrbitControls view: dragging across the canvas height turns it 360° */
export async function turn3D(rec, canvas, { turns = 1, seconds = 10, tilt = 0 } = {}) {
  const { page } = rec
  const b = await canvas.boundingBox()
  const H = await canvas.evaluate(e => e.clientHeight)
  if (!b || !H) throw new Error('3D canvas has no size')
  const cy = b.y + b.height / 2
  if (tilt) {
    // tilt the camera a little first, so the turn shows the parts' sides
    await page.mouse.move(b.x + b.width / 2, cy, { steps: 8 })
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, cy + tilt, { steps: 14 })
    await page.mouse.up()
    await rec.pause(700)
  }
  const dx = H * turns
  const x0 = Math.max(b.x + 10, b.x + b.width / 2 - dx / 2)
  await page.mouse.move(x0, cy, { steps: 10 })
  await page.mouse.down()
  // the place along the turn comes from the time gone, not a step count: over a heavy 3D model each move took far
  // longer than its 60 ms, and an 11 s turn lasted about 32 s (review of 2026-11-01)
  const t0 = Date.now()
  for (let f = 0; f < 1;) {
    f = Math.min(1, (Date.now() - t0) / (seconds * 1000))
    await page.mouse.move(x0 + dx * f, cy)
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await rec.pause(1500)   // damping plays out the rest of the turn
}

/** cut the white start, play the marked waits faster, and write an mp4 */
export function edit(webm, mp4, trimStart, speedups) {
  const segs = []
  let t = trimStart
  for (const [a, b, s] of [...speedups].sort((x, y) => x[0] - y[0])) {
    if (b <= t) continue
    const a2 = Math.max(a, t)
    if (a2 > t + 0.05) segs.push([t, a2, 1])
    segs.push([a2, b, s])
    t = b
  }
  segs.push([t, null, 1])
  const parts = segs.map(([a, b, s], i) => `[0:v]trim=start=${a.toFixed(2)}${b == null ? '' : ':end=' + b.toFixed(2)},setpts=(PTS-STARTPTS)/${s}[v${i}]`)
  const filter = parts.join(';') + ';' + segs.map((_, i) => `[v${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0[out]`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-filter_complex', filter, '-map', '[out]', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
}

/** seconds of an mp4, read with ffprobe */
export function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim())
}
