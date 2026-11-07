// Checks J0-J9 on scripts/jetson_run.sh, the Jetson's deploy, with stand-ins for docker, curl, git and sleep: no Docker,
// no Jetson. The stand-ins keep images as tags, containers as names, and give each image's /health from a file. Nothing
// real runs: PATH holds the stand-in folder only (beside them, wrappers for a few text tools), and a command with no
// stand-in fails the run instead of running. J0 bash reads the script, and it names no command by its full path and sets
// no PATH. J1 a new image that comes up runs, and the image that ran before is $IMAGE-prev. J2 a new image
// whose KiCad does not answer is replaced by the one before, and the run still ends with exit 1. J3 --no-build twice
// keeps the real image before as $IMAGE-prev. J4 --rollback runs $IMAGE-prev without a build. J5 a failed build leaves
// the running container alone. J6 IMAGE and NAME run a test image and container beside the real ones. J7 the image
// takes the commit after its last RUN. J8 a new image with another KiCad than Dockerfile.jetson's KICAD_EXPECT counts
// as not up. J9 Dockerfile.jetson, read as text, stops the build when kicad-cli is not KICAD_EXPECT: the PPA has no
// version pin, and the Render image is 10.0.5 while the Jetson's came out 10.0.8 (vault note on the move). Before
// 2026-11-08 a build replaced the image under the same name and removed the running container first, so a new image
// that did not come up left the site down with nothing to go back to.
// Usage: npx tsx scripts/check_jetson_run.ts [script]   → exit 0 only if all pass (script: another jetson_run.sh to check)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.resolve(process.argv[2] ?? path.join(ROOT, 'scripts', 'jetson_run.sh'))
let failed = 0
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`)
}
const lf = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const slash = (p: string) => p.replace(/\\/g, '/')

// Git's bash on Windows: the bash on PATH there can be WSL's, another machine with other paths
const BASH = process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
  : 'bash'

const STUBS: Record<string, string> = {
  // tags: "ref id" lines; images: every image id, tagged or not (a build moves a tag, the image it left stays);
  // containers: "name id publish" lines; every call is logged
  docker: `#!/usr/bin/env bash
S="$SF_STUB"; echo "docker $*" >> "$S/calls"
resolve() { awk -v r="$1" '$1 == r { id = $2 } END { if (id == "") exit 1; print id }' "$S/tags" || { grep -qx "$1" "$S/images" && echo "$1"; }; }
settag() { awk -v r="$1" '$1 != r' "$S/tags" > "$S/t"; echo "$1 $2" >> "$S/t"; mv "$S/t" "$S/tags"; echo "$2" >> "$S/images"; }
drop() { awk -v n="$1" '$1 != n' "$S/containers" > "$S/c"; mv "$S/c" "$S/containers"; }
last="\${!#}"
case "$1" in
  build) [ -f "$S/build_fail" ] && { echo "stub build failed" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = -t ] && t="$2"; shift; done; settag "$t" "$(cat "$S/build_id")" ;;
  image) resolve "$last" ;;
  container|inspect) awk -v n="$last" '$1 == n { print $2; f = 1 } END { exit !f }' "$S/containers" ;;
  tag) id=$(resolve "$2") || exit 1; settag "$3" "$id" ;;
  rm) drop "$last" ;;
  run) while [ $# -gt 1 ]; do case "$1" in --name) n="$2" ;; -p) p="$2" ;; esac; shift; done
    id=$(resolve "$last") || { echo "stub: no image $last" >&2; exit 1; }; drop "$n"; echo "$n $id $p" >> "$S/containers" ;;
  logs) echo "(stub logs)" ;;
  *) echo "stub docker: $1?" >&2; exit 1 ;;
esac
`,
  // the container published where the URL points answers with its image's health file
  curl: `#!/usr/bin/env bash
S="$SF_STUB"; echo "curl $*" >> "$S/calls"
at=$(echo "\${!#}" | sed -E 's#^https?://([^/]+)/.*#\\1#')
while read -r _ id p; do
  key=$(echo "$p" | awk -F: '{ print (NF == 3 ? $1 : "localhost") ":" $(NF-1) }')
  if [ "$key" = "$at" ] && [ -f "$S/health/$id" ]; then cat "$S/health/$id"; exit 0; fi
done < "$S/containers"
exit 7
`,
  git: `#!/usr/bin/env bash
