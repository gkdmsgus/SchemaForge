// The full tour, logged in, on circuits really made in it (2026-10-30, at the owner's request: no demo circuits;
// what the demos showed is shown on the generated circuit). The login comes from the runner (storageState);
// nothing here types an address or a password. Scenes marked (OpenAI) make model calls on the deployed server.
import { appendFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { turn3D } from './lib.mjs'

/** a diagnostic take (videos/tour_diag.txt present): open the generated circuit from history and favorites,
 *  run one AI edit on it, and write page errors and blank screens to videos/debug/pageerrors.txt */
async function diag(rec) {
  const { page } = rec
  const out = join(rec.out, 'debug', 'pageerrors.txt')
  const log = s => appendFileSync(out, `[${new Date().toISOString()}] ${s}\n`)
  page.on('pageerror', e => log(`pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`))
  page.on('console', m => { if (m.type() === 'error') log(`console.error: ${m.text().slice(0, 600)}`) })
  const blank = async step => {
    const text = await page.evaluate(() => document.getElementById('root')?.innerText.length ?? -1).catch(() => -2)
    log(`${step}: root text length ${text}`)
    return text < 20
  }
  await rec.goto('/')
  await page.locator("button[aria-label='메뉴']").click()
  await page.getByRole('button', { name: '히스토리', exact: true }).click()
  await page.waitForTimeout(2500)
  const titles = await page.locator("[aria-label='이름 바꾸기']").evaluateAll(es => es.map(e => e.closest('div[style*="cursor"]')?.innerText.split('\n')[0]))
  log(`history: ${JSON.stringify(titles)}`)
  await page.getByText('전원 회로 데모').first().click()
  await page.waitForTimeout(4000)
  if (await blank('open from history')) return
  await rec.goto('/')
  await page.locator("button[aria-label='메뉴']").click()
  await page.getByRole('button', { name: '⭐ 즐겨찾기', exact: true }).click()
  await page.waitForTimeout(2500)
  const favs = await page.locator('div[style*="cursor: pointer"]').allInnerTexts()
  log(`favorites: ${JSON.stringify(favs.map(t => t.split('\n')[0]).slice(0, 6))}`)
  await page.locator('div[style*="cursor: pointer"]', { hasText: /전원|회로/ }).first().click()
  await page.waitForTimeout(4000)
  if (await blank('open from favorites')) return
  const chat = page.getByTestId('chat-input')
  if (await page.getByTestId('left-rail').count()) await page.getByTestId('left-rail').click()
  await chat.fill('출력 쪽에 100nF 커패시터를 하나 추가해줘')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(40000)
  await blank('after the AI edit')
}

export async function run(rec) {
  if (existsSync(join(rec.out, 'tour_diag.txt'))) return diag(rec)
  const { page } = rec
  // every sped-up wait in order, with its speed and wall-clock span, for scripts/tour/reedit.py: the edit placed the
  // waits by the wall clock, which ran up to 15 s apart from the recording in take 10 (frame review of 2026-10-30)
  const fastCalls = []
  rec.fastOwn ??= rec.fast
  const fast0 = rec.fastOwn
  rec.fast =async (fn, speed = 6) => {
    const call = { speed, a: rec.at(), b: null }
    fastCalls.push(call)
    try { return await fast0(fn, speed) } finally {
      call.b = rec.at()
      writeFileSync(join(rec.out, 'tour_fast_B.json'), JSON.stringify({ trimStart: rec.trimStart, calls: fastCalls }))
    }
  }
  const T = id => page.getByTestId(id)
  const btn = (name, exact = false) => page.getByRole('button', { name, exact })
  const drawerTab = name => page.locator('button.sf-drawer-tab', { hasText: name }).first()
  const closeDrawer = () => rec.press(page.locator('button.sf-drawer-tab').first().locator('xpath=..').getByRole('button', { name: '×' }))
  const pcbButton = () => page.getByRole('button', { name: /PCB (다시 )?생성/ }).first()
  // a circuit opened or made: the PCB button, or 회로 오류 where a structural error keeps the PCB from being made (an
  // opened version or session can be the one from before S06b's fixes: review of 2026-10-30)
  const opened = () => page.getByRole('button', { name: /PCB (다시 )?생성|회로 오류/ }).first()
  const pcbDone = () => page.getByRole('button', { name: /\.kicad_pcb/ })
  const kicker = page.locator('.sf-flow-kicker')
  // the runner keeps lib.mjs from its start, so this take cannot rely on helpers added to it since
  page.removeAllListeners('dialog')
  page.on('dialog', d => (/복사 완료|배치 체크|이 코드의 회로를 씁니다/.test(d.message()) ? d.accept() : d.dismiss()).catch(() => {}))
  const onScreen = async loc => {
    const b = await loc.boundingBox().catch(() => null)
    const v = page.viewportSize()
    return !!b && b.x + b.width > 0 && b.x < v.width && b.y + b.height > 0 && b.y < v.height
  }
  const schem = page.locator('svg:has(g[data-comp])').first()
  // the circuit's LED, the resistor in series with it and that resistor's value, from the saved circuit (S24, S25):
  // asked for "the resistor on the LED", the AI changed the 555's timing resistor (take 9, 2026-10-30)
  const ledParts = () => page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('sf_saved_results') || '[]')[0]
    const g = s?.graph ?? s?.result?.graph
    const leds = (g?.components ?? []).filter(c => /^D\d+$/.test(c.ref) && /LED/i.test(`${c.name ?? ''} ${c.value ?? ''}`))
    for (const led of leds) {
      const nets = g.nets.filter(n => !/^(GND|AGND|VCC|VDD|VIN|VBAT|\+?\d)/i.test(n.name) && n.nodes.some(x => x.ref === led.ref))
      const rs = [...new Set(nets.flatMap(n => n.nodes.map(x => x.ref)).filter(r => /^R\d+$/.test(r)))]
      if (rs.length === 1) return { led: led.ref, r: rs[0], value: g.components.find(c => c.ref === rs[0])?.value ?? null }
    }
    return { led: leds[0]?.ref ?? null, r: null, value: null }
  })
  // the AI editor's reply: its send button waits while the AI answers
  const replied = async () => {
    const send = "[data-testid='chat-input'] + button"
    await page.waitForFunction(s => document.querySelector(s)?.style.cursor === 'wait', send, { timeout: 5000 }).catch(() => {})
    await page.waitForFunction(s => document.querySelector(s)?.style.cursor !== 'wait', send, { timeout: 120000 }).catch(() => {})
  }

  await rec.shot('S01', '로그인한 홈', async () => {
    await rec.goto('/')
    // the login carries this browser's saved results from take to take: an earlier take's LED circuit made
    // B11b ask "저장된 결과가 있어요" at the top of the page, out of view (take 4, 2026-10-29)
    await page.evaluate(() => localStorage.removeItem('sf_saved_results'))
    // direction checks and placement ticks are kept by part, so an earlier take's ticked D1 came back ticked and
    // S13 unticked it (take 8, 2026-10-30)
    await page.evaluate(() => { localStorage.removeItem('sf_human_review_v1'); localStorage.removeItem('sf_assembly_v1') })
    // and a take stopped inside S16 left the assembly view on 2D, where S15 waits for the 3D model in vain
    await page.evaluate(() => localStorage.removeItem('sf_assembly_view'))
    rec.trimStart = Math.max(0, rec.at() - 0.2)
    await rec.caption('이제 로그인해서 설명 한 줄로 새 회로를 만듭니다')
    await btn('로그아웃').waitFor({ timeout: 15000 })
    await rec.hover(btn('로그아웃'), 1500)
    if (await T('cannot-generate').count()) throw new Error('this account cannot generate')
  })

  await rec.shot('S02', '설정', async () => {
    await rec.caption('설정에서 질문 단계와 계획 단계를 켜고 끌 수 있습니다')
    await rec.press(page.locator("button[aria-label='Settings']"))
    await page.getByRole('heading', { name: '설정' }).waitFor({ timeout: 5000 })
    for (const t of ['자동 재시도', '모호한 프롬프트 되묻기', '설계 계획 미리보기']) await rec.hover(page.getByText(t, { exact: true }).first(), 900)
    await rec.press(page.locator("button[aria-label='닫기']").first())
  })

  // B3 sets it when the server asks questions; B4 answers them only then
  let asked = false
  await rec.shot('S03', '설명 입력과 되묻기 (OpenAI)', async () => {
    await rec.caption('짧고 모호한 설명이면 회로를 정하기 전에 몇 가지를 먼저 묻습니다')
    const input = page.locator('.sf-home-input textarea')
    await rec.press(input)
    await input.pressSequentially('LED 깜빡이 만들어줘', { delay: 90 })
    await rec.pause(500)
    await page.keyboard.press('Control+Enter')
    await rec.fast(() => kicker.filter({ hasText: /가지만 확인합니다|설계 계획 확인/ }).first().waitFor({ timeout: 120000 }), 6)
    asked = /가지만 확인합니다/.test(await kicker.first().innerText())
  })

  await rec.shot('S04', '되묻기 답하기', async () => {
    if (!asked) return
    await rec.caption('목록에서 고르거나 직접 적어 답하면, 그 답이 사양으로 붙습니다')
    for (const li of await page.locator('ol.sf-questions > li').all()) {
      await rec.press(li.locator('.options button').first())
      await rec.pause(400)
    }
    await rec.hover(page.locator('input.sf-flow-input').last(), 800)
    await rec.hover(page.locator('.sf-flow-count'), 900)
    await rec.press(btn('이 답으로 회로 만들기'))
    await rec.fast(() => page.getByText('1단계 · 설계 계획 확인').waitFor({ timeout: 120000 }), 6)
  })

  await rec.shot('S05', '설계 계획 확인과 고치기 (OpenAI)', async () => {
    await rec.caption('만들기 전에 부품과 주의할 점을 담은 설계 계획을 먼저 확인합니다')
    await page.getByText('1단계 · 설계 계획 확인').waitFor({ timeout: 120000 })
    await page.mouse.move(640, 380, { steps: 8 })
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 110); await rec.pause(260) }
    await rec.caption('계획을 말로 고쳐 다시 받을 수 있습니다', 'top')
    await rec.press(btn('계획 고치기'))
    const ta = page.locator('textarea.sf-flow-textarea')
    await ta.waitFor({ timeout: 5000 })
    await ta.pressSequentially('깜빡이는 간격을 0.5초로 바꿔줘', { delay: 60 })
    await rec.press(btn('이 내용으로 계획 다시 짜기'))
    await rec.fast(() => btn('이 계획으로 회로 만들기').waitFor({ timeout: 120000 }), 6)
    await rec.scrollTo(page.locator('table.sf-table').first())
    await rec.pause(2200)
  })

  await rec.shot('S06', '회로 생성 (OpenAI)', async () => {
    await rec.caption('GPT-4o가 회로 코드를 쓰고, 서버가 연결을 점검(ERC)해 오류가 있으면 고칩니다')
    await rec.press(btn('이 계획으로 회로 만들기'))
    await rec.pause(4000)
    await rec.fast(() => page.getByRole('button', { name: /PCB (다시 )?생성|회로 오류/ }).first().waitFor({ timeout: 300000 }), 8)
    await rec.recaption()
  })

  await rec.shot('S06b', '연결 오류 해결 (OpenAI)', async () => {
    // a circuit the model left with errors is fixed the way a person would: a 해결 button puts the fix into the AI
    // editor and it is sent (blinkers of 2026-10-30 came with two batteries' pins open, or with no GND net, which
    // keeps the PCB from being made)
    const notice = T('erc-notice'), diag = T('circuit-diagnostics')
    const state = () => page.evaluate(() => ['erc-notice', 'circuit-diagnostics']
      .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|'))
    // an error notice is the one with role alert: "오류를 자동으로 고쳤습니다 (오류 2 → 0)" says 오류 too, and the
    // scene took a circuit the server had fixed for a broken one (review of 2026-10-30)
    const broken = async () => (await diag.count()) > 0 || ((await notice.count()) > 0 && await notice.getAttribute('role') === 'alert')
    const noticeText = async () => ((await notice.count()) ? await notice.innerText().catch(() => '') : '')
    if (!(await broken())) {
      const t = await noticeText()
      if (/자동으로 고쳤습니다/.test(t)) {
        await rec.caption('서버가 만든 회로를 점검(ERC)해, 찾은 연결 오류를 스스로 고쳤습니다', 'top')
        await rec.hover(notice, 2500)
      } else if (/돌리지 못했습니다/.test(t)) {
        // the check did not run: no "no problems" caption over it, and not counted as checked
        await rec.caption('점검을 돌리지 못하면 그렇게 알려 주고, PCB 단계의 기판 점검에서 다시 확인합니다', 'top')
        await rec.hover(notice, 2500)
        throw new Error('the netlist check did not run on the generated circuit')
      }
      return
    }
    await rec.caption('서버가 회로를 점검해, 남은 오류와 고치는 방법을 알려 줍니다', 'top')
    await rec.hover((await notice.count()) ? notice : diag, 2500)
    for (let round = 0; round < 3 && await broken(); round++) {
      const fix = [notice.locator('[data-erc-chat]').first(), diag.locator('[data-cir-fix]').first()]
      let pick = null
      for (const f of fix) if (!pick && await f.count()) pick = f
      if (!pick) break
      await rec.caption('해결 버튼을 누르면 고칠 문장이 AI 편집 칸에 들어가고, 보내면 AI가 고칩니다', 'top')
      if (await T('left-rail').count()) await rec.press(T('left-rail'))
      const before = await state()
      await rec.press(pick)
      await rec.pause(1200)
      await rec.press(T('chat-input'))
      await page.keyboard.press('Enter')
      // an applied edit makes the checks run again; a reply that only asks (which net?) leaves them as they were.
      // The reply is awaited first: waiting 60 s for a change left the question unanswered for 14 s (take 8)
      const changed = async () => {
        await replied()
        const moved = await page.waitForFunction(prev => ['erc-notice', 'circuit-diagnostics']
          .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|') !== prev, before, { timeout: 6000 }).then(() => true, () => false)
        if (moved) await page.waitForFunction(() => !/점검하는 중/.test(['erc-notice', 'circuit-diagnostics']
          .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|')), null, { timeout: 120000 }).catch(() => {})
        return moved
      }
      if (!(await rec.fast(changed, 4))) {
        // no change: the AI asked which net. It is answered
        await rec.caption('AI가 어느 연결인지 되물으면, 답해 주면 됩니다', 'top')
        await rec.press(T('chat-input'))
        await page.keyboard.type('네가 판단해서 가장 알맞은 넷에 연결해줘', { delay: 50 })
        await page.keyboard.press('Enter')
        await rec.fast(changed, 4)
      }
      await rec.pause(1500)
    }
    // a check that did not run after the edit is run again once; still not run, it is not counted as fixed
    const retry = notice.getByTestId('erc-retry')
    if (/돌리지 못했습니다/.test(await noticeText()) && await retry.count()) {
      await rec.press(retry)
      await page.waitForFunction(() => /점검하는 중/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 3000 }).catch(() => {})
      await rec.fast(() => page.waitForFunction(() => !/점검하는 중/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 120000 }).catch(() => {}), 4)
    }
    if (await notice.count()) await rec.hover(notice, 2000)
    if (/돌리지 못했습니다/.test(await noticeText())) throw new Error('the check of the fixed circuit did not run')
    if (await broken()) throw new Error('the circuit still has errors after three fixes')
  })

  await rec.shot('S07', '회로도 보기', async () => {
    await rec.caption('회로도에서 넷 이름에 마우스를 올리면 그 연결만 밝게 보입니다')
    // the circuit's own nets: the first two names in the legend under the schematic
    const legend = page.locator('span', { hasText: /^NETS$/ }).first().locator('xpath=..').locator(':scope > div')
    // a hover just after the result was drawn did not take (GND stayed dark in take 10): each name is checked to light
    // up, and entered again if it did not
    await rec.pause(600)
    for (let i = 0; i < Math.min(2, await legend.count()); i++) {
      const item = legend.nth(i)
      const lit = () => item.evaluate(e => getComputedStyle(e).backgroundColor === 'rgb(21, 24, 33)')
      await rec.hover(item, 300)
      if (!(await lit())) {
        const b = await item.boundingBox()
        await page.mouse.move(b.x + b.width / 2, b.y - 14, { steps: 4 })
        await rec.hover(item, 300)
      }
      if (!(await lit())) throw new Error(`the net name ${i + 1} did not light up on hover`)
      await rec.pause(1300)
    }
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

  await rec.shot('S08', '회로도 편집과 PDF', async () => {
    // the circuit-check window (left by an S06b that could not fix everything) covers the schematic's top left and
    // the toolbar's undo, and has no close button: nothing is touched under it (review of 2026-10-30)
    if (await T('circuit-diagnostics').count()) throw new Error('circuit-diagnostics covers the schematic')
    await rec.caption('부품을 옮기고 값과 연결을 바로 고칠 수 있습니다 (이 화면 안에서만 바뀝니다)')
    // only parts in view can be grabbed (some sit below the schematic's visible part), and not under the caption
    const sb = await schem.boundingBox()
    const inView = b => b && b.x > sb.x + 5 && b.x + b.width < sb.x + sb.width - 5 && b.y > sb.y + 5 && b.y + b.height < 600
    const parts = []
    for (const g of await page.locator('g[data-comp]').all()) if (inView(await g.boundingBox())) parts.push(g)
    if (parts.length < 3) throw new Error(`only ${parts.length} parts in view`)
    // left to right: the properties panel opens on the right and covered a part double-clicked there (review of
    // 2026-10-30), so the value is edited on the leftmost part
    const xs = []
    for (const g of parts) xs.push({ g, x: (await g.boundingBox()).x })
    xs.sort((a, b) => a.x - b.x)
    const [edited, picked, moved] = xs.map(o => o.g)
    // clicks go to the spot on screen, as a person's would (wires lie over pins, so element clicks wait forever)
    const at = async g => { const b = await rec.glide(g); return [b.x + b.width / 2, b.y + b.height / 2] }
    // the corner is taken where the schematic is now: a taller notice above it moved it down, and a click at the
    // corner taken at the start landed on the toolbar (take 9, 2026-10-30)
    const corner = async () => { const b = await schem.boundingBox(); return [b.x + 30, b.y + 30] }
    const empty = async () => page.mouse.click(...await corner())
    // the schematic toolbar's own undo (the AI editor's undo comes first in the page and took the S06b fix back:
    // take 8, 2026-10-30)
    const netUndo = btn('⌂', true).locator('xpath=../..').getByRole('button', { name: '↩ 되돌리기' })
    const checks = () => page.evaluate(() => ['erc-notice', 'circuit-diagnostics']
      .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|'))
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
    // points on the signal wires in view (power nets are drawn as symbols, with no wire path), tried in turn until
    // a click picks the net
    await rec.pause(500)
    const wirePoints = () => page.evaluate(() => {
      const v = document.querySelector('svg:has(g[data-comp])').getBoundingClientRect()
      const pts = []
      for (const p of document.querySelectorAll("g[data-net] path[stroke='transparent']")) {
        const L = p.getTotalLength()
        if (L < 40) continue
        for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
          const m = p.getPointAtLength(L * f)
          const c = p.getScreenCTM()
          const x = m.x * c.a + m.y * c.c + c.e, y = m.x * c.b + m.y * c.d + c.f
          if (!(x > v.left + 20 && x < v.right - 20 && y > v.top + 20 && y < Math.min(v.bottom, 600) - 20)) continue
          const top = document.elementFromPoint(x, y)
          if (top?.closest('g[data-net]') && !top.closest('g[data-comp]')) pts.push({ x, y })
        }
      }
      return pts
    })
    const del = btn('✕ 삭제')
    let pt = null
    for (const q of (await wirePoints()).slice(0, 6)) {
      await page.mouse.move(q.x, q.y, { steps: pt ? 8 : 14 })
      await rec.pause(300)
      await page.mouse.click(q.x, q.y)
      if (await del.waitFor({ timeout: 1500 }).then(() => true, () => false)) { pt = q; break }
      pt = null
      await empty()
    }
    if (!pt) throw new Error('no click on a signal wire picked its net')
    await rec.pause(700)
    const checked = await checks()
    await rec.press(del)
    await rec.pause(1600)
    await rec.press(netUndo)
    await rec.pause(1000)
    if (await checks() !== checked) throw new Error('the undo changed the circuit checks: it was not the schematic undo')
    await page.mouse.move(pt.x, pt.y, { steps: 10 })
    await page.mouse.down()
    // across the wire whichever way it runs: dragged along a vertical segment it did not bend (take 8, 2026-10-30)
    await page.mouse.move(pt.x + 35, pt.y + 35, { steps: 14 })
    await page.mouse.up()
    await rec.pause(900)
    const resetWires = btn('↺ 선 초기화')
    if (await resetWires.isVisible().catch(() => false)) await rec.press(resetWires)
    else console.log('  S08: the wire did not bend, no 선 초기화 to show')

    // pins in view and the net each one is wired to: pins carry no ref or net in the page, so a pin belongs
    // to the net with a wire ending on it (power pins, drawn as symbols, have none). Only the wires' ends: a wire
    // passing over another net's pin end on its way gave that pin the wrong net (review of 2026-10-30)
    const pinMap = () => page.evaluate(([x0, y0, x1]) => {
      const scr = (el, x, y) => { const c = el.getScreenCTM(); return { x: x * c.a + y * c.c + c.e, y: x * c.b + y * c.d + c.f } }
      const nets = [...document.querySelectorAll('g[data-net]')].map(g => {
        const pts = []
        for (const p of g.querySelectorAll("path[stroke='transparent']")) {
          const L = p.getTotalLength()
          for (const s of [0, L]) { const m = p.getPointAtLength(s); pts.push(scr(p, m.x, m.y)) }
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
          const net = power ? -1 : nets.findIndex(pts => pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 3))
          pins.push({ ref: comp.getAttribute('data-comp'), x: p.x, y: p.y, net, power })
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
      const [cx, cy] = await corner()
      await page.mouse.move(cx, cy, { steps: 16 })
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
        for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
          const m = p.getPointAtLength(L * f)
          const c = p.getScreenCTM()
          const x = m.x * c.a + m.y * c.c + c.e, y = m.x * c.b + m.y * c.d + c.f
          if (!(x > x0 + 20 && x < x1 - 20 && y > y0 + 20 && y < 560)) continue
          const top = document.elementFromPoint(x, y)
          if (top?.closest('g[data-net]') && !top.closest('g[data-comp]')) return { x, y }
        }
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
        if (t.ref !== h.ref && own && keep && !t.power && t.net !== own.net && d > 50 && (!move || d < move.d)) move = { h, t, d, keep }
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

  await rec.shot('S09', 'ERC 알림·Guide·즐겨찾기', async () => {
    await rec.caption('만든 회로는 기록에 저장되고, 북마크를 누르면 즐겨찾기에 들어갑니다')
    if (await T('erc-notice').count()) await rec.hover(T('erc-notice'), 2200)
    await rec.caption('Guide 탭에는 회로 설명, 배선 순서, 값을 정한 근거가 정리돼 있습니다', 'top')
    await rec.press(drawerTab('Guide'))
    await rec.pause(2600)
    await closeDrawer()
    await rec.caption('만든 회로는 기록에 저장되고, 북마크를 누르면 즐겨찾기에 들어갑니다')
    await rec.press(page.locator("button[title='즐겨찾기 추가']"), { timeout: 30000 })
    await page.locator("button[title='즐겨찾기 해제']").waitFor({ timeout: 10000 })
    await rec.pause(1000)
    await rec.press(page.locator("button[title='프롬프트 복사']"))
    await rec.pause(700)
  })

  await rec.shot('S10', 'PCB 탭 간이 보기', async () => {
    await rec.caption('PCB를 만들기 전에는 간이 그림이 보이고, 부품 방식(SMD/THT)을 고를 수 있습니다')
    await rec.press(T('view-tab-pcb'))
    await page.getByText('간이 보기예요').first().waitFor({ timeout: 10000 })
    await rec.hover(btn('SMD', true), 900)
    await rec.hover(btn('THT', true), 900)
    await rec.hover(btn('AI 다듬기 OFF'), 1100)
  })

  await rec.shot('S11', 'PCB 생성', async () => {
    await rec.caption('PCB 생성: 연결된 부품끼리 모이도록 배치하고, 두 층에 선을 긋습니다')
    await rec.press(pcbButton())
    await rec.pause(4000)
    await rec.fast(() => pcbDone().waitFor({ timeout: 300000 }), 3)
    await rec.recaption()
    await rec.caption('아래 줄에 배선 수·비아·트랙 길이·기판 크기·DRC 오류가 숫자로 나옵니다')
    await rec.hover(T('board-status'), 3500)
  })

  await rec.shot('S12', '기판 보기 바꾸기', async () => {
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

  await rec.shot('S13', '기판 검사와 방향 확인', async () => {
    await rec.caption('검사 목록과 함께, 거꾸로 달면 안 되는 부품의 +·− 자리를 기판 위에 표시합니다')
    await rec.press(T('view-2d'))
    const checks = T('board-checks').locator('button[aria-expanded]').first()
    if (await checks.getAttribute('aria-expanded') !== 'true') await rec.press(checks)
    await rec.pause(800)
    // the rows in the list's view only: past its bottom the pointer left the list and the screen, and the wheel that
    // follows went to the board instead of the list (review of 2026-10-30)
    const listBox = await T('board-checks').locator('div[style*="overflow-y"]').first().boundingBox()
    for (const c of await T('board-checks').locator('[data-check]').all()) {
      // to its title line: an open row is tall, and its middle can sit below the list
      const head = (await c.locator(':scope > button').count()) ? c.locator(':scope > button').first() : c
      const b = await head.boundingBox()
      if (!b || !listBox || b.y + b.height > listBox.y + listBox.height) break
      await rec.glide(head, 8)
      await rec.pause(250)
    }
    if (listBox) await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + Math.min(60, listBox.height / 2), { steps: 8 })
    // the direction-check row opens by itself while parts wait for a check: a click would fold it
    if (!(await page.locator("[data-check-detail='human_review']").count())) await rec.press(page.locator("[data-check='human_review'] > button").first())
    await rec.scrollTo(page.locator("[data-check='human_review']").first(), 200)
    await rec.pause(700)
    // the first part waiting for a direction check, whichever this circuit has (a ticked one would be unticked)
    const waiting = "[data-review][data-review-ok='0']"
    const first = await page.locator(waiting).filter({ has: page.locator("button[title='기판에서 보기']") }).first().getAttribute('data-review').catch(() => null)
    if (!first) throw new Error('no part waiting for a direction check')
    const row = page.locator(`[data-review='${first}']`).last()
    await rec.press(row.locator("button[title='기판에서 보기']"))
    await rec.pause(2200)
    await rec.press(row.locator('input[type=checkbox]'))
    await page.locator(`[data-review='${first}'][data-review-ok='1']`).first().waitFor({ timeout: 3000 })
    await rec.pause(1200)
  })

  await rec.shot('S14', 'KiCad 3D 한 바퀴', async () => {
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
    // turned by hand for a moment, so it reads as a view of its own (it passed in 0.6 s of the take 8 video)
    const shapes = await page.locator("[data-testid='board-3d']").first().boundingBox()
    await page.mouse.move(shapes.x + shapes.width / 2, shapes.y + shapes.height / 2, { steps: 10 })
    await page.mouse.down()
    await page.mouse.move(shapes.x + shapes.width / 2 + 150, shapes.y + shapes.height / 2 + 20, { steps: 45 })
    await page.mouse.up()
    await rec.pause(2200)
    await rec.press(T('board-real3d-toggle'))
    await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d'][data-state='ready']", { timeout: 120000 }), 4)
    await rec.pause(1200)
  })

  await rec.shot('S15', '배치하기 3D 체크', async () => {
    await rec.caption('배치하기: 실물 기판에 부품을 올리면서 하나씩 체크합니다')
    await rec.press(T('view-tab-assembly'))
    await rec.fast(() => page.waitForSelector("[data-testid='assembly-3d'] [data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 200000 }), 6)
    const panel = T('assembly-panel')
    await rec.hover(panel.locator('[data-assembly-line]').nth(2), 1500)
    // three of this board's parts; a part that must face one way asks to confirm its +/- first
    const refs = (await panel.locator('[data-assembly-ref]').evaluateAll(es => es.map(e => e.getAttribute('data-assembly-ref')))).filter(Boolean)
    for (const ref of [...new Set(refs)].slice(0, 3)) {
      await rec.press(panel.locator(`[data-assembly-ref='${ref}']`).first())
      await rec.pause(900)
      const confirm = page.locator(`[data-assembly-confirm='${ref}']`).first()
      if (await confirm.isVisible().catch(() => false)) { await rec.pause(700); await rec.press(confirm); await rec.pause(900) }
    }
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

  await rec.shot('S16', '배치하기 평면 체크', async () => {
    await rec.caption('평면 그림에서도 같은 체크를 할 수 있습니다')
    await rec.press(T('assembly-view-2d'))
    await rec.pause(800)
    // a part not ticked yet and with no direction to confirm: a click on one that must face one way shows where its
    // + and − go instead of ticking it (take 8 clicked U1, 2026-10-30)
    const ref = await T('assembly-panel').locator("[data-assembly-ref][aria-pressed='false']")
      .evaluateAll(es => es.find(e => /눌러서 배치 체크/.test(e.title))?.getAttribute('data-assembly-ref') ?? null)
    if (!ref) throw new Error('no part left to tick on the flat drawing')
    await rec.press(page.locator(`rect[data-assembly-hit='${ref}']`).first())
    await page.locator(`[data-placed='${ref}']`).first().waitFor({ state: 'attached', timeout: 3000 })
    await rec.pause(1000)
    await rec.press(T('board-fit'))
    await rec.press(T('assembly-panel').getByRole('button', { name: '모두 해제' }))
    await rec.pause(1000)
    await rec.press(T('assembly-view-3d'))
  })

  await rec.shot('S17', '거버와 내려받기', async () => {
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

  await rec.shot('S18', 'BOM 탭', async () => {
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

  await rec.shot('S19', 'Guide·Code 탭', async () => {
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
    await closeDrawer()
  })

  await rec.shot('S20', 'THT와 핀 배열 경고', async () => {
    await rec.caption('THT로 바꿔 다시 만들면, 다리 순서가 다른 부품을 제작 전에 알려 줍니다')
    await rec.press(btn('THT', true))
    await T('pcb-stale').waitFor({ timeout: 10000 })
    await rec.hover(T('pcb-stale'), 1800)
    await rec.press(T('pcb-stale').getByRole('button', { name: 'PCB 다시 생성' }))
    await T('pcb-loading').waitFor({ timeout: 15000 }).catch(() => {})
    await rec.fast(() => T('pcb-loading').waitFor({ state: 'hidden', timeout: 300000 }), 3)
    await rec.recaption()
    if (await T('pcb-pinout-banner').count()) {
      await rec.hover(T('pcb-pinout-banner'), 3000)
      const fix = page.locator('[data-pinout-fix]').first()
      if (await fix.count()) await rec.hover(fix, 1200)
    } else {
      await rec.caption('이 회로에는 다리 순서를 따로 확인할 부품이 없어, THT 기판이 바로 만들어집니다')
      await rec.hover(T('board-status'), 2000)
    }
    // the side-by-side 3D half stayed on "불러오는 중" for the last 7 s (frame review of 2026-10-30)
    if (await page.locator("[data-testid='kicad-3d']").count())
      await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 120000 }), 4)
    await rec.pause(800)
  })

  await rec.shot('S21', 'AI 다듬기 PCB (OpenAI)', async () => {
    await rec.caption('AI 다듬기를 켜면 AI가 배치를 고쳐 보고, 검사 수치가 좋아질 때만 받아들입니다')
    await rec.press(T('view-tab-pcb'))
    await rec.press(btn('AI 다듬기 OFF'))
    await rec.press(pcbButton())
    await rec.pause(5000)
    await rec.fast(() => pcbDone().waitFor({ timeout: 450000 }), 8)
    // the side-by-side view's 3D half stayed on "불러오는 중" to the end of the scene (review of 2026-10-30)
    if (await page.locator("[data-testid='kicad-3d']").count())
      await rec.fast(() => page.waitForSelector("[data-testid='kicad-3d']:is([data-state='ready'],[data-state='error'])", { timeout: 120000 }), 4)
    await rec.recaption()
    if (await T('board-ai').count()) {
      await rec.hover(T('board-ai'), 1200)
      await rec.press(T('board-ai-toggle'))
      await rec.pause(3500)
    }
    await rec.hover(T('board-status'), 1800)
  })


  await rec.shot('S23', 'AI 편집과 되돌리기 (OpenAI)', async () => {
    await rec.caption('고칠 점을 말로 적으면 AI가 부품을 더하거나 바꾸고, 바뀐 곳이 잠깐 빛납니다')
    await rec.press(T('view-tab-schematic'))
    if (await T('left-rail').count()) await rec.press(T('left-rail'))
    const chat = T('chat-input')
    // a free reference and the two nets, said as a person who reads the schematic would: asked for "a 100nF capacitor
    // on the power input", the AI reused C3, the 100nF already there, and moved the battery off VCC (take 10)
    const used = await page.locator("g[data-comp^='C']").evaluateAll(es => es.map(e => +(e.getAttribute('data-comp') || '').slice(1)).filter(n => n > 0))
    const cNew = `C${Math.max(0, ...used) + 1}`
    const parts = await page.locator('g[data-comp]').count()
    await rec.press(chat)
    await chat.pressSequentially(`VCC와 GND 사이에 100nF 커패시터 ${cNew}를 하나 추가해줘`, { delay: 55 })
    await page.keyboard.press('Enter')
    // the reply first: after S06b's AI fixes the notice already says "AI 편집 뒤", so waiting for it alone ended
    // before the edit, and the changed parts flashed after the view had gone to the PCB tab (review of 2026-10-30)
    await rec.fast(async () => {
      await replied()
      await page.waitForFunction(() => /AI 편집 뒤/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 120000 })
    }, 4)
    await rec.pause(2500)
    const added = await page.locator('g[data-comp]').count() === parts + 1 && await page.locator(`g[data-comp='${cNew}']`).count() === 1
    await rec.caption('회로가 바뀌면 예전 기판은 쓰지 않도록 PCB 탭에서 알려 줍니다')
    await rec.press(T('view-tab-pcb'))
    await rec.hover(T('pcb-stale'), 2500)
    await rec.caption('↩ 되돌리기로 마지막 AI 수정을 취소합니다')
    await rec.press(T('view-tab-schematic'))
    await rec.press(page.locator("button[title='마지막 AI 수정 취소']"))
    await rec.pause(1800)
    if (!added) throw new Error(`the AI edit did not add ${cNew} as one new part`)
  })

  await rec.shot('S24','동작 검사와 해결책 (OpenAI)', async () => {
    await rec.caption('저항 값을 10 Ω으로 잘못 바꾸면, 동작 검사가 바로 잡아냅니다')
    const panelOpen = async () => {
      if (await T('op-toggle').getAttribute('aria-expanded') !== 'true') await rec.press(T('op-toggle'))
      await T('operating-panel').waitFor({ timeout: 5000 })
    }
    const panelClose = async () => { if (await T('op-toggle').getAttribute('aria-expanded') === 'true') await rec.press(T('op-toggle')) }
    // a row by its rule, part and summary line (with the numbers): state and rule name alone took a LED row failing
    // before and after with other numbers for the same row (review of 2026-10-30)
    const rowKey = row => row.evaluate(e => `${e.getAttribute('data-op-rule')}|${e.getAttribute('data-op')}|${(e.innerText || '').split('\n').slice(0, 3).join(' ')}`)
    const errors = async () => { const ks = []; for (const row of await T('operating-panel').locator("[data-op-state='error']").all()) ks.push(await rowKey(row)); return ks }
    // the rows failing already (a generated circuit can fail one from the start)
    await panelOpen()
    const before = await errors()
    await panelClose()
    if (await T('left-rail').count()) await rec.press(T('left-rail'))
    // the LED's series resistor by name, whose heat row alone has no 해결 button (take 9, 2026-10-30)
    const { r: series, value: original } = await ledParts()
    console.log(`  S24: the LED's series resistor is ${series ?? 'not found'} (${original ?? '?'})`)
    const chat = T('chat-input')
    await rec.press(chat)
    await chat.fill('')
    await chat.pressSequentially(series ? `LED에 연결된 저항 ${series}의 값을 10Ω으로 바꿔줘` : 'LED에 연결된 저항 값을 10Ω으로 바꿔줘', { delay: 60 })
    await page.keyboard.press('Enter')
    // the reply first: a circuit failing a row from the start already shows 동작 안 됨 (review of 2026-10-30)
    await rec.fast(async () => {
      await replied()
      await page.waitForFunction(() => /동작 안 됨/.test(document.querySelector("[data-testid='op-chip']")?.innerText || ''), null, { timeout: 120000 })
    }, 4)
    await panelOpen()
    // a row that was not failing before, the one with a 해결 button first (10 Ω fails the LED current, which has
    // one, and the resistor's heat, which has none)
    let fresh = null
    for (let i = 0; i < 20 && !fresh; i++) {
      const rows = []
      for (const row of await T('operating-panel').locator("[data-op-state='error']").all()) if (!before.includes(await rowKey(row))) rows.push(row)
      for (const row of rows) if (!fresh && await row.locator('[data-op-chat]').count()) fresh = row
      if (!fresh && rows.length && i >= 4) fresh = rows[0]
      if (!fresh) await rec.pause(500)
    }
    if (!fresh) throw new Error('the wrong value made no new operating-check error')
    await fresh.scrollIntoViewIfNeeded()
    await rec.hover(fresh, 3000)
    const fix = fresh.locator('[data-op-chat]').first()
    if (await fix.count()) {
      await rec.caption('해결 버튼을 누르면 고칠 문장이 AI 편집 칸에 들어가고, 보내면 고쳐집니다', 'top')
      await rec.press(fix)
      await rec.pause(1500)
      await rec.press(chat)
      await page.keyboard.press('Enter')
    } else if (series && original) {
      // no computed fix for this row: said in words, as a person would, with the value it had (the editor gets the
      // circuit as it is now, 10 Ω, and may not know the old value)
      await rec.caption('해결 방법을 AI 편집 칸에 그대로 적어 보내면 고쳐집니다', 'top')
      await rec.press(chat)
      await chat.fill('')
      await chat.pressSequentially(`${series} 값을 다시 ${original}로 바꿔줘`, { delay: 60 })
      await page.keyboard.press('Enter')
    } else {
      await rec.caption('↩ 되돌리기로 방금 바꾼 값을 취소할 수도 있습니다', 'top')
      await rec.press(page.locator("button[title='마지막 AI 수정 취소']"))
    }
    // back to the rows failing before the wrong value
    await rec.fast(() => page.waitForFunction(n => document.querySelectorAll("#operating-panel [data-op-state='error']").length <= n, before.length, { timeout: 120000 }), 4)
    await rec.pause(1200)
    await panelClose()
    await rec.hover(T('op-chip'), 2000)
  })

  await rec.shot('S25', 'AI 편집으로 부품 빼기 (OpenAI)', async () => {
    await rec.caption('LED를 빼면 끊긴 연결을 찾아 PCB 생성을 막고, 되돌리기로 바로 복구합니다')
    if (await T('left-rail').count()) await rec.press(T('left-rail'))
    const chat = T('chat-input')
    const parts = await page.locator('g[data-comp]').count()
    // the LED by name: with two LEDs "LED 빼줘" can end in a question, and the undo below would then take back
    // S24's fix (review of 2026-10-30)
    const { led } = await ledParts()
    await rec.press(chat)
    await chat.fill('')
    await chat.pressSequentially(led ? `LED ${led} 빼줘` : 'LED 빼줘', { delay: 80 })
    await page.keyboard.press('Enter')
    const diag = T('circuit-diagnostics')
    const shown = await rec.fast(async () => { await replied(); return diag.waitFor({ timeout: 10000 }).then(() => true, () => false) }, 4)
    if (shown) {
      await rec.hover(diag, 3000)
      const errBtn = page.getByRole('button', { name: /회로 오류/ }).first()
      if (await errBtn.count()) await rec.hover(errBtn, 1500)
    }
    // undone only when this edit changed the circuit
    if (shown || await page.locator('g[data-comp]').count() !== parts) await rec.press(page.locator("button[title='마지막 AI 수정 취소']"))
    // the restored circuit (LED back, no diagnostics) under this caption, not first under B14's (review of 2026-10-30)
    await page.waitForFunction(n => document.querySelectorAll('g[data-comp]').length === n, parts, { timeout: 10000 })
    await diag.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
    await rec.pause(2200)
    if (!shown) throw new Error('circuit-diagnostics did not show after removing the LED')
  })

  await rec.shot('S06a', 'Code 탭 고치고 실행', async () => {
    await rec.caption('Code 탭에서 코드를 고쳐 실행하면, 서버가 다시 돌려 회로를 바꿉니다', 'top')
    await rec.press(T('view-tab-schematic'))
    // a resistor this circuit has, for the line that changes its value
    const rref = (await page.locator("g[data-comp^='R']").evaluateAll(es => es.map(e => e.getAttribute('data-comp')))).find(r => /^R\d+$/.test(r || ''))
    if (!rref) throw new Error('no resistor on the schematic for the code change')
    await rec.press(drawerTab('Code'))
    await rec.press(btn('수정', true))
    const code = page.locator("textarea[aria-label='skidl 코드 편집']")
    await code.waitFor({ timeout: 10000 })
    const original = await code.inputValue()
    // the caret at the start of the generate_netlist line: added lines run before the netlist is written
    const lineAt = text => text.lastIndexOf('\n', text.lastIndexOf('generate_netlist(')) + 1
    const caret = i => code.evaluate((t, at) => { t.focus(); t.setSelectionRange(at, at); t.scrollTop = Math.max(0, t.value.slice(0, at).split('\n').length * 20 - t.clientHeight / 2) }, i)
    await caret(lineAt(original))
    await rec.caption('틀린 줄이 있으면 회로를 바꾸지 않고, 오류와 그 줄을 알려 줍니다', 'top')
    await page.keyboard.type('R9 = Part(\n', { delay: 70 })
    await page.keyboard.press('Control+Enter')
    const err = page.locator('.sf-code-error')
    await rec.fast(() => err.waitFor({ timeout: 120000 }), 4)
    await rec.hover(err, 2200)
    const jump = err.locator('button.is-bad').first()
    if (await jump.count()) { await rec.press(jump); await rec.pause(1200) }
    await code.fill(original)
    await caret(lineAt(original))
    await rec.caption(`고친 줄(${rref} 값을 1k로)을 넣고 실행하면 회로가 바뀝니다`, 'top')
    await page.keyboard.type(`Part.get('${rref}').value = '1k'\n`, { delay: 60 })
    await page.keyboard.press('Control+Enter')
    await rec.fast(() => page.getByText('코드를 실행했습니다').first().waitFor({ timeout: 120000 }), 4)
    await rec.pause(1200)
    await closeDrawer().catch(() => {})
    await rec.hover(page.locator('[data-testid=right-panel]').getByText(rref, { exact: true }).first(), 2000).catch(() => {})
  })

  await rec.shot('S26', '재생성과 버전 (OpenAI)', async () => {
    await rec.caption('↺로 같은 설명을 다시 만들면 버전이 생기고, v1·v2를 오가며 비교할 수 있습니다')
    await rec.press(page.locator("button[title='재생성 (저장된 결과 대신 새로 생성)']"))
    await rec.pause(2500)
    await rec.fast(() => btn('v2', true).waitFor({ timeout: 300000 }), 8)
    await rec.recaption()
    await rec.press(btn('v1', true))
    await rec.pause(1500)
    await rec.hover(btn('Apply', true), 1000)
    await rec.press(btn('v2', true))
    await rec.pause(1500)
    await rec.press(btn('v1', true))
    await rec.pause(800)
    await rec.press(btn('Apply', true))
    await rec.pause(1500)
  })

  await rec.shot('S27', '저장된 결과 불러오기', async () => {
    await rec.caption('이미 만든 설명을 다시 넣으면 새로 만들지 않고 저장된 결과를 불러옵니다')
    const prompt = await page.evaluate(() => JSON.parse(localStorage.getItem('sf_saved_results') || '[]')[0]?.prompt)
    if (!prompt) throw new Error('no saved result in this browser')
    await rec.press(page.getByText(/^v0\.4 · /).first())
    const input = page.locator('.sf-home-input textarea')
    await input.waitFor({ timeout: 10000 })
    await input.fill(prompt)
    await rec.press(btn('회로 만들기', true))
    await page.getByText('저장된 결과가 있어요').waitFor({ timeout: 10000 })
    await rec.pause(1800)
    await rec.press(btn('불러오기', true))
    await opened().waitFor({ timeout: 30000 })
    await rec.pause(1200)
  })

  await rec.shot('S28', '회로 종류로 만들기 (OpenAI)', async () => {
    await rec.caption('회로 종류와 사양 칩으로 시작하면 질문 없이 바로 계획으로 넘어갑니다')
    await rec.press(page.getByText(/^v0\.4 · /).first())
    await rec.scrollTo(page.getByRole('heading', { name: '회로 종류로 시작하기' }))
    await rec.press(page.locator('button[role=listitem].sf-type-row', { hasText: '전원 회로' }))
    const panel = page.locator('.sf-spec-panel')
    await rec.press(panel.getByRole('button', { name: /선형 레귤레이터/ }).first())
    await rec.press(panel.getByRole('button', { name: 'USB 5V', exact: true }).first())
    await rec.press(panel.getByRole('button', { name: '3.3V', exact: true }).first())
    await page.getByText('필수 항목을 모두 골랐습니다.').waitFor({ timeout: 5000 })
    await rec.press(btn('전원 회로 만들기').last())
    await rec.fast(() => btn('이 계획으로 회로 만들기').waitFor({ timeout: 120000 }), 6)
    await rec.recaption()
    await rec.pause(2000)
    await rec.press(btn('이 계획으로 회로 만들기'))
    await rec.pause(2500)
    await rec.fast(() => opened().waitFor({ timeout: 300000 }), 8)
    await rec.recaption()
    await rec.pause(2500)
  })

  await rec.shot('S29', '히스토리', async () => {
    await rec.caption('만든 회로는 날짜별 기록에 남고, 이름을 바꾸거나 다시 열 수 있습니다', 'top')
    await rec.press(page.locator("button[aria-label='메뉴']"))
    await rec.press(btn('히스토리', true))
    const pen = btn('이름 바꾸기', true).first()
    await pen.waitFor({ state: 'attached', timeout: 15000 })
    await rec.glide(pen.locator('xpath=..'))
    await rec.pause(500)
    await rec.press(pen)
    const name = page.locator("input[aria-label='기록 이름']")
    await name.waitFor({ timeout: 3000 })
    await name.fill('')
    await name.pressSequentially('내 데모 회로', { delay: 70 })
    await page.keyboard.press('Enter')
    await page.getByText('내 데모 회로').first().waitFor({ timeout: 5000 })
    await rec.pause(1200)
    await rec.press(page.getByText('내 데모 회로').first())
    await opened().waitFor({ timeout: 30000 })
    await rec.pause(1200)
  })

  await rec.shot('S30', '즐겨찾기', async () => {
    await rec.caption('북마크한 회로는 즐겨찾기 탭에서 바로 열립니다', 'top')
    // a closed drawer keeps its tabs in the page, slid out to the left, so isVisible() says yes
    if (!(await onScreen(btn('⭐ 즐겨찾기', true)))) await rec.press(page.locator("button[aria-label='메뉴']"))
    await rec.press(btn('⭐ 즐겨찾기', true))
    await rec.pause(1200)
    const fav = page.locator('div[style*="cursor: pointer"]', { hasText: /깜빡이|회로/ }).first()
    await rec.press(fav)
    await opened().waitFor({ timeout: 30000 })
    await rec.hover(page.locator("button[title='즐겨찾기 해제']"), 1800)
    await rec.caption('북마크를 다시 누르면 즐겨찾기에서 빠집니다')
    await rec.press(page.locator("button[title='즐겨찾기 해제']"))
    await page.locator("button[title='즐겨찾기 추가']").waitFor({ timeout: 10000 })
    await rec.pause(1800)
  })

  await rec.shot('S31', '기록 지우기', async () => {
    await rec.caption('필요 없는 기록은 ✕로 지웁니다 (서버에 저장된 기록에서도 지워집니다)', 'top')
    if (!(await onScreen(btn('히스토리', true)))) await rec.press(page.locator("button[aria-label='메뉴']"))
    await rec.press(btn('히스토리', true))
    // the newest '내 데모 회로' is this take's LED circuit, renamed in B14 (not the favourite opened in B15)
    const rows = page.locator('div[style*="cursor: pointer"]', { hasText: '내 데모 회로' })
    await rows.first().waitFor({ timeout: 15000 })
    const n = await rows.count()
    await rec.glide(rows.first())
    await rec.pause(700)
    await rec.press(rows.first().getByRole('button', { name: '✕', exact: true }))
    for (let i = 0; i < 40 && await rows.count() !== n - 1; i++) await rec.pause(250)
    // the next row slid up under the pointer and looked picked for deletion too (review of 2026-10-30)
    await page.mouse.move(700, 360, { steps: 10 })
    await rec.pause(1500)
    if (await T('drawer-notice').count()) throw new Error('the server did not delete the record: ' + await T('drawer-notice').innerText())
    if (await rows.count() !== n - 1) throw new Error(`the record list did not lose one item (${n} → ${await rows.count()})`)
    // the side drawer's own × (closeDrawer() is for the bottom tab drawer of the result screen)
    await rec.press(page.getByText('SCHEMAFORGE', { exact: true }).locator('xpath=../..').getByRole('button', { name: '×' }))
    await rec.pause(800)
  })
}
