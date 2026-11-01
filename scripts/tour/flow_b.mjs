// The logged-in flow on each circuit type of the home screen (plan week 3: "회로 종류 5개 이상으로 전체 흐름 통과"):
// type and spec chips -> plan -> circuit (its errors fixed with the 해결 buttons, at most three rounds) -> PCB ->
// DRC and unconnected counts -> gerber zip. Each type's result goes to videos/flow_results.json as soon as it is known;
// a type passes only with no circuit error left, DRC errors 0, unconnected 0 and a gerber zip downloaded. Run by
// scripts/record_tour.mjs B with "flow" in videos/tour_control.txt.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

// the chips picked for each type: required ones, plus a few that make the circuit concrete
const CASES = [
  { key: 'led', type: 'LED 제어', chips: ['점멸 (블링크)', '3', '9V', '빨강'] },
  { key: 'power', type: '전원 회로', chips: ['선형 레귤레이터', '7-12V', '5V', '500mA'] },
  { key: 'timer', type: '타이머 / 펄스', chips: ['비안정 (점멸)', '9V', '1Hz'] },
  { key: 'sensor', type: '센서 입력', chips: ['조도', '5V', '아날로그'] },
  { key: 'filter', type: '필터 회로', chips: ['LPF (저역)', '액티브 1차', '1kHz'] },
  { key: 'audio', type: '오디오 앰프', chips: ['헤드폰 앰프', '9V 배터리', '20dB'] },
  { key: 'mcu', type: 'MCU 보드', chips: ['ATmega328P', '5V', '리셋 버튼', '크리스털', '디커플링'] },
]

