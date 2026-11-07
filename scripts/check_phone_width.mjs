// Browser checks for the result screen on a phone (375×812, touch), on each demo circuit (led, ne555, relay, motor).
// A button counts as reachable when all of its box is on the screen and nothing is drawn over its centre; each one is
// then tapped and what it opens is looked for. M1 the schematic opens with every part on the screen, M2 the two panel
// toggles and the two rails open their panel on the screen and close it again, and the parts are still all on the
// screen after, M3 Netlist, Guide, BOM and Code open in the bottom drawer, M4 'PCB 생성' makes the board, which is drawn
// at least half the screen wide, its downloads are reachable, and its checks list opens on the screen and folds again,
// M5 SCHEMATIC, PCB and 배치하기 switch the view, and 배치하기's board is drawn at least half the screen wide too, M6
// nothing of the result screen sticks out past the right edge in any of those states (a box that scrolls sideways, like
// the netlist text, may hold wider lines, and the drawings pan), M7 a saved result opened again from the side menu starts
// with both panels closed and the parts on the screen. (Before M1-M7 the side panels opened at 260 px and 240 px beside
// the schematic, which had no width left, and the toggles, 'PCB 생성' and the parts sat past the right edge: review of
// 2026-11-07. The board was 159 px wide beside its 3D view, and 배치하기's 19 px beside its list.)
// Needs the vite dev server (npm run dev), its API and KiCad (M4 makes a real board).
// Usage: node scripts/check_phone_width.mjs [BASE]   (default http://localhost:3000)
import { chromium } from 'playwright'

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const VW = 375, VH = 812
const DEMOS = ['led', 'ne555', 'relay', 'motor']
let failed = 0
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`) }

/** all of the box on the screen, and the element itself under its centre (not a panel or a box over it) */
const reach = loc => loc.first().evaluate((el, [vw, vh]) => {
  const b = el.getBoundingClientRect()
  const box = `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`
  if (!b.width || !b.height) return { ok: false, box: 'no size' }
  const inside = b.left >= -0.5 && b.top >= -0.5 && b.right <= vw + 0.5 && b.bottom <= vh + 0.5
  const hit = inside ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null
  return { ok: inside && !!hit && (hit === el || el.contains(hit)), box }
}, [VW, VH]).catch(() => ({ ok: false, box: 'not found' }))

/** taps it when it is reachable; otherwise clicks it from the page so the checks after it still run */
const press = async (loc, note) => {
  const r = await reach(loc)
  if (r.ok) await loc.first().tap()
  else await loc.first().evaluate(el => el.click()).catch(() => {})
  if (!r.ok) note.push(r.box)
  await loc.page().waitForTimeout(350)
  return r.ok
}

const run = async () => {
  const browser = await chromium.launch()
  try {
    for (const demo of DEMOS) {
      const result = await fetch(`${BASE}/demo_result/${demo}`).then(r => r.json())
      const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, isMobile: true, hasTouch: true })
      const page = await ctx.newPage()
      const shown = loc => loc.first().isVisible().catch(() => false)

      /** every part of the schematic inside the schematic's box and on the screen; the box at least 60% of the width */
      const partsInView = () => page.evaluate(([vw, vh]) => {
        const parts = [...document.querySelectorAll('g[data-comp]')]
        const svg = parts[0]?.closest('svg')
        if (!svg) return { ok: false, info: 'no schematic' }
        const s = svg.getBoundingClientRect()
        const sOk = s.left >= -0.5 && s.right <= vw + 0.5 && s.top >= -0.5 && s.bottom <= vh + 0.5 && s.width >= 0.6 * vw
        const out = parts.filter(g => {
          const b = g.getBoundingClientRect()
          return b.left < Math.max(s.left, 0) - 0.5 || b.top < Math.max(s.top, 0) - 0.5
            || b.right > Math.min(s.right, vw) + 0.5 || b.bottom > Math.min(s.bottom, vh) + 0.5
        }).map(g => g.getAttribute('data-comp'))
        return { ok: sOk && !out.length, info: `${parts.length} parts, schematic ${Math.round(s.left)}..${Math.round(s.right)} px`
          + (out.length ? `, off it: ${out.join(' ')}` : '') }
      }, [VW, VH])

      /** the first of these drawings that has a size: on the screen, at least half its width and 120 px high */
      const drawing = ids => page.evaluate(([ids, vw]) => {
        const el = ids.map(id => document.querySelector(`[data-testid=${id}]`)).find(e => e && e.getBoundingClientRect().width)
        if (!el) return { ok: false, box: 'no drawing' }
        const b = el.getBoundingClientRect()
        return { ok: b.left >= -0.5 && b.right <= vw + 0.5 && b.width >= 0.5 * vw && b.height >= 120,
          box: `${el.dataset.testid} ${Math.round(b.left)}..${Math.round(b.right)} × ${Math.round(b.height)} px` }
      }, [ids, VW])

      // M6: what of the result screen sticks out sideways, in each state visited
      const wide = []
      const overflow = async state => {
        const r = await page.evaluate(vw => {
          let root = document.querySelector('[data-testid=toggle-left-panel]')
          while (root && getComputedStyle(root).position !== 'fixed') root = root.parentElement
          if (!root) return { page: 0, out: ['no result screen'] }
          const out = []
          for (const el of root.querySelectorAll('*')) {
            if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue   // a drawing pans inside its box
            const b = el.getBoundingClientRect()
            if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue
            if (b.left >= -0.5 && b.right <= vw + 0.5) continue
            let p = el.parentElement, scrolls = false
            while (p && p !== root) {
              const pb = p.getBoundingClientRect()
              if (/auto|scroll/.test(getComputedStyle(p).overflowX) && pb.left >= -0.5 && pb.right <= vw + 0.5) { scrolls = true; break }
              p = p.parentElement
            }
            if (!scrolls) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? '#' + el.dataset.testid : ''}`
              + `${el.textContent ? ` "${el.textContent.trim().slice(0, 14)}"` : ''} ${Math.round(b.left)}..${Math.round(b.right)}`)
          }
          return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, out }
        }, VW)
        if (r.page > 0 || r.out.length) wide.push(`${state}: ${r.page > 0 ? `page ${r.page} px wider; ` : ''}${r.out.length} past the edge (${r.out.slice(0, 3).join(', ')})`)
      }

      await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: 'networkidle' })
      await page.locator('g[data-comp]').first().waitFor({ timeout: 15000 })
      await page.waitForTimeout(800)

      // M1
      const first = await partsInView()
      check(`M1 ${demo}: the schematic opens with every part on the screen`, first.ok, first.info)
      await overflow('opened')

      // M2
      const panelNote = [], panelBad = []
      for (const [side, close, inner] of [['left', 'AI 편집 패널 접기', 'chat-input'], ['right', '사양·BOM 패널 접기', 'BOM']]) {
        const panel = page.getByTestId(`${side}-panel`)
        // the AI editor's input box; the parts list's heading
        const content = side === 'left' ? panel.getByTestId(inner) : panel.getByText(inner, { exact: true })
        for (const name of [`toggle-${side}-panel`, `${side}-rail`]) {
          const opener = page.getByTestId(name)
          if (!await press(opener, panelNote)) panelBad.push(`${name} off the screen ${panelNote.at(-1)}`)
          if (!await shown(panel) || !(await reach(content)).ok) panelBad.push(`${name} did not open ${side}-panel on the screen`)
          await overflow(`${side}-panel open`)
          // closed from the panel itself after the rail, from the same toggle after the toggle
          const closer = name.endsWith('rail') ? panel.getByRole('button', { name: close, exact: true }) : opener
          if (!await press(closer, panelNote)) panelBad.push(`close of ${side}-panel off the screen ${panelNote.at(-1)}`)
          if (await shown(panel)) panelBad.push(`${side}-panel stayed open`)
        }
      }
      await page.waitForTimeout(500)
      const after = await partsInView()
      check(`M2 ${demo}: the panel toggles and rails open and close their panel on the screen`, !panelBad.length && after.ok,
        panelBad.length ? panelBad.join('; ') : `parts after: ${after.info}`)

      // M3
      const drawerBad = []
      const contents = {
        Netlist: page.locator('pre', { hasText: '(export' }),
        Guide: page.getByText(result.guide.trim().split('\n')[0].slice(0, 20), { exact: false }),
        BOM: page.getByTestId('bom-table'),
        Code: page.locator('.sf-code-pane'),
      }
      for (const [t, content] of Object.entries(contents)) {
        const tab = page.locator('.sf-drawer-tab', { hasText: t })
        if (!await press(tab, drawerBad)) drawerBad[drawerBad.length - 1] = `${t} tab off the screen ${drawerBad.at(-1)}`
        await content.first().waitFor({ timeout: 5000 }).catch(() => {})
        if (await tab.first().getAttribute('aria-pressed') !== 'true' || !await shown(content)) {
          // the netlist comes from the server's /download: a server that cannot send it says so in the same box
          const says = t === 'Netlist' ? (await page.locator('pre').first().textContent().catch(() => '') ?? '').trim().slice(0, 40) : ''
          drawerBad.push(`${t} did not open${says ? ` (it shows "${says}")` : ''}`)
        }
        await overflow(`${t} drawer`)
      }
      await press(page.locator('.sf-drawer-tab', { hasText: 'Code' }), [])   // the open tab again closes the drawer
      check(`M3 ${demo}: Netlist, Guide, BOM and Code open in the drawer`, !drawerBad.length, drawerBad.join('; '))

      // M4
      const pcbBad = []
      const make = page.getByRole('button', { name: /PCB 생성/ })
      if (!await press(make, pcbBad)) pcbBad[pcbBad.length - 1] = `PCB 생성 off the screen ${pcbBad.at(-1)}`
      const built = await page.getByRole('button', { name: /kicad_pcb/ }).waitFor({ timeout: 180000 }).then(() => true, () => false)
      if (!built) pcbBad.push('no board within 180 s')
      await page.waitForTimeout(1500)
      for (const [what, loc] of [['.kicad_pcb', page.getByRole('button', { name: /kicad_pcb/ })], ['거버', page.getByRole('button', { name: '거버', exact: true })]]) {
        const r = await reach(loc)
        if (!r.ok) pcbBad.push(`${what} off the screen ${r.box}`)
      }
      const board = await drawing(['board-view'])
      if (!board.ok) pcbBad.push(`board drawing ${board.box}`)
      await overflow('board made')
      // the checks list opens on the screen from its header and folds again, and the board is back (open, it sat in a
      // 300 px column beside the drawing, which was left 9 px wide)
      const head = page.getByTestId('board-checks').locator('button[aria-expanded]')
      if (!await press(head, pcbBad)) pcbBad[pcbBad.length - 1] = `checks header off the screen ${pcbBad.at(-1)}`
      const list = await reach(page.getByTestId('board-checks'))
      if (await head.first().getAttribute('aria-expanded') !== 'true' || !list.ok) pcbBad.push(`the checks list did not open on the screen ${list.box}`)
      await overflow('checks list open')
      await press(head, pcbBad)
      const folded = await drawing(['board-view'])
      if (!folded.ok) pcbBad.push(`board drawing after the list folded ${folded.box}`)
      check(`M4 ${demo}: PCB 생성 makes the board; the drawing, the downloads and the checks list are on the screen`, !pcbBad.length,
        pcbBad.length ? pcbBad.join('; ') : `${board.box}`)

      // M5
      const viewBad = []
      const views = [
        ['assembly', page.getByTestId('assembly-panel')],
        ['pcb', page.getByTestId('board-checks')],
        ['schematic', page.locator('g[data-comp]')],
      ]
      for (const [key, content] of views) {
        if (!await press(page.getByTestId(`view-tab-${key}`), viewBad)) viewBad[viewBad.length - 1] = `${key} tab off the screen ${viewBad.at(-1)}`
        await content.first().waitFor({ timeout: 5000 }).catch(() => {})
        if (!await shown(content)) viewBad.push(`${key} did not show`)
        // 배치하기's board (its 3D model, or the plan) beside its 300 px list was 19 px wide
        if (key === 'assembly') {
          await page.waitForTimeout(800)
          const asm = await drawing(['assembly-3d', 'board-view'])
          if (!asm.ok) viewBad.push(`배치하기 drawing ${asm.box}`)
        }
        await overflow(`${key} view`)
      }
      await page.waitForTimeout(500)
      const back = await partsInView()
      check(`M5 ${demo}: SCHEMATIC, PCB and 배치하기 switch the view`, !viewBad.length && back.ok, viewBad.length ? viewBad.join('; ') : `back on the schematic: ${back.info}`)

      // M6
      check(`M6 ${demo}: nothing sticks out past the right edge`, !wide.length, wide.length ? wide.join(' | ') : 'opened, 2 panels, 4 drawer tabs, board, 3 views')

      // M7: the panels as a wide window leaves them (open), and the result opened again from this browser's records
      const prompt = `휴대폰 폭 검사 ${demo}`
      await page.evaluate(([p, r]) => {
        localStorage.setItem('sf_saved_results', JSON.stringify([{ id: 1, name: p, prompt: p, result: r, time: Date.now() }]))
        localStorage.setItem('sf_panel_left', '1')
        localStorage.setItem('sf_panel_right', '1')
      }, [prompt, result])
      await page.goto(BASE, { waitUntil: 'networkidle' })
      const reopenBad = []
      await press(page.locator("button[aria-label='메뉴']"), reopenBad)
      await page.getByText(prompt).first().tap({ timeout: 5000 }).catch(e => reopenBad.push(`no saved entry (${e.message.split('\n')[0]})`))
      await page.locator('g[data-comp]').first().waitFor({ timeout: 15000 }).catch(() => reopenBad.push('the result did not open'))
      await page.waitForTimeout(800)
      if (await shown(page.getByTestId('left-panel'))) reopenBad.push('AI 편집 panel open')
      if (await shown(page.getByTestId('right-panel'))) reopenBad.push('사양·BOM panel open')
      const reopened = await partsInView()
      check(`M7 ${demo}: a saved result opens again with both panels closed and every part on the screen`, !reopenBad.length && reopened.ok,
        [...reopenBad, reopened.info].join('; '))
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
}

await run()
console.log(failed ? `${failed} FAIL` : 'ALL PASS')
process.exit(failed ? 1 : 0)