echo "git $*" >> "$SF_STUB/calls"; echo abc1234
`,
  sleep: '#!/usr/bin/env bash\n',
  // three tries instead of 60: each one is a few processes, slow on Windows when the PC is busy
  seq: '#!/usr/bin/env bash\necho 1 2 3\n',
  // the deploy builds in Docker only: these only write the call down, and the run fails
  ...Object.fromEntries(['npm', 'npx', 'node', 'python', 'python3', 'pip', 'sudo', 'systemctl'].map(c =>
    [c, `#!/usr/bin/env bash\necho "${c} $*" >> "$SF_STUB/stray"; exit 1\n`])),
}
// the real tools the script and the stand-ins may use, each a two-line script in the stand-in folder that runs it by its
// full path. Nothing else can run: PATH holds the stand-in folder only, and bash writes any other command to "stray"
// (command_not_found_handle) instead. On 2026-11-08 J9 ran the first RUN of Dockerfile.jetson (npm ci) with this PC's
// PATH, in the worktree, and emptied the node_modules the worktrees share
const TOOLS = ['awk', 'cat', 'dirname', 'grep', 'mv', 'sed', 'tr']

type State = { tags: [string, string][], containers: [string, string, string][], health: Record<string, string>,
  buildId?: string, buildFail?: boolean, envFile?: boolean }
type Result = { code: number | null, out: string, tags: Map<string, string>, containers: Map<string, string>, calls: string[],
  stray: string[] }

const ok = (id: string, kicad: string | null = '10.0.8') => JSON.stringify({ status: 'ok', kicad, id })
const broken = (id: string) => ok(id, null)

/** bash with PATH set to the stand-in folder `stubs` and nothing else, set inside bash: Git's bash puts its own folders
 * (a real curl) in front of any PATH it is given. Before that, the stand-ins get this bash's full path as their first line
 * (with no other folder on PATH, /usr/bin/env finds no bash), and the tools their wrappers */
const inBash = (stubs: string, args: string[], env: Record<string, string>) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|bash_env|env)$/i.test(k) && !/^BASH_FUNC_/.test(k)))
  return spawnSync(BASH, ['-c', `set -e
if command -v cygpath >/dev/null; then s=$(cygpath -u "$SF_STUBS"); else s="$SF_STUBS"; fi
[ -n "$s" ] && [ -d "$s" ] && [ -n "$SF_STUB" ] || { echo "no stand-in folder" >&2; exit 3; }
b=$(type -P bash)
sed -i "1s|^#!.*|#!$b|" "$s"/*
for t in ${TOOLS.join(' ')}; do p=$(type -P "$t"); printf '#!%s\\nexec %q "$@"\\n' "$b" "$p" > "$s/$t"; chmod +x "$s/$t"; done
command_not_found_handle() { echo "$*" >> "$SF_STUB/stray"; echo "check_jetson_run: no stand-in for $1" >&2; return 127; }
export -f command_not_found_handle
PATH="$s" exec "$b" "$@"`, 'bash', ...args], {
    encoding: 'utf8', timeout: 120_000, env: { ...base, PATH: process.env.PATH ?? process.env.Path ?? '', SF_STUBS: slash(stubs), ...env },
  })
}

