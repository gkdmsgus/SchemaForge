// Part A of the full tour: everything a visitor can do without logging in, on the home page and the demos.
import { turn3D } from './lib.mjs'

export async function run(rec) {
  const { page } = rec
  const T = id => page.getByTestId(id)
  const btn = (name, exact = false) => page.getByRole('button', { name, exact })
  const drawerTab = name => page.locator('button.sf-drawer-tab', { hasText: name }).first()
  const closeDrawer = () => rec.press(page.locator('button.sf-drawer-tab').first().locator('xpath=..').getByRole('button', { name: '×' }))
  const pcbButton = () => page.getByRole('button', { name: /PCB (다시 )?생성/ }).first()
  const pcbDone = () => page.getByRole('button', { name: /\.kicad_pcb/ })

  await rec.shot('A2', '홈 화면', async () => {
    await rec.goto('/')
    rec.trimStart = Math.max(0, rec.at() - 0.2)
    await rec.caption('SchemaForge — 말로 설명한 회로를 KiCad 기판과 거버 파일까지 만듭니다')
    await rec.hover(page.locator('h1.sf-home-title'), 1800)
    await rec.hover(page.locator('figure.sf-home-figure'), 2500)
  })

  await rec.shot('A3', '예시 문장과 로그인 창', async () => {
    await rec.caption('예시를 누르면 설명이 채워집니다. 새 회로를 만들 때만 로그인이 필요합니다')
    await rec.press(page.locator('p.sf-home-examples').getByRole('button', { name: '9V로 LED 3개 점멸' }))
    await rec.pause(1300)
    await rec.press(btn('회로 만들기', true))
    await page.locator('.auth-tabs').waitFor({ timeout: 10000 })
    await rec.pause(1200)
    await rec.press(page.locator('button.auth-tab', { hasText: '회원가입' }))
    await rec.pause(2200)
    await page.keyboard.press('Escape')
    await page.locator('.auth-tabs').waitFor({ state: 'hidden', timeout: 5000 })
    await page.locator('.sf-home-input textarea').fill('')
  })

  await rec.shot('A4', '회로 종류와 사양 칩', async () => {
    await rec.caption('회로 종류를 고르면 전압·개수 같은 사양을 칩으로 고를 수 있습니다')
    await rec.scrollTo(page.getByRole('heading', { name: '회로 종류로 시작하기' }))
    await rec.press(page.locator('button[role=listitem].sf-type-row', { hasText: 'LED 제어' }))
    const panel = page.locator('.sf-spec-panel')
    const blink = panel.getByRole('button', { name: /점멸/ }).first()
    await rec.hover(blink, 1500)
    await rec.press(blink)
    await rec.press(panel.getByRole('button', { name: '3', exact: true }).first())
    await rec.press(panel.getByRole('button', { name: '5V', exact: true }).first())
    const done = page.getByText('필수 항목을 모두 골랐습니다.')
    await rec.hover(done, 1500)
    await rec.hover(btn('LED 제어 만들기').last(), 1200)
    await rec.press(page.locator('.sf-spec-head').getByRole('button', { name: '선택 해제' }))
  })

  await rec.shot('A5', '다섯 단계 표와 약관', async () => {
    await rec.caption('안에서는 회로 → 배치 → 배선 → 검사 → 다듬기 다섯 단계가 차례로 돕니다')
    await rec.scrollTo(page.locator('table.sf-pipeline'))
    await rec.glide(page.locator('table.sf-pipeline'))
    await rec.pause(3000)
    await rec.caption('이용약관과 개인정보 처리방침도 볼 수 있습니다')
    await rec.press(page.getByRole('link', { name: '이용약관' }))
    await page.getByRole('heading', { name: '이용약관' }).first().waitFor({ timeout: 10000 })
    await rec.recaption()
    await page.mouse.move(640, 400, { steps: 6 })
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await rec.pause(220) }
    await rec.goto('/privacy')
    await page.getByRole('heading', { name: '개인정보 처리방침' }).first().waitFor({ timeout: 10000 })
    await rec.pause(1500)
    await rec.press(page.getByRole('link', { name: '처음 화면으로' }))
    await page.locator('h1.sf-home-title').waitFor({ timeout: 10000 })
    await rec.recaption()
  })

  await rec.shot('A6', '메뉴 서랍', async () => {
    await rec.caption('왼쪽 메뉴에는 만든 회로 기록이 쌓입니다 (로그인하면 서버에 저장됩니다)', 'top')
    await rec.press(page.locator("button[aria-label='메뉴']"))
    await page.getByText('저장된 회로가 없습니다').waitFor({ timeout: 5000 })
    await rec.pause(2000)
    await rec.press(btn('×', true).first())
  })

  await rec.shot('A7', '모터 데모 열기', async () => {
    await rec.caption('로그인 없이 볼 수 있는 모터 드라이버 데모를 엽니다')
    const fig = page.locator('figure.sf-home-figure')
    await rec.scrollTo(fig)
    await rec.press(fig.getByRole('link', { name: '직접 열어 보기' }))
    await pcbButton().waitFor({ timeout: 60000 })
    await rec.recaption()
    await rec.pause(800)
    await rec.hover(T('right-panel'), 2000)
  })

  const schem = page.locator('svg:has(g[data-comp])').first()
  if (rec.only && !rec.only.includes('A2')) await rec.goto('/?demo=motor')

  await rec.shot('A8', '회로도 보기', async () => {
    await rec.caption('회로도에서 넷 이름에 마우스를 올리면 그 연결만 밝게 보입니다')
    await rec.hover(page.getByText('GATE', { exact: true }).first(), 1600)
    await rec.hover(page.getByText('+12V', { exact: true }).first(), 1600)
    const b = await schem.boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
    await page.keyboard.down('Control')
    for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, -240); await rec.pause(350) }
    await page.keyboard.up('Control')
    await rec.pause(600)
    await page.mouse.move(b.x + 40, b.y + 40, { steps: 8 })
    await page.mouse.down()
    await page.mouse.move(b.x + 140, b.y + 90, { steps: 16 })
    await page.mouse.up()
    await rec.pause(600)
    await rec.press(btn('⌂', true))
    await rec.pause(800)
  })

  await rec.shot('A9', '회로도 편집과 PDF', async () => {
    await rec.caption('부품을 옮기고 값과 연결을 바로 고칠 수 있습니다 (이 화면 안에서만 바뀝니다)')
    // only parts in view can be grabbed (some sit below the schematic's visible part), and not under the caption
    const sb = await schem.boundingBox()
    const inView = b => b && b.x > sb.x + 5 && b.x + b.width < sb.x + sb.width - 5 && b.y > sb.y + 5 && b.y + b.height < 600
    const parts = []
    for (const g of await page.locator('g[data-comp]').all()) if (inView(await g.boundingBox())) parts.push(g)
    if (parts.length < 3) throw new Error(`only ${parts.length} parts in view`)
    const [moved, picked, edited] = parts
    // clicks go to the spot on screen, as a person's would (wires lie over pins, so element clicks wait forever)
    const at = async g => { const b = await rec.glide(g); return [b.x + b.width / 2, b.y + b.height / 2] }
    const empty = () => page.mouse.click(sb.x + 30, sb.y + 30)
    const [mx, my] = await at(moved)
    await page.mouse.down()
    await page.mouse.move(mx + 50, my + 30, { steps: 16 })
    await page.mouse.up()
    await rec.pause(700)
    await page.mouse.click(...await at(picked))
    await rec.pause(1800)
    await empty()
    await page.mouse.dblclick(...await at(edited))
    await rec.pause(1500)
    await page.keyboard.press('Escape')
    await empty()
    // the middle of one signal wire in view (power nets are drawn as symbols, with no wire path)
    const pt = await page.evaluate(([x0, y0, x1]) => {
      for (const p of document.querySelectorAll("g[data-net] path[stroke='transparent']")) {
        const L = p.getTotalLength()
        if (L < 40) continue
        const m = p.getPointAtLength(L / 2)
        const c = p.getScreenCTM()
        const x = m.x * c.a + m.y * c.c + c.e, y = m.x * c.b + m.y * c.d + c.f
        if (x > x0 + 20 && x < x1 - 20 && y > y0 + 20 && y < 560) return { x, y }
      }
      return null
    }, [sb.x, sb.y, sb.x + sb.width])
    if (!pt) throw new Error('no signal wire on the schematic')
    await page.mouse.move(pt.x, pt.y, { steps: 14 })
    await rec.pause(300)
    await page.mouse.click(pt.x, pt.y)
    await rec.pause(1000)
    await rec.press(btn('✕ 삭제'))
    await rec.pause(1600)
    await rec.press(btn('↩ 되돌리기').first())
    await rec.pause(1000)
    await page.mouse.move(pt.x, pt.y, { steps: 10 })
    await page.mouse.down()
    await page.mouse.move(pt.x, pt.y + 40, { steps: 14 })
    await page.mouse.up()
    await rec.pause(900)
    await rec.press(btn('↺ 선 초기화'))

    // pins in view and the net each one is wired to: pins carry no ref or net in the page, so a pin belongs
    // to the net whose drawn wire passes its end (power pins, drawn as symbols, have none)
    const pinMap = () => page.evaluate(([x0, y0, x1]) => {
      const scr = (el, x, y) => { const c = el.getScreenCTM(); return { x: x * c.a + y * c.c + c.e, y: x * c.b + y * c.d + c.f } }
      const nets = [...document.querySelectorAll('g[data-net]')].map(g => {
        const pts = []
        for (const p of g.querySelectorAll('path')) {
          const L = p.getTotalLength()
          for (let s = 0; s <= L; s += 3) { const m = p.getPointAtLength(s); pts.push(scr(p, m.x, m.y)) }
        }
        return pts
      })
      const pins = []
      for (const comp of document.querySelectorAll('g[data-comp]')) {
        for (const hit of comp.querySelectorAll("g[style*='crosshair'] circle[r='8']")) {
          const p = scr(hit, +hit.getAttribute('cx'), +hit.getAttribute('cy'))
          if (p.x < x0 + 20 || p.x > x1 - 20 || p.y < y0 + 20 || p.y > 560) continue
          // a power pin is drawn with a symbol (GND, VCC, +12V): a wire ending beside it made R2's GND pin count as
          // SENSE, and joining it to R3 put the gate on GND instead of drawing a wire (frame review of 2026-10-30)
          const power = [...document.querySelectorAll('svg text')].some(t => !t.closest('g[data-comp]')
            && /^(GND|AGND|VCC|VDD|VIN|VOUT|VBAT|\+?\d+(\.\d+)?V)$/i.test((t.textContent || '').trim())
            && (() => { const b = t.getBoundingClientRect(); return Math.hypot(b.x + b.width / 2 - p.x, b.y + b.height / 2 - p.y) < 34 })())
          const net = power ? -1 : nets.findIndex(pts => pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 5))
          pins.push({ ref: comp.getAttribute('data-comp'), x: p.x, y: p.y, net })
        }
      }
      return { pins, nets: nets.length }
    }, [sb.x, sb.y, sb.x + sb.width])
    const hint = page.getByText('연결할 핀을 클릭하세요')

    await rec.caption('핀을 누르고 다른 부품의 핀을 누르면 그 사이에 새 선이 이어집니다')
    const before = await pinMap()
    let pair = null
    for (const a of before.pins) for (const b of before.pins) {
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (a.ref !== b.ref && a.net >= 0 && b.net >= 0 && a.net !== b.net && d > 60 && (!pair || d < pair.d)) pair = { a, b, d }
    }
    if (!pair) throw new Error('no two pins of different nets in view')
    await page.mouse.move(pair.a.x, pair.a.y, { steps: 14 })
    await rec.pause(300)
    await page.mouse.click(pair.a.x, pair.a.y)
    await hint.waitFor({ timeout: 3000 })
    await page.mouse.move(pair.b.x, pair.b.y, { steps: 24 })
    await rec.pause(600)
    await page.mouse.click(pair.b.x, pair.b.y)
    await hint.waitFor({ state: 'hidden', timeout: 3000 })
    if ((await pinMap()).nets !== before.nets - 1) throw new Error('the two pins were not joined into one net')
    await rec.pause(1500)
    // a started wire is dropped by a click on empty space
    await rec.caption('선을 긋다가 빈 곳을 누르면 취소됩니다')
    const other = before.pins.find(p => p !== pair.a && p !== pair.b && p.net >= 0)
    if (other) {
      await page.mouse.move(other.x, other.y, { steps: 12 })
      await page.mouse.click(other.x, other.y)
      await hint.waitFor({ timeout: 3000 })
      await page.mouse.move(sb.x + 30, sb.y + 30, { steps: 16 })
      await rec.pause(500)
      await empty()
      await hint.waitFor({ state: 'hidden', timeout: 3000 })
      await rec.pause(800)
    }

    await rec.caption('선을 고르면 양 끝에 점이 생기고, 끝점을 다른 핀으로 끌면 연결이 옮겨집니다')
    const wire = await page.evaluate(([x0, y0, x1]) => {
      for (const p of document.querySelectorAll("g[data-net] path[stroke='transparent']")) {
        const L = p.getTotalLength()
        if (L < 40) continue
        const m = p.getPointAtLength(L / 2)
        const c = p.getScreenCTM()
        const x = m.x * c.a + m.y * c.c + c.e, y = m.x * c.b + m.y * c.d + c.f
        if (x > x0 + 20 && x < x1 - 20 && y > y0 + 20 && y < 560) return { x, y }
      }
      return null
    }, [sb.x, sb.y, sb.x + sb.width])
    if (!wire) throw new Error('no signal wire to pick for the endpoint drag')
    await page.mouse.move(wire.x, wire.y, { steps: 12 })
    await page.mouse.click(wire.x, wire.y)
    await rec.pause(900)
    // the selected net's end handles (r 6, outside the parts), with the part each one sits on
    const handles = await page.evaluate(() => [...document.querySelectorAll("svg g[style*='crosshair'] > circle[r='6']")]
      .filter(c => !c.closest('g[data-comp]'))
      .map(c => {
        const m = c.getScreenCTM(), x = +c.getAttribute('cx'), y = +c.getAttribute('cy')
        return { x: x * m.a + y * m.c + m.e, y: x * m.b + y * m.d + m.f, ref: (c.parentElement.querySelector('text')?.textContent || '').split('[')[0] }
      }))
    if (!handles.length) throw new Error('no end handles after picking a wire')
    const now = await pinMap()
    let move = null
    for (const h of handles) {
      if (h.y > 560) continue
      const own = now.pins.find(p => Math.hypot(p.x - h.x, p.y - h.y) < 5)
      // another end of the same net, to see afterwards that the moved end joined it
      const keep = handles.map(o => now.pins.find(p => Math.hypot(p.x - o.x, p.y - o.y) < 5)).find(p => p && p !== own)
      for (const t of now.pins) {
        const d = Math.hypot(t.x - h.x, t.y - h.y)
        if (t.ref !== h.ref && own && keep && t.net !== own.net && d > 50 && (!move || d < move.d)) move = { h, t, d, keep }
      }
    }
    if (!move) throw new Error('no pin to move an end handle to')
    await page.mouse.move(move.h.x, move.h.y, { steps: 12 })
    await rec.pause(400)
    await page.mouse.down()
    await page.mouse.move(move.t.x, move.t.y, { steps: 24 })
    await rec.pause(400)
    await page.mouse.up()
    // the target pin is on the picked net now. Handles going away was not enough: a press that started a new wire
    // instead cleared them too, and the take of 2026-10-29 passed with nothing moved (frame review of 2026-10-30)
    await rec.pause(400)
    if (await hint.isVisible()) throw new Error('the end handle started a new wire instead of moving')
    const after = await pinMap(), on = q => after.pins.find(p => Math.hypot(p.x - q.x, p.y - q.y) < 5)
    if (!(on(move.t)?.net >= 0 && on(move.t)?.net === on(move.keep)?.net)) throw new Error('the dragged end did not move to the target pin')
    await rec.pause(1100)

    await rec.caption('회로 화면은 PDF로 내보낼 수 있습니다')
    const dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(page.locator("button[title='PDF']"))
    await dl
    await rec.pause(800)
  })

  await rec.shot('A10', 'PCB 탭 간이 보기', async () => {
    await rec.caption('PCB를 만들기 전에는 간이 그림이 보이고, 부품 방식(SMD/THT)을 고를 수 있습니다')
    await rec.press(T('view-tab-pcb'))
    await page.getByText('간이 보기예요').first().waitFor({ timeout: 10000 })
    await rec.hover(btn('SMD', true), 900)
    await rec.hover(btn('THT', true), 900)
    await rec.hover(btn('AI 다듬기 OFF'), 1100)
  })

  await rec.shot('A11', 'PCB 생성', async () => {
    await rec.caption('PCB 생성: 연결된 부품끼리 모이도록 배치하고, 두 층에 선을 긋습니다')
    await rec.press(pcbButton())
    await pcbDone().waitFor({ timeout: 300000 })
    await rec.caption('아래 줄에 배선 수·비아·트랙 길이·기판 크기·DRC 오류가 숫자로 나옵니다')
    await rec.hover(T('board-status'), 3500)
  })

  await rec.shot('A12', '기판 보기 바꾸기', async () => {
    await rec.caption('2D·나란히·3D로 바꾸고, 윗면·아랫면 구리를 켜고 끌 수 있습니다')
    await rec.press(T('view-2d'))
    const board = page.locator("svg[data-testid='board-view']").first()
    const b = await rec.glide(board)
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await rec.pause(250) }
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30, { steps: 14 })
    await page.mouse.up()
    for (const layer of ['F', 'B']) {
      await rec.press(btn(layer, true))
      await rec.pause(1100)
      await rec.press(btn(layer, true))
      await rec.pause(500)
    }
    await rec.press(T('view-both'))
    await rec.pause(1200)
    await rec.caption('↺ 다시 보기로 배치·배선 과정을 다시 재생합니다')
    await rec.press(T('board-replay'))
    await rec.pause(3500)
    await page.getByTestId('board-phase').filter({ hasText: '배선 완료' }).waitFor({ timeout: 60000 })
  })

  await rec.shot('A13', '기판 검사와 방향 확인', async () => {
    await rec.caption('검사 목록과 함께, 거꾸로 달면 안 되는 부품의 +·− 자리를 기판 위에 표시합니다')
    await rec.press(T('view-2d'))
    await rec.press(T('board-checks').locator('button').first())
    await rec.pause(800)
    for (const c of await T('board-checks').locator('[data-check]').all()) { await rec.glide(c, 8); await rec.pause(250) }
    // the direction-check row opens by itself while parts wait for a check: a click would fold it
    if (!(await page.locator("[data-check-detail='human_review']").count())) await rec.press(page.locator("[data-check='human_review'] > button").first())
    await rec.scrollTo(page.locator("[data-check='human_review']").first(), 200)
    await rec.pause(700)
    const d1 = page.locator("[data-review='D1']").last()
    await rec.press(d1.locator("button[title='기판에서 보기']"))
    await rec.pause(2200)
    await rec.press(d1.locator("input[type=checkbox]"))
    await rec.pause(1200)
  })

  await rec.shot('A14', 'KiCad 3D 한 바퀴', async () => {
    await rec.caption('KiCad가 만든 실제 3D 모델을 천천히 한 바퀴 돌려 봅니다')
    await rec.press(T('toggle-left-panel'))
    await rec.press(T('toggle-right-panel'))
    // the check list covers the right of the 3D view: fold it for the turn
    const list = T('board-checks').locator('button[aria-expanded]').first()
    if (await list.getAttribute('aria-expanded') === 'true') await rec.press(list)
    await rec.press(T('view-3d'))
    const v = page.locator("[data-testid='kicad-3d']").first()
    await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 200000 }), 6)
    if (await v.getAttribute('data-state') !== 'ready') throw new Error('3D model did not load')
    await rec.pause(800)
    const canvas = v.locator('canvas')
    const b = await canvas.boundingBox()
    // closer first, so the board fills the view while it turns
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
    // OrbitControls: each 240 wheel step brings the camera to 0.95^2.4 ≈ 0.88 of its distance, five ≈ 0.54
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -240); await rec.pause(300) }
    await rec.pause(500)
    await turn3D(rec, canvas, { turns: 1, seconds: 11, tilt: -30 })
    await rec.caption('부품에 마우스를 올리면 이름과 값이 나옵니다')
    // fixed spots mostly hit bare board (review of 2026-10-30): walk out from the middle and stay on the parts that
    // answer with their name, two of them
    const tip = T('kicad-3d-tip'), seen = []
    const spots = []
    for (let r = 0; r <= 4; r++) for (let i = -r; i <= r; i++) for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
      const key = `${dx},${dy}`
      if (!spots.some(s => s.key === key)) spots.push({ key, x: b.x + b.width * (0.5 + dx * 0.06), y: b.y + b.height * (0.5 + dy * 0.07) })
    }
    for (const s of spots) {
      if (seen.length >= 2) break
      if (seen.some(p => Math.hypot(p.x - s.x, p.y - s.y) < 90)) continue
      await page.mouse.move(s.x, s.y, { steps: 5 })
      await rec.pause(90)
      if (await tip.isVisible().catch(() => false)) { seen.push(s); await rec.pause(1500) }
    }
    if (!seen.length) throw new Error('no part answered the 3D hover')
    await rec.caption('도형 보기로 바꾸면 가벼운 근사 3D가 나옵니다')
    await rec.press(T('board-real3d-toggle'))
    // the real model takes seconds to let go of the view: the shapes showed for 0.5 s of a 2.6 s wait (2026-10-30)
    await page.waitForFunction(() => /실제 3D/.test(document.querySelector("[data-testid='board-real3d-toggle']")?.textContent || '')
      && !document.querySelector("[data-testid='kicad-3d']") && !!document.querySelector("[data-testid='board-3d']"), null, { timeout: 20000 })
    await rec.pause(2600)
    await rec.press(T('board-real3d-toggle'))
    await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d'][data-state='ready']", { timeout: 120000 }), 4)
    await rec.pause(1200)
  })

  await rec.shot('A15', '배치하기 3D 체크', async () => {
    await rec.caption('배치하기: 실물 기판에 부품을 올리면서 하나씩 체크합니다')
    await rec.press(T('view-tab-assembly'))
    await rec.fast(() => page.waitForSelector("[data-testid='assembly-3d'] [data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 200000 }), 6)
    const panel = T('assembly-panel')
    await rec.hover(panel.locator('[data-assembly-line]').nth(2), 1500)
    await rec.press(panel.locator("[data-assembly-ref='R1']").first())
    await rec.pause(700)
    await rec.press(panel.locator("[data-assembly-ref='D1']").first())
    await rec.pause(700)
    await rec.press(panel.locator("[data-assembly-ref='C1']").first())
    await rec.pause(1600)
    await rec.press(page.locator("[data-assembly-confirm='C1']").first())
    await rec.pause(900)
    await rec.press(T('assembly-top'))
    await rec.pause(1000)
    await rec.press(T('board-fit'))
    await rec.pause(700)
    const c = page.locator("[data-testid='assembly-3d'] [data-testid='kicad-3d'] canvas")
    const b = await c.boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 40, { steps: 30 })
    await page.mouse.up()
    await rec.pause(1500)
  })

  await rec.shot('A16', '배치하기 평면 체크', async () => {
    await rec.caption('평면 그림에서도 같은 체크를 할 수 있습니다')
    await rec.press(T('assembly-view-2d'))
    await rec.pause(800)
    await rec.press(page.locator("rect[data-assembly-hit='R2']").first())
    await rec.pause(1000)
    await rec.press(T('board-fit'))
    await rec.press(T('assembly-panel').getByRole('button', { name: '모두 해제' }))
    await rec.pause(1000)
    await rec.press(T('assembly-view-3d'))
  })

  await rec.shot('A17', '거버와 내려받기', async () => {
    await rec.caption('거버: PCB 업체에 그대로 올릴 제조 파일을 zip 하나로 만듭니다')
    await rec.press(T('view-tab-pcb'))
    await rec.press(btn(/^거버$/))
    await rec.fast(() => T('gerber-zip').waitFor({ timeout: 120000 }), 4)
    await rec.caption('이 zip 하나를 JLCPCB 같은 PCB 업체 주문 화면에 그대로 올리면 됩니다')
    let dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(T('gerber-zip'))
    await dl
    await rec.pause(1200)
    // each caption goes up before the view it talks about (it ran ~2.5 s behind the drawer: review of 2026-10-30)
    await rec.caption('zip 안에는 7개 층(동박·솔더마스크·실크·외곽선)과 도금·비도금 드릴이 들어 있습니다', 'top')
    await rec.press(drawerTab('Netlist'))
    await rec.pause(800)
    const panel = T('gerber-zip-panel')
    await panel.scrollIntoViewIfNeeded()
    await rec.glide(panel)
    await rec.pause(2500)
    await rec.caption('.kicad_pcb 기판 파일과 .net 넷리스트도 바로 내려받습니다')
    await rec.press(page.locator('summary', { hasText: 'KiCad에서 열기' }).first())
    await rec.pause(1500)
    dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(pcbDone())
    await dl
    dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(btn('.net', true).first())
    await dl
    await rec.pause(700)
    await closeDrawer()
  })

  await rec.shot('A18', 'BOM 탭', async () => {
    await rec.caption('부품표(BOM)는 CSV로 받고, 부품마다 Mouser 검색 링크가 붙습니다')
    await rec.press(T('right-rail'))
    await rec.press(drawerTab('BOM'))
    await T('bom-table').waitFor({ timeout: 10000 })
    await rec.hover(T('bom-table'), 1800)
    const dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(btn('부품표 CSV'))
    await dl
    await rec.press(btn('표 복사'))
    await rec.pause(900)
    await rec.press(btn('Mouser 가격 조회'))
    await rec.fast(() => page.getByText(/Mouser(에서| 키)/).first().waitFor({ timeout: 60000 }), 4)
    await rec.pause(1800)
  })

  await rec.shot('A19', 'Guide·Code 탭', async () => {
    await rec.caption('Code 탭에는 이 회로를 만든 skidl 파이썬 코드가 있습니다')
    await rec.press(drawerTab('Guide'))
    await rec.pause(1400)
    await rec.press(drawerTab('Code'))
    await rec.pause(1500)
    await rec.press(btn('복사', true))
    await rec.pause(700)
    const dl = page.waitForEvent('download', { timeout: 30000 })
    await rec.press(btn('.py', true))
    await dl
    await rec.press(btn('수정', true))
    await page.getByText('로그인 후 실행할 수 있습니다').first().waitFor({ timeout: 5000 })
    await rec.hover(page.getByText('로그인 후 실행할 수 있습니다').first(), 2000)
    await rec.press(btn('취소', true))
    await closeDrawer()
  })

  await rec.shot('A20', 'THT와 핀 배열 경고', async () => {
    await rec.caption('THT로 바꿔 다시 만들면, 다리 순서가 다른 부품을 제작 전에 알려 줍니다')
    await rec.press(btn('THT', true))
    await T('pcb-stale').waitFor({ timeout: 10000 })
    await rec.hover(T('pcb-stale'), 1800)
    await rec.press(btn('AI 다듬기 OFF'))
    await rec.press(T('pcb-stale').getByRole('button', { name: 'PCB 다시 생성' }))
    const auth = page.locator('.auth-tabs')
    if (await auth.waitFor({ timeout: 6000 }).then(() => true, () => false)) {
      // the login window opened by itself in the middle of a THT caption, with nothing saying why (take of 2026-10-29)
      await rec.caption('AI 다듬기는 로그인해야 쓸 수 있어서, 로그인 없이는 다듬기 없이 기판을 만듭니다')
      await rec.pause(2200)
      await page.keyboard.press('Escape')
      await rec.caption('THT로 바꿔 다시 만들면, 다리 순서가 다른 부품을 제작 전에 알려 줍니다')
    }
    await rec.fast(() => T('pcb-pinout-banner').waitFor({ timeout: 300000 }), 3)
    await rec.recaption()
    if (await T('ai-note').count()) await rec.hover(T('ai-note'), 1200)
    await rec.hover(T('pcb-pinout-banner'), 3000)
    await rec.hover(page.locator("[data-pinout-fix='Q1']").first(), 1200)
    // the side-by-side 3D half stayed on "불러오는 중" for the last 7 s (frame review of 2026-10-30)
    if (await page.locator("[data-testid='kicad-3d']").count())
      await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 120000 }), 4)
    await rec.pause(800)
  })

  await rec.shot('A21', '동작 검사와 해결책', async () => {
    await rec.caption('되는 LED 회로는 동작 검사를 통과합니다')
    await rec.goto('/?demo=led')
    await T('op-chip').waitFor({ timeout: 60000 })
    await rec.hover(T('op-chip'), 2000)
    await rec.caption('저항을 10 Ω으로 바꾼 회로는 LED가 버티지 못한다고 알려 줍니다')
    await rec.goto('/?demo=led_bad')
    await T('op-chip').filter({ hasText: '동작 안 됨' }).waitFor({ timeout: 60000 })
    await rec.press(T('op-toggle'))
    await T('operating-panel').waitFor({ timeout: 5000 })
    await rec.hover(page.locator("[data-op-state='error']").first(), 3500)
    await rec.caption('해결책은 AI 편집 문장이나 Code 탭의 고칠 줄로 바로 넣을 수 있습니다', 'top')
    await rec.press(page.locator('[data-op-chat]').first())
    await rec.pause(1500)
    await rec.press(page.locator('[data-op-draft]').first())
    await rec.pause(1800)
  })

  await rec.shot('A22', '로그인 없이 AI 편집 보내기', async () => {
    await rec.caption('고친 문장을 실제로 보내려면 로그인해야 합니다')
    await rec.press(T('chat-input'))
    await page.keyboard.press('Enter')
    await page.locator('.auth-tabs').waitFor({ timeout: 10000 })
    await rec.pause(1800)
    await page.keyboard.press('Escape')
    await rec.pause(1500)
  })

  await rec.shot('A23', '고장 데모 555·릴레이', async () => {
    await rec.caption('555 전원이 3 V이면 동작 검사가 잡아냅니다')
    await rec.goto('/?demo=ne555_bad')
    await T('op-chip').filter({ hasText: '동작 안 됨' }).waitFor({ timeout: 60000 })
    await rec.press(T('op-toggle'))
    await rec.hover(page.locator("[data-op-rule='op_555']").first(), 2500)
    await rec.caption('보호 다이오드를 거꾸로 달아도 동작 검사가 잡아냅니다')
    await rec.goto('/?demo=relay_bad')
    await T('op-chip').filter({ hasText: '동작 안 됨' }).waitFor({ timeout: 60000 })
    await rec.press(T('op-toggle'))
    await rec.hover(page.locator("[data-op-rule='op_flyback']").first(), 2500)
    await rec.press(T('operating-close'))
    await rec.caption('여기까지는 로그인 없이 누구나 볼 수 있습니다')
    await rec.pause(2500)
  })
}
