// Checks L1-L7 that the privacy policy and the terms (src/components/LegalPage.tsx, drawn as the page draws them) say
// what the code does, with no browser. The policy of 2026-09-17 named OpenAI and Mouser and said "no other third party"
// while every page loads its fonts from Google, said the generated files stay in outputs while the deploy images delete
// them after a day, and asked for deletions by "the repository's issues" with no link (sweep of 2026-11-08).
// L1 every outside host the code sends to has its company in the policy: each https:// host in the server's and the
// screens' code, index.html and the style sheets (comments and checks aside; a host not in HOSTS below fails until the
// policy and HOSTS name it), and Supabase when the server uses it. L2 no python file of the pipeline opens a connection
// (so L1 need not read them). L3 the policy's sweep (every n minutes, n hours, n GB) is the server's defaults, and both
// deploy images turn the sweep on. L4 every Supabase table the server reads or writes is in the policy. L5 what the
// policy says can be deleted can be: the drawer's 전체 삭제, DELETE /sessions, and its chats and favourites going with
// it (ON DELETE CASCADE). L6 both pages link the repository's issues, and it is this repository. L7 the model company
// in both pages follows /health's provider (modelCompany): OpenAI and xAI by name, a host of the operator's own as the
// operator's model, an unknown host by its name, and before /health answers the server's default.
// Usage: npx tsx scripts/check_legal.ts   → exit 0 only if all pass
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import LegalPage from '../src/components/LegalPage.tsx'
import { modelCompany } from '../src/lib/modelName.ts'
import { modelProvider } from '../server/model.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])

/** a host the code names → the company the policy must name; null: nothing of the visitor's goes there */
const HOSTS: Record<string, string | null> = {
  'fonts.googleapis.com': 'Google', 'fonts.gstatic.com': 'Google',   // index.html, _sf-tokens.scss
  'api.openai.com': 'OpenAI',                                         // server/model.ts MODEL_BASE's default
  'api.mouser.com': 'Mouser', 'www.mouser.kr': 'Mouser',              // the price search, the BOM's search links
  'www.w3.org': null, 'localhost': null, '127.0.0.1': null,          // an SVG namespace, this machine
  'github.com': null,                                                 // the contact link, a page the visitor opens
}

/** the code without its comments: a comment may name a host nothing calls (model.ts names api.x.ai as an example) */
const uncommented = (f: string, text: string) => f.endsWith('.html')
  ? text.replace(/<!--[\s\S]*?-->/g, '')
  : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const html = (kind: 'terms' | 'privacy') => renderToStaticMarkup(createElement(LegalPage, { kind }))
const words = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
const privacyHtml = html('privacy'), termsHtml = html('terms')
const privacy = words(privacyHtml), terms = words(termsHtml)

// L1
const files = ['index.html', ...walk('src').filter(f => /\.(tsx?|s?css)$/.test(f)),
  ...fs.readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.ts') && !f.startsWith('check_')).map(f => `server/${f}`)]
const named = new Map<string, string>()   // host → the first file naming it
for (const f of files) {
  for (const m of uncommented(f, read(f)).matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)/gi)) {
    if (!named.has(m[1].toLowerCase())) named.set(m[1].toLowerCase(), f)
  }
}
const unknown = [...named].filter(([h]) => !(h in HOSTS)).map(([h, f]) => `${h} (${f})`)
const companies = new Map<string, string>()   // company → why
for (const [h, f] of named) if (HOSTS[h]) companies.set(HOSTS[h]!, `${h} in ${f}`)
if (/from '@supabase\/supabase-js'/.test(read('server/index.ts'))) companies.set('Supabase', 'server/index.ts uses @supabase/supabase-js')
const unsaid = [...companies].filter(([c]) => !privacy.includes(c)).map(([c, why]) => `${c} (${why})`)
check('L1 every outside host the code sends to has its company in the privacy policy', !unknown.length && !unsaid.length && companies.size >= 4,
  unknown.length || unsaid.length
    ? [unknown.length ? `not in HOSTS (say it in the policy, then add it): ${unknown.join(', ')}` : '', unsaid.length ? `not in the policy: ${unsaid.join(', ')}` : ''].filter(Boolean).join(' · ')
    : [...companies.keys()].join(', '))