const run = (state: State, args: string[] = [], env: Record<string, string> = {}): Result => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-jetson-run-'))
  try {
    const repo = path.join(tmp, 'repo'), stubs = path.join(tmp, 'stubs'), st = path.join(tmp, 'state'), home = path.join(tmp, 'home')
    for (const d of [path.join(repo, 'scripts'), stubs, path.join(st, 'health'), home]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(repo, 'scripts', 'jetson_run.sh'), lf(SCRIPT))
    fs.writeFileSync(path.join(repo, 'Dockerfile.jetson'), lf(path.join(ROOT, 'Dockerfile.jetson')))
    for (const [name, text] of Object.entries(STUBS)) fs.writeFileSync(path.join(stubs, name), text, { mode: 0o755 })
    fs.writeFileSync(path.join(st, 'tags'), state.tags.map(t => t.join(' ') + '\n').join(''))
    fs.writeFileSync(path.join(st, 'containers'), state.containers.map(c => c.join(' ') + '\n').join(''))
    fs.writeFileSync(path.join(st, 'images'), [...state.tags, ...state.containers].map(t => t[1] + '\n').join(''))
    fs.writeFileSync(path.join(st, 'calls'), '')
    fs.writeFileSync(path.join(st, 'stray'), '')
    for (const [id, body] of Object.entries(state.health)) fs.writeFileSync(path.join(st, 'health', id), body)
    if (state.buildId) fs.writeFileSync(path.join(st, 'build_id'), state.buildId)
    if (state.buildFail) fs.writeFileSync(path.join(st, 'build_fail'), '')
    if (state.envFile) fs.writeFileSync(path.join(home, 'schemaforge.env'), 'ALLOWED_EMAILS=nobody@example.com\n')
    const r = inBash(stubs, [slash(path.join(repo, 'scripts', 'jetson_run.sh')), ...args], { HOME: slash(home), SF_STUB: slash(st), ...env })
    const lines = (f: string) => fs.readFileSync(path.join(st, f), 'utf8').split('\n').filter(Boolean)
    return {
      code: r.error ? null : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`,
      tags: new Map(lines('tags').map(l => l.split(' ') as [string, string])),
      containers: new Map(lines('containers').map(l => l.split(' ').slice(0, 2) as [string, string])),
      calls: lines('calls'), stray: lines('stray'),
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
/** the run called nothing but the stand-ins and the tools */
const ran = (r: Result) => r.stray.length === 0
const said = (r: Result) => `exit ${r.code}, containers ${JSON.stringify([...r.containers])}, tags ${JSON.stringify([...r.tags])}`
  + `${ran(r) ? '' : `, called without a stand-in: ${JSON.stringify(r.stray)}`}`
  + ` · ${r.out.trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`
const at = (r: Result, re: RegExp) => r.calls.findIndex(c => re.test(c))

// J0: -n reads without running. A command by its full path, or a PATH of the script's own, would get past the stand-ins
{
  const r = spawnSync(BASH, ['-n', '-c', lf(SCRIPT)], { encoding: 'utf8' })
  const code = lf(SCRIPT).split('\n').map((l, i) => [i + 1, l] as const).filter(([n, l]) => n > 1 && !/^\s*#/.test(l))
  const past = code.filter(([, l]) => /(^|[\s;&|(`])(\/(?!dev\/null\b)[A-Za-z]|[A-Za-z]:[\\/])|\bPATH\+?=|\bcommand\s+-p\b/.test(l))
  check('J0 bash reads the script, and it runs no command by a full path or a PATH of its own', r.status === 0 && !past.length,
    `${r.stderr.trim() || BASH}${past.length ? ` · line ${past.map(([n, l]) => `${n}: ${l.trim().slice(0, 60)}`).join(' | ')}` : ''}`)
}

// the Jetson now: the image "old" runs; a build makes "new"
const live = (): State => ({
  tags: [['schemaforge:jetson', 'old']], containers: [['schemaforge', 'old', '127.0.0.1:8002:8002']],
  health: { old: ok('old'), new: ok('new') }, buildId: 'new',
})

// J1
{
  const r = run({ ...live(), envFile: true })
  const runCall = r.calls.find(c => c.startsWith('docker run')) ?? ''
  const order = /--env-file \S+ -e PORT=8002 -e NODE_ENV=production /.test(runCall)
  check('J1 a new image that comes up runs, and the one before is schemaforge:jetson-prev',
    ran(r) && r.code === 0 && r.containers.get('schemaforge') === 'new' && r.tags.get('schemaforge:jetson-prev') === 'old'
    && r.calls.some(c => /^docker build .*--build-arg SF_COMMIT=abc1234 /.test(c))
    && at(r, /^docker build /) >= 0 && at(r, /^docker build /) < at(r, /^docker rm /) && order,
    `${said(r)}${order ? '' : ' · PORT and NODE_ENV not after the env file'}`)
}

// J2
{
  const r = run({ ...live(), health: { old: ok('old'), new: broken('new') } })
  check('J2 a new image whose KiCad does not answer: the one before runs again, and the run ends with exit 1',
    ran(r) && r.code === 1 && r.containers.get('schemaforge') === 'old' && /rolled back/.test(r.out), said(r))
}

// J3
{
  const built: State = { ...live(), tags: [['schemaforge:jetson', 'new']] }
  const first = run(built, ['--no-build'])
  const again = run({ ...built, tags: [...first.tags], containers: [['schemaforge', 'new', '127.0.0.1:8002:8002']] }, ['--no-build'])
  check('J3 --no-build twice keeps the image before as schemaforge:jetson-prev, and builds nothing',
    ran(first) && ran(again) && first.code === 0 && again.code === 0 && again.tags.get('schemaforge:jetson-prev') === 'old'
    && ![...first.calls, ...again.calls].some(c => c.startsWith('docker build')), `${said(first)} | ${said(again)}`)
}

