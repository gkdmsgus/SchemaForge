// Checks J0-J7 on scripts/jetson_run.sh, the Jetson's deploy, with stand-ins for docker, curl, git and sleep: no Docker,
// no Jetson. The stand-ins keep images as tags, containers as names, and give each image's /health from a file. J0 bash
// reads the script. J1 a new image that comes up runs, and the image that ran before is $IMAGE-prev. J2 a new image
// whose KiCad does not answer is replaced by the one before, and the run still ends with exit 1. J3 --no-build twice
// keeps the real image before as $IMAGE-prev. J4 --rollback runs $IMAGE-prev without a build. J5 a failed build leaves
// the running container alone. J6 IMAGE and NAME run a test image and container beside the real ones. J7 the image
// takes the commit after its last RUN. Before 2026-11-08 a build replaced the image under the same name and removed the
// running container first, so a new image that did not come up left the site down with nothing to go back to.
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
}

type State = { tags: [string, string][], containers: [string, string, string][], health: Record<string, string>,
  buildId?: string, buildFail?: boolean, envFile?: boolean }
type Result = { code: number | null, out: string, tags: Map<string, string>, containers: Map<string, string>, calls: string[] }

const ok = (id: string) => JSON.stringify({ status: 'ok', kicad: '10.0.8', id })
const broken = (id: string) => JSON.stringify({ status: 'ok', kicad: null, id })

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
    for (const [id, body] of Object.entries(state.health)) fs.writeFileSync(path.join(st, 'health', id), body)
    if (state.buildId) fs.writeFileSync(path.join(st, 'build_id'), state.buildId)
    if (state.buildFail) fs.writeFileSync(path.join(st, 'build_fail'), '')
    if (state.envFile) fs.writeFileSync(path.join(home, 'schemaforge.env'), 'ALLOWED_EMAILS=nobody@example.com\n')
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
    // the stand-ins first on PATH, set inside bash: Git's bash puts its own folders (with a real curl) in front
    const r = spawnSync(BASH, ['-c', 'if command -v cygpath >/dev/null; then s=$(cygpath -u "$SF_STUBS"); else s="$SF_STUBS"; fi; '
      + 'PATH="$s:$PATH" exec bash "$0" "$@"', slash(path.join(repo, 'scripts', 'jetson_run.sh')), ...args], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...base, PATH: process.env.PATH ?? process.env.Path ?? '', HOME: slash(home), SF_STUB: slash(st), SF_STUBS: slash(stubs), ...env },
    })
    const lines = (f: string) => fs.readFileSync(path.join(st, f), 'utf8').split('\n').filter(Boolean)
    return {
      code: r.error ? null : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`,
      tags: new Map(lines('tags').map(l => l.split(' ') as [string, string])),
      containers: new Map(lines('containers').map(l => l.split(' ').slice(0, 2) as [string, string])),
      calls: lines('calls'),
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
const said = (r: Result) => `exit ${r.code}, containers ${JSON.stringify([...r.containers])}, tags ${JSON.stringify([...r.tags])}`
  + ` · ${r.out.trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`
const at = (r: Result, re: RegExp) => r.calls.findIndex(c => re.test(c))

// J0
{
  const r = spawnSync(BASH, ['-n', '-c', lf(SCRIPT)], { encoding: 'utf8' })
  check('J0 bash reads the script', r.status === 0, r.stderr.trim() || BASH)
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
    r.code === 0 && r.containers.get('schemaforge') === 'new' && r.tags.get('schemaforge:jetson-prev') === 'old'
    && r.calls.some(c => /^docker build .*--build-arg SF_COMMIT=abc1234 /.test(c))
    && at(r, /^docker build /) >= 0 && at(r, /^docker build /) < at(r, /^docker rm /) && order,
    `${said(r)}${order ? '' : ' · PORT and NODE_ENV not after the env file'}`)
}

// J2
{
  const r = run({ ...live(), health: { old: ok('old'), new: broken('new') } })
  check('J2 a new image whose KiCad does not answer: the one before runs again, and the run ends with exit 1',
    r.code === 1 && r.containers.get('schemaforge') === 'old' && /rolled back/.test(r.out), said(r))
}

// J3
{
  const built: State = { ...live(), tags: [['schemaforge:jetson', 'new']] }
  const first = run(built, ['--no-build'])
  const again = run({ ...built, tags: [...first.tags], containers: [['schemaforge', 'new', '127.0.0.1:8002:8002']] }, ['--no-build'])
  check('J3 --no-build twice keeps the image before as schemaforge:jetson-prev, and builds nothing',
    first.code === 0 && again.code === 0 && again.tags.get('schemaforge:jetson-prev') === 'old'
    && ![...first.calls, ...again.calls].some(c => c.startsWith('docker build')), `${said(first)} | ${said(again)}`)
}

// J4
{
  const r = run({ ...live(), tags: [['schemaforge:jetson', 'new'], ['schemaforge:jetson-prev', 'old']],
    containers: [['schemaforge', 'new', '127.0.0.1:8002:8002']] }, ['--rollback'])
  check('J4 --rollback runs schemaforge:jetson-prev without a build', r.code === 0 && r.containers.get('schemaforge') === 'old'
    && !r.calls.some(c => c.startsWith('docker build')), said(r))
}

// J5
{
  const r = run({ ...live(), buildFail: true })
  check('J5 a failed build leaves the running container alone', r.code !== 0 && r.containers.get('schemaforge') === 'old'
    && !r.calls.some(c => /^docker (rm|run) /.test(c)), said(r))
}

// J6
{
  const r = run({ tags: [['schemaforge:jetson', 'old'], ['sf-test:jetson', 't1']],
    containers: [['schemaforge', 'old', '127.0.0.1:8002:8002'], ['sf-test', 't1', '127.0.0.1:8290:8002']],
    health: { old: ok('old'), t1: ok('t1'), t2: ok('t2') }, buildId: 't2' },
  [], { IMAGE: 'sf-test:jetson', NAME: 'sf-test', PUBLISH: '127.0.0.1:8290:8002' })
  check('J6 IMAGE and NAME run a test image and container beside the real ones',
    r.code === 0 && r.containers.get('sf-test') === 't2' && r.tags.get('sf-test:jetson-prev') === 't1'
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

console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
