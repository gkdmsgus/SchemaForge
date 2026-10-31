// Records the public demo as a video with Korean captions and a visible pointer, and prints how long each
// step took: home → motor demo → PCB (placement and routing replay) → 3D → assembly → gerbers.
// The video goes to videos/ (git-ignored) as .webm, and as .mp4 when ffmpeg is on PATH.
// Usage: node scripts/record_demo.mjs [BASE]   (default https://schemaforge.kro.kr)
import { chromium } from 'playwright'
import { execFileSync } from 'child_process'
import { mkdirSync, renameSync } from 'fs'
import { join } from 'path'

const BASE = (process.argv[2] || 'https://schemaforge.kro.kr').replace(/\/$/, '')
const OUT = join(process.cwd(), 'videos')
mkdirSync(OUT, { recursive: true })
const times = []
const step = async (label, fn) => { const t0 = Date.now(); await fn(); times.push([label, (Date.now() - t0) / 1000]) }

// the GPU draws the 3D view: without it a drag on the board took about a minute of video
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } })
// a caption bar and a pointer dot, drawn on every page the scenario opens
await context.addInitScript(() => {
  const ready = () => {
    if (document.getElementById('sf-rec-caption')) return
    const cap = document.createElement('div')
    cap.id = 'sf-rec-caption'
    cap.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:86%;padding:10px 20px;border-radius:10px;background:rgba(20,20,20,.82);color:#fff;font:600 20px/1.45 system-ui,sans-serif;text-align:center;pointer-events:none;display:none'
    const dot = document.createElement('div')
    dot.id = 'sf-rec-dot'
    dot.style.cssText = 'position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,140,0,.55);border:2px solid #fff;z-index:2147483647;pointer-events:none;left:-40px;top:-40px'
    document.body.append(cap, dot)
    addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
  }
  window.__caption = text => { ready(); const c = document.getElementById('sf-rec-caption'); c.textContent = text; c.style.display = text ? 'block' : 'none' }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready()
})
const page = await context.newPage()
const recStart = Date.now()
let trimStart = 0   // seconds of white page before the first screen, cut from the video
const caption = text => page.evaluate(t => window.__caption?.(t), text)
const pause = ms => page.waitForTimeout(ms)
/** move the pointer to an element like a person would, then click it */
async function press(locator) {
  const box = await locator.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
  await pause(250)
  await locator.click()
}

try {
  // wake a sleeping free instance before the camera matters
  await step('서버 응답 (/health)', async () => { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(180000) }) })

  await step('첫 화면', async () => { await page.goto(BASE, { waitUntil: 'networkidle' }) })
  trimStart = Math.max(0, (Date.now() - recStart) / 1000 - 0.2)
  await caption('SchemaForge — 말로 설명한 회로를 KiCad 기판과 거버 파일까지 만듭니다')
  await pause(3500)
  await caption('로그인 없이 볼 수 있는 데모: 모터 드라이버 회로')
  await pause(1500)

  await step('데모 회로 열기', async () => {
    await page.goto(`${BASE}/?demo=motor`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /PCB 생성/ }).first().waitFor({ timeout: 60000 })
  })
  await caption('회로도: 부품과 연결(넷)이 색으로 구분됩니다')
  await pause(3500)

  await caption('PCB 생성: 부품 배치와 배선이 실제로 계산되는 과정을 그대로 보여 줍니다')
  await step('PCB 생성 (배치·배선·DRC)', async () => {
    await press(page.getByRole('button', { name: /PCB 생성/ }).first())
    await page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 300000 })
  })
  await caption('KiCad 설계 규칙 검사(DRC) 결과와 배선 상태를 숫자로 확인합니다')
  await pause(4000)

  await caption('배치하기: KiCad가 만든 3D 모델에서 부품을 확인합니다')
  await step('3D 모델 불러오기', async () => {
    await press(page.getByTestId('view-tab-assembly'))
    await page.waitForSelector('[data-testid="assembly-3d"] [data-testid="kicad-3d"]:is([data-state="ready"],[data-state="error"])', { timeout: 200000 })
  })
  const v3 = page.locator('[data-testid="assembly-3d"] [data-testid="kicad-3d"]')
  const box = await v3.boundingBox()
  await step('3D 돌려 보기', async () => {
    if (!box) return
    // turn the board a little by dragging, as a person would
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    await page.mouse.move(cx, cy, { steps: 6 })
    await page.mouse.down()
    await page.mouse.move(cx + 140, cy + 30, { steps: 12 })
    await page.mouse.up()
  })
  await pause(2500)

  await caption('거버 파일: PCB 업체에 그대로 주문할 수 있는 제조 파일을 만듭니다')
  await step('거버 + 드릴 파일', async () => {
    await press(page.getByRole('button', { name: /^거버$/ }))
    await page.getByText('거버 완료').waitFor({ timeout: 120000 })
  })
  await page.getByRole('button', { name: /Netlist/ }).first().click().catch(() => {})
  await pause(3500)

  await caption('https://schemaforge.kro.kr — 설명으로 새 회로를 만들려면 로그인합니다')
  await pause(3500)
} catch (e) {
  console.log('scenario stopped: ' + e.message)
} finally {
  const video = page.video()
  await context.close()
  await browser.close()
  const raw = await video.path()
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const webm = join(OUT, `schemaforge_demo_${stamp}.webm`)
  renameSync(raw, webm)
  console.log('video: ' + webm)
  try {
    const mp4 = webm.replace(/\.webm$/, '.mp4')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', trimStart.toFixed(2), '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
    console.log('video: ' + mp4)
  } catch { console.log('mp4: ffmpeg not available, kept the .webm') }
  console.log('\n단계별 시간')
  for (const [label, s] of times) console.log(`  ${label}: ${s.toFixed(1)} s`)
}