// J4
{
  const r = run({ ...live(), tags: [['schemaforge:jetson', 'new'], ['schemaforge:jetson-prev', 'old']],
    containers: [['schemaforge', 'new', '127.0.0.1:8002:8002']] }, ['--rollback'])
  check('J4 --rollback runs schemaforge:jetson-prev without a build', ran(r) && r.code === 0 && r.containers.get('schemaforge') === 'old'
    && !r.calls.some(c => c.startsWith('docker build')), said(r))
}

// J5
{
  const r = run({ ...live(), buildFail: true })
  check('J5 a failed build leaves the running container alone', ran(r) && r.code !== 0 && r.containers.get('schemaforge') === 'old'
    && !r.calls.some(c => /^docker (rm|run) /.test(c)), said(r))
}

// J6
{
  const r = run({ tags: [['schemaforge:jetson', 'old'], ['sf-test:jetson', 't1']],
    containers: [['schemaforge', 'old', '127.0.0.1:8002:8002'], ['sf-test', 't1', '127.0.0.1:8290:8002']],
    health: { old: ok('old'), t1: ok('t1'), t2: ok('t2') }, buildId: 't2' },
  [], { IMAGE: 'sf-test:jetson', NAME: 'sf-test', PUBLISH: '127.0.0.1:8290:8002' })
  check('J6 IMAGE and NAME run a test image and container beside the real ones',
    ran(r) && r.code === 0 && r.containers.get('sf-test') === 't2' && r.tags.get('sf-test:jetson-prev') === 't1'
    && r.containers.get('schemaforge') === 'old' && r.tags.get('schemaforge:jetson') === 'old', said(r))
}

// J7: ARG and ENV after the last RUN, so a new commit rebuilds nothing above them
{
  const lines = lf(path.join(ROOT, 'Dockerfile.jetson')).split('\n')
  const lastRun = lines.findLastIndex(l => /^RUN /.test(l))
  const arg = lines.findIndex(l => /^ARG SF_COMMIT(=|$)/.test(l)), env = lines.findIndex(l => /^ENV SF_COMMIT=\$SF_COMMIT$/.test(l))
  check('J7 Dockerfile.jetson takes the commit (ARG and ENV SF_COMMIT) after its last RUN', arg > lastRun && env > arg,
    `last RUN line ${lastRun + 1}, ARG ${arg + 1}, ENV ${env + 1}`)
}

// J8
{
  const r = run({ ...live(), health: { old: ok('old'), new: ok('new', '10.0.9') } })
  check('J8 a new image with another KiCad than KICAD_EXPECT is replaced by the one before',
    ran(r) && r.code === 1 && r.containers.get('schemaforge') === 'old' && /rolled back/.test(r.out), said(r))
}

// J9: read as text only, nothing from the image build runs here. The instruction right after ARG KICAD_EXPECT is a RUN
// that keeps kicad-cli's answer, compares it with $KICAD_EXPECT and ends the build with exit 1 when they differ
{
  const lines = lf(path.join(ROOT, 'Dockerfile.jetson')).split('\n')
  const arg = lines.findIndex(l => /^ARG KICAD_EXPECT=\S+$/.test(l))
  const apt = lines.findIndex(l => /apt-get install .*\bkicad\b/.test(l))
  let at = arg < 0 ? -1 : lines.findIndex((l, i) => i > arg && l.trim() !== '' && !l.startsWith('#')), cmd = ''
  while (at >= 0 && at < lines.length) { cmd += lines[at].replace(/\\$/, ' '); if (!lines[at].endsWith('\\')) break; at++ }
  const expect = arg >= 0 ? lines[arg].split('=')[1] : ''
  // the echo between the braces has braces of its own (${v:-missing}), so the block is read to the end of the RUN
  const stops = /^RUN\s+(\w+)="\$\(kicad-cli version\)"\s*;\s*\[ "\$\1" = "\$KICAD_EXPECT" \]\s*\|\|\s*\{.*\bexit 1;?\s*\}\s*$/.test(cmd)
  check('J9 Dockerfile.jetson stops the build when kicad-cli is not KICAD_EXPECT (10.0.8, the version the image has now)',
    expect === '10.0.8' && apt >= 0 && arg > apt && stops,
    `ARG ${expect || 'missing'} at line ${arg + 1}, apt line ${apt + 1}, the RUN after it ${stops ? 'stops on another version' : `does not stop: ${cmd.slice(0, 120) || 'none'}`}`)
}

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