// L2
const pyFiles = ['server/pcb', 'server'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.py')).map(f => `${d}/${f}`))
const pyNet = pyFiles.filter(f => /^\s*(import|from)\s+(requests|urllib|http\.client|httpx|aiohttp|socket)\b/m.test(read(f)))
check('L2 no python file of the pipeline opens a connection', pyFiles.length > 5 && !pyNet.length, pyNet.join(', ') || `${pyFiles.length} files`)

// L3
const index = read('server/index.ts')
const hours = /SF_OUTPUTS_KEEP_HOURS\)\s*\|\|\s*(\d+)/.exec(index)?.[1]
const mb = Number(/SF_OUTPUTS_MAX_MB\)\s*\|\|\s*(\d+)/.exec(index)?.[1])
const every = /setInterval\(sweep,\s*(\d+)\s*\*\s*60_000\)/.exec(index)?.[1]
const size = mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`
const images = ['Dockerfile', 'Dockerfile.jetson'].filter(f => /SF_OUTPUTS_SWEEP=1\b/.test(read(f)))
check(`L3 the policy's sweep is the server's: every ${every} minutes, ${hours} hours, ${size}, in both deploy images`,
  !!hours && !!mb && !!every && privacy.includes(`${every}분마다`) && privacy.includes(`${hours}시간`) && privacy.includes(size) && images.length === 2,
  JSON.stringify({ every: privacy.includes(`${every}분마다`), hours: privacy.includes(`${hours}시간`), size: privacy.includes(size), images }))

// L4
const tables = new Set(fs.readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.ts') && !f.startsWith('check_'))
  .flatMap(f => [...read(`server/${f}`).matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1])))
const missingTables = [...tables].filter(t => !privacy.includes(t))
check('L4 every Supabase table the server uses is in the policy', tables.size >= 3 && !missingTables.length,
  missingTables.length ? `not in the policy: ${missingTables.join(', ')}` : [...tables].join(', '))

// L5
const drawer = read('src/components/SideDrawer.tsx'), schema = read('server/schema.sql')
const cascade = (table: string) => new RegExp(`CREATE TABLE[^;]*\\b${table}\\b[^;]*REFERENCES public\\.sessions\\(id\\) ON DELETE CASCADE`, 'i').test(schema)
const deletable = {
  says: privacy.includes('전체 삭제'),
  button: />전체 삭제</.test(drawer) && /deleteAllSessions\(\)/.test(drawer),
  route: /app\.delete\('\/sessions',/.test(index),
  chats: cascade('chat_messages'), favourites: cascade('favorites'),
}
check('L5 the drawer\'s 전체 삭제 the policy names exists, and a session\'s chats and favourites go with it', Object.values(deletable).every(Boolean), JSON.stringify(deletable))

// L6
let origin = ''
try { origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim().replace(/\.git$/, '') } catch { /* no git: the link alone is read */ }
const issues = (h: string) => [...h.matchAll(/<a href="(https:\/\/github\.com\/[^"]+\/issues)"/g)].map(m => m[1])
const links = { privacy: issues(privacyHtml), terms: issues(termsHtml) }
check('L6 the policy and the terms link the repository\'s issues', links.privacy.length >= 1 && links.terms.length >= 1
  && [...links.privacy, ...links.terms].every(l => !origin || l === `${origin}/issues`), JSON.stringify({ ...links, origin }))

// L7
const DEFAULT_BASE = /OPENAI_BASE_URL \|\| '([^']+)'/.exec(read('server/model.ts'))?.[1] ?? ''
const byDefault = modelProvider(DEFAULT_BASE)
const cases: [string, (s: string) => boolean][] = [
  ['OpenAI', s => s.includes('OpenAI')], ['xAI', s => s.includes('xAI')],
  ['127.0.0.1', s => s.includes('운영자') && !s.includes('127.')], ['localhost', s => s.includes('운영자')],
  ['192.168.0.12', s => s.includes('운영자')], ['ollama', s => s.includes('운영자')],
  ['api.groq.com', s => s.includes('api.groq.com')], ['AI', s => s.includes(byDefault)],
]
const wrong = cases.filter(([p, ok]) => !ok(modelCompany(p))).map(([p]) => `${p} → ${modelCompany(p)}`)
const shown = modelCompany('AI')
check('L7 the model company follows /health\'s provider, and both pages say it', byDefault === 'OpenAI' && !wrong.length && privacy.includes(shown) && terms.includes(shown),
  wrong.length ? wrong.join(' · ') : `before /health answers: ${shown}`)

console.log(failed ? `\n${failed} FAILED` : '\nall policy checks passed')
process.exitCode = failed ? 1 : 0