export async function run(rec) {
  const { page } = rec
  const T = id => page.getByTestId(id)
  const btn = (name, exact = false) => page.getByRole('button', { name, exact })
  const dir = join(rec.out, 'flow')
  mkdirSync(dir, { recursive: true })
  // videos/flow_only.txt (keys, one per line) runs those types again; the other types keep their last result
  const resultsFile = join(rec.out, 'flow_results.json')
  const onlyFile = join(rec.out, 'flow_only.txt')
  const only = existsSync(onlyFile) ? readFileSync(onlyFile, 'utf8').split(/\s+/).filter(Boolean) : null
  const kept = only && existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')).results : []
  const results = CASES.map(c => kept.find(r => r.key === c.key && !only.includes(c.key))).filter(Boolean)
  const save = () => writeFileSync(resultsFile, JSON.stringify({ at: new Date().toISOString(),
    results: CASES.map(c => results.find(r => r.key === c.key)).filter(Boolean) }, null, 1))
  page.removeAllListeners('dialog')
  page.on('dialog', d => (/복사 완료|배치 체크/.test(d.message()) ? d.accept() : d.dismiss()).catch(() => {}))
  const checksText = () => page.evaluate(() => ['erc-notice', 'circuit-diagnostics']
    .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|'))
  const broken = async () => (await T('circuit-diagnostics').count()) > 0
    || ((await T('erc-notice').count()) > 0 && await T('erc-notice').getAttribute('role') === 'alert')
  const replied = async () => {
    const send = "[data-testid='chat-input'] + button"
    await page.waitForFunction(s => document.querySelector(s)?.style.cursor === 'wait', send, { timeout: 5000 }).catch(() => {})
    await page.waitForFunction(s => document.querySelector(s)?.style.cursor !== 'wait', send, { timeout: 120000 }).catch(() => {})
  }
  const metric = async id => {
    const t = await T(id).first().innerText().catch(() => '')
    const m = t.match(/(\d+)\s*$/)
    return { text: t.replace(/\s+/g, ' ').trim(), n: m ? Number(m[1]) : null }
  }

  for (const [i, c] of CASES.entries()) {
    if (only && !only.includes(c.key)) continue
    const r = { key: c.key, type: c.type, chips: c.chips, stage: 'start', pass: false }
    results.push(r)
    await rec.shot(`F${i + 1}`, c.type, async () => {
      const t0 = Date.now()
      await rec.goto('/')
      // a type run again had its earlier result offered ("저장된 결과가 있어요") instead of a new plan (2026-11-01)
      await page.evaluate(() => localStorage.removeItem('sf_saved_results'))
      await rec.caption(`${c.type}: 사양을 고르고 계획 → 회로 → PCB → 거버까지 확인합니다`)
      await rec.scrollTo(page.getByRole('heading', { name: '회로 종류로 시작하기' }))
      await rec.press(page.locator('button[role=listitem].sf-type-row', { hasText: c.type }).first())
      const panel = page.locator('.sf-spec-panel')
      // each chip brought to the middle first: the timer's opened at the bottom edge, and the press measured it while
      // the page was still scrolling ("outside the screen", 2026-11-01)
      for (const chip of c.chips) {
        const b = panel.getByRole('button', { name: chip, exact: true }).first()
        await b.evaluate(e => e.scrollIntoView({ block: 'center', behavior: 'instant' }))
        await rec.pause(300)
        await rec.press(b)
      }
      await page.getByText('필수 항목을 모두 골랐습니다.').waitFor({ timeout: 5000 })
      await rec.press(btn(`${c.type} 만들기`).last())
      r.stage = 'plan'
      // a type with every required chip goes straight to the plan; answered with the first options if it asks
      const kicker = page.locator('.sf-flow-kicker')
      const offer = page.getByText('저장된 결과가 있어요')
      await rec.fast(() => kicker.filter({ hasText: /가지만 확인합니다|설계 계획 확인/ }).first().or(offer).first().waitFor({ timeout: 180000 }), 6)
      if (await offer.isVisible().catch(() => false)) {
        r.offeredSaved = true
        await rec.press(btn('새로 생성', true))
        await rec.fast(() => kicker.filter({ hasText: /가지만 확인합니다|설계 계획 확인/ }).first().waitFor({ timeout: 180000 }), 6)
      }
      if (/가지만 확인합니다/.test(await kicker.first().innerText())) {
        r.asked = true
        for (const li of await page.locator('ol.sf-questions > li').all()) await rec.press(li.locator('.options button').first())
        await rec.press(btn('이 답으로 회로 만들기'))
      }
      await rec.fast(() => btn('이 계획으로 회로 만들기').waitFor({ timeout: 180000 }), 6)
      r.plan = (await page.locator('table.sf-table').first().innerText().catch(() => '')).split('\n').slice(0, 12).join(' / ').slice(0, 600)
      await rec.press(btn('이 계획으로 회로 만들기'))
      r.stage = 'circuit'
      await rec.fast(() => page.getByRole('button', { name: /PCB (다시 )?생성|회로 오류/ }).first().waitFor({ timeout: 300000 }), 8)
      r.parts = await page.locator('g[data-comp]').count()
      r.checksAtFirst = (await checksText()).replace(/\s+/g, ' ').slice(0, 500)
      // errors fixed the way a person would: the 해결 button, then send; a question is answered
      r.fixRounds = 0
      for (let round = 0; round < 3 && await broken(); round++) {
        const pick = [T('erc-notice').locator('[data-erc-chat]').first(), T('circuit-diagnostics').locator('[data-cir-fix]').first()]
        // a visible one: after the AI asked back, a hidden 해결 button stayed in the page and the press waited 15 s
        let fix = null
        for (const f of pick) if (!fix && await f.isVisible().catch(() => false)) fix = f
        if (!fix) break
        r.fixRounds++
        if (await T('left-rail').count()) await rec.press(T('left-rail'))
        const before = await checksText()
        await rec.press(fix)
        await rec.press(T('chat-input'))
        await page.keyboard.press('Enter')
        const changed = async () => {
          await replied()
          const moved = await page.waitForFunction(prev => ['erc-notice', 'circuit-diagnostics']
            .map(id => document.querySelector(`[data-testid='${id}']`)?.innerText || '').join('|') !== prev, before, { timeout: 6000 }).then(() => true, () => false)
          if (moved) await page.waitForFunction(() => !/점검하는 중/.test(document.querySelector("[data-testid='erc-notice']")?.innerText || ''), null, { timeout: 120000 }).catch(() => {})
          return moved
        }
        if (!(await rec.fast(changed, 4))) {
          await rec.press(T('chat-input'))
          await page.keyboard.type('네가 판단해서 가장 알맞은 넷에 연결해줘', { delay: 30 })
          await page.keyboard.press('Enter')
          await rec.fast(changed, 4)
        }
      }
      r.checksAfterFix = (await checksText()).replace(/\s+/g, ' ').slice(0, 500)
      if (await broken()) { r.stage = 'circuit-errors-left'; throw new Error(`circuit errors left after ${r.fixRounds} fixes`) }
      if (/돌리지 못했습니다/.test(r.checksAfterFix)) { r.stage = 'erc-not-run'; throw new Error('the netlist check did not run') }

      r.stage = 'pcb'
      await rec.press(T('view-tab-pcb'))
      await rec.press(page.getByRole('button', { name: /PCB (다시 )?생성/ }).first())
      await rec.fast(() => page.getByRole('button', { name: /\.kicad_pcb/ }).waitFor({ timeout: 420000 }), 3)
      // the counts show once the placement and routing replay has settled
      await rec.fast(() => T('board-drc').first().waitFor({ timeout: 180000 }), 4)
      r.drc = await metric('board-drc')
      r.unconnected = await metric('board-unconnected')
      r.routing = (await metric('board-routing')).text
      r.size = (await metric('board-size')).text
      await page.screenshot({ path: join(dir, `${c.key}_board.png`) })
      if (r.drc.n !== 0) { r.stage = 'drc'; throw new Error(`DRC: ${r.drc.text}`) }
      if (r.unconnected.n !== 0) { r.stage = 'unconnected'; throw new Error(`unconnected: ${r.unconnected.text}`) }

      r.stage = 'gerber'
      await rec.press(btn(/^거버$/))
      await rec.fast(() => T('gerber-zip').waitFor({ timeout: 180000 }), 4)
      const dl = page.waitForEvent('download', { timeout: 60000 })
      await rec.press(T('gerber-zip'))
      const file = join(dir, `${c.key}_gerber.zip`)
      await (await dl).saveAs(file)
      r.gerberBytes = statSync(file).size
      if (r.gerberBytes < 1000) { r.stage = 'gerber-small'; throw new Error(`gerber zip of ${r.gerberBytes} bytes`) }
      r.stage = 'done'
      r.pass = true
      r.seconds = Math.round((Date.now() - t0) / 1000)
    })
    if (!r.pass) r.error = rec.failed.at(-1)?.[2]
    save()
    console.log(`  ${c.type}: ${r.pass ? 'pass' : 'FAIL at ' + r.stage} ${r.drc ? r.drc.text : ''} ${r.unconnected ? r.unconnected.text : ''}`)
  }
  console.log(`  flow: ${results.filter(r => r.pass).length}/${results.length} types passed`)
}
