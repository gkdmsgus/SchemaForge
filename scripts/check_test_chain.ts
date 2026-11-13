// Checks T1-T4 on npm test itself (package.json "test"), with no browser and no server. T1 every check file in scripts/,
// server/ and server/pcb/ is a step of the chain or is named below as staying out, with the reason. check_operating,
// check_board_checks and check_circuit_validation stood beside the chain, so their checks did not run when the code they
// guard changed (sweep of 2026-11-07). T2 the checks that read the check boards in server/outputs run after
// make_check_boards, which makes those boards on a fresh clone. T3 npm run test:browser (scripts/run_browser_checks.ts)
// runs every check that stays out for a browser, check_3d's viewer items too, and not check_live: the browser checks were
// run one by one by hand, each "with npm run dev on". T4 CLAUDE.md and AGENTS.md, the same guide for two
// kinds of agent, say the same, so an edit to one alone fails here instead of leaving the other with the old rule.
// Usage: npx tsx scripts/check_test_chain.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'
import { browserChecks } from './run_browser_checks'

const ROOT = path.resolve(import.meta.dirname, '..')
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}

/** npm test is every check that runs without a model; these need something more */
const BROWSER = 'a browser on a running app: npm run test:browser starts one and runs it (README)'
const OUT: Record<string, string> = {
  'scripts/check_auth_dialog.mjs': BROWSER,
  'scripts/check_board_panel.mjs': BROWSER,
  'scripts/check_drawer.mjs': BROWSER,
  'scripts/check_live.mjs': 'a browser on the deployed app (README), so npm run test:browser leaves it out',
  'scripts/check_pcb_sketch.mjs': BROWSER,
  'scripts/check_phone_width.mjs': `${BROWSER}, with KiCad: it makes a board of each demo on a phone-sized screen`,
  'scripts/check_plan_flow.mjs': BROWSER,
  'scripts/check_saved_offer.mjs': BROWSER,
  'scripts/check_schematic_overlap.mjs': BROWSER,
  'scripts/check_schematic_wiring.mjs': BROWSER,
  'scripts/check_settings.mjs': BROWSER,
  'scripts/check_versions.mjs': BROWSER,
  'server/check_skidl_tree.ts': 'Linux /proc inside the deploy image (check_deploy.py runs it there)',
  'server/pcb/check_deploy.py': 'Docker: it builds and runs the deploy image',
}
const BOARD_READERS = ['scripts/check_bom.ts', 'scripts/check_human_review.ts', 'scripts/check_fixes.ts',
  'scripts/check_operating.ts', 'scripts/check_measure_plan.ts', 'scripts/check_board_checks.ts', 'scripts/check_3d.ts']

// the chain's steps as paths from the root: "cd server && npx tsx check_x.ts" runs server/check_x.ts
const scripts = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
const chain = scripts.test
const steps: string[] = []
let dir = ''
for (const step of chain.split('&&').map(s => s.trim())) {
  const cd = /^cd (\S+)$/.exec(step)
  if (cd) { dir = path.posix.normalize(path.posix.join(dir, cd[1])).replace(/^\.$/, ''); continue }
  const file = step.split(/\s+/).find(w => /\.(ts|mts|mjs|js|py)$/.test(w))
  if (file) steps.push(path.posix.join(dir, file))
}

// T1
const files = ['scripts', 'server', 'server/pcb'].flatMap(d => fs.readdirSync(path.join(ROOT, d))
  .filter(f => /^check_.*\.(ts|mts|mjs|js|py)$/.test(f)).map(f => `${d}/${f}`))
const missing = files.filter(f => !steps.includes(f) && !(f in OUT))
const both = files.filter(f => steps.includes(f) && f in OUT)
const gone = [...steps, ...Object.keys(OUT)].filter(f => !fs.existsSync(path.join(ROOT, f)))
check('T1 every check is in npm test or named as staying out', !missing.length && !both.length && !gone.length,
  `${steps.length} steps, ${Object.keys(OUT).length} out` + (missing.length ? ` · in neither: ${missing.join(', ')}` : '')
  + (both.length ? ` · in both: ${both.join(', ')}` : '') + (gone.length ? ` · no such file: ${gone.join(', ')}` : ''))

// T2
const made = steps.indexOf('scripts/make_check_boards.ts')
const early = BOARD_READERS.filter(f => !(steps.indexOf(f) > made))
check('T2 the checks that read the check boards run after make_check_boards', made >= 0 && !early.length,
  made < 0 ? 'make_check_boards is not in the chain' : early.length ? `before it or missing: ${early.join(', ')}` : `${BOARD_READERS.length} readers`)

// T3
const runs = browserChecks(ROOT).map(c => c.file)
// a reason may say more after BROWSER (what else the check needs): it is still a browser check
const forBrowser = Object.keys(OUT).filter(f => OUT[f].startsWith(BROWSER))
const notRun = forBrowser.filter(f => !runs.includes(f))
const notForBrowser = runs.filter(f => f !== 'scripts/check_3d.ts' && !OUT[f]?.startsWith(BROWSER))
const npmRuns = /\bscripts\/run_browser_checks\.ts\b/.test(scripts['test:browser'] ?? '')
check('T3 npm run test:browser runs every browser check, check_3d with BASE, not check_live',
  npmRuns && !notRun.length && !notForBrowser.length && runs.includes('scripts/check_3d.ts'),
  `${runs.length} checks` + (npmRuns ? '' : ` · test:browser is ${JSON.stringify(scripts['test:browser'] ?? null)}`)
  + (notRun.length ? ` · out for a browser but not run: ${notRun.join(', ')}` : '')
  + (notForBrowser.length ? ` · run but not out for a browser: ${notForBrowser.join(', ')}` : '')
  + (runs.includes('scripts/check_3d.ts') ? '' : ' · check_3d is not run with BASE'))

// T4: one guide read by two kinds of agent. Line ends aside (a Windows checkout has CRLF), the two files are the same
{
  const read = (f: string) => fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') : null
  const [claude, agents] = [read('CLAUDE.md'), read('AGENTS.md')]
  const a = (claude ?? '').split('\n'), b = (agents ?? '').split('\n')
  const at = a.findIndex((l, i) => l !== b[i])
  const first = at >= 0 ? at : a.length !== b.length ? Math.min(a.length, b.length) : -1
  check('T4 CLAUDE.md and AGENTS.md are the same', claude !== null && agents !== null && claude === agents,
    claude === null || agents === null ? `missing: ${[claude === null && 'CLAUDE.md', agents === null && 'AGENTS.md'].filter(Boolean).join(', ')}`
      : first >= 0 ? `first difference on line ${first + 1}` : `${a.length} lines`)
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
