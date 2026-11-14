"""
Stage-6 checks: the deploy image really can make and check boards.

Builds the Dockerfile, runs the container, and drives it over HTTP the way the
app does. Needs a running Docker engine.

Usage: python check_deploy.py [--port 8097] [--keep] [--no-build] [--dockerfile Dockerfile.jetson]
Exit code 0 only if every check passes.

  31 health reports KiCad 10 inside the container
  32 no secrets baked into the image (.env absent)
  33 board stream finishes with KiCad DRC available, 0 errors, 0 unrouted, and no footprint-library findings
     (kicad-cli without its library table warned on every footprint: 15 on the 555 demo, 2026-11-03)
  34 /generate_gerber gives the seven fabrication layers, plated and non-plated drill files and their zip
  35 image runs as the Dockerfile says (tsx from node_modules, python from venv)
  36 the 3D model has the part bodies (vendored models; the KiCad image has none)
  37 deployed-server guard: the demo is open, generation and the password-free sign-in are refused
  38 the demo netlists are built into the image (demo_cache/), so a demo opens without running skidl
  39 what skidl code starts is killed with it and reaped (tini as PID 1, no zombies)
  40 eight 3D model exports at once, twice, all succeed with the same size (each in a folder of its own)
  41 the footprint table is in the image where KICAD_CONFIG_HOME names it, not under /tmp or HOME (the container runs
     with an empty /tmp, so item 33 sees what Render saw: 9-15 footprint warnings per demo board, 2026-11-08)
  42 (Jetson image, run as jetson_run.sh runs it: every capability dropped) code run as the server's own user, with no key of its own, finds no key the server was given in any process's
     environ or command line and cannot open the server's memory (node and tini execute-only, so not dumpable); a
     control process of that user with a token in its environment is found, so the search does work (2026-11-13)
"""
import argparse, json, os, secrets, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ROOT = os.path.dirname(SERVER)
sys.path.insert(0, HERE)
from fab_export import FAB_SUFFIXES  # noqa: E402

IMAGE = 'schemaforge:stage6'
NAME = 'sf-deploy-check'
NET = os.path.join(SERVER, 'outputs', 'stage0_ne555.net')


def sh(*args, check=True, capture=True):
    r = subprocess.run(list(args), capture_output=capture, text=True, encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        raise RuntimeError(f'{" ".join(args)} failed:\n{r.stderr[-2000:]}')
    return r


def http_json(url, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:      # the API reports failures as JSON with a 4xx/5xx
        return json.loads(e.read().decode() or '{}')


def sse(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    events, name = [], None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode('utf-8').rstrip('\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: ') and name:
                events.append((name, json.loads(line[6:])))
                name = None
    return events


# Run inside the container: GLB node count of one board with the 3D models, and with the model folder hidden.
# Each placed part adds at least one node when its model is found, so the difference counts the bodies.
GLB_NODES = r'''
import json, os, struct, subprocess, sys
def nodes(env):
    out = '/tmp/sf_glb_check.glb'
    subprocess.run(['kicad-cli', 'pcb', 'export', 'glb', '--output', out, '--force', sys.argv[1]],
                   env={**os.environ, **env}, capture_output=True)
    b = open(out, 'rb').read()
    return len(json.loads(b[20:20 + struct.unpack('<I', b[12:16])[0]]).get('nodes', []))
print(nodes({}), nodes({'KICAD10_3DMODEL_DIR': '/nonexistent'}))
'''


def status(url, body=None):
    """HTTP status of a request (JSON body → POST)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8097)
    ap.add_argument('--keep', action='store_true', help='leave the container running')
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--dockerfile', default='Dockerfile', help='Dockerfile.jetson for the Jetson image (on an arm64 host)')
    args = ap.parse_args()
    results = []
    check = lambda name, ok, info='': results.append((name, bool(ok), info))

    if not args.no_build:
        t = time.time()
        sh('docker', 'build', '-f', os.path.join(ROOT, args.dockerfile), '-t', IMAGE, ROOT, capture=False)
        print(f'build {time.time() - t:.0f} s')
    size = sh('docker', 'image', 'inspect', IMAGE, '--format', '{{.Size}}').stdout.strip()

    sh('docker', 'rm', '-f', NAME, check=False)
    # with an empty /tmp, as a host may give it: nothing the server needs may live there (the footprint table did, and
    # Render's boards warned on every footprint, 2026-11-08). exec and 1 GB, so only emptiness differs from the image's
    # a key the server is given, as the deploy gives its keys (an environment variable): item 42 looks for it
    plant = f'sf-plant-{secrets.token_hex(8)}'
    # the Jetson image runs as scripts/jetson_run.sh starts it, with every capability dropped: item 42 depends on it (with
    # Docker's defaults the runtime starts tini able to read it, and tini stayed dumpable, 2026-11-13)
    jetson = 'jetson' in os.path.basename(args.dockerfile).lower()
    hardening = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'] if jetson else []
    sh('docker', 'run', '-d', '--name', NAME, '-p', f'{args.port}:8002', '--tmpfs', '/tmp:rw,exec,mode=1777,size=1g',
       *hardening, '-e', f'SF_DEPLOY_CHECK_SECRET={plant}', IMAGE)
    try:
        base = f'http://localhost:{args.port}'
        health = None
        for _ in range(60):
            try:
                health = http_json(f'{base}/health', timeout=5)
                if health.get('kicad') is not None:
                    break
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(1)
        kicad = (health or {}).get('kicad') or ''
        check('31 health reports KiCad 10', kicad.startswith('10.'), f'health={health}')

        env = sh('docker', 'exec', NAME, 'sh', '-c', 'ls -a /app/server | grep -c "^\\.env" || true').stdout.strip()
        check('32 no .env in image', env == '0', f'.env files found: {env}')

        sh('docker', 'cp', NET, f'{NAME}:/app/server/outputs/deploy_check.net')
        t = time.time()
        events = sse(f'{base}/generate_pcb_stream', {'filename': 'deploy_check.net', 'style': 'smd'})
        done = [d for k, d in events if k == 'done']
        drc = (done[-1].get('drc') if done else None) or {}
        summary = (done[-1].get('summary') if done else None) or {}
        # warnings too, for the footprint libraries: errors 0 passed while every footprint was "not in the current
        # configuration" (no fp-lib-table in the image), on the deployed site as well (2026-11-03)
        lib = [v.get('type') for v in drc.get('violations') or [] if str(v.get('type', '')).startswith('lib_footprint')]
        check('33 board + DRC in container',
              done and drc.get('available') and drc.get('errors') == 0 and drc.get('unconnected') == 0
              and not summary.get('unrouted') and not lib,
              f'{time.time() - t:.1f} s, drc={{available:{drc.get("available")}, errors:{drc.get("errors")}, '
              f'warnings:{drc.get("warnings")}, unconnected:{drc.get("unconnected")}}}, footprint library findings={len(lib)}, '
              f'unrouted={len(summary.get("unrouted") or [])}')

        g = http_json(f'{base}/generate_gerber', {'pcbFilename': done[-1]['pcbFilename']} if done else {})
        files = g.get('files') or []
        have = [s for s in FAB_SUFFIXES if any(f.endswith(s) for f in files)]
        zip_head = b''
        if g.get('zip'):
            with urllib.request.urlopen(f'{base}/download_gerber_file/{g["gerberDir"]}/{g["zip"]}', timeout=60) as r:
                zip_head = r.read()[:2]
        check('34 fab files + zip', len(have) == len(FAB_SUFFIXES) == len(files) and zip_head == b'PK',
              f'{len(files)} files, fab layers+drills {len(have)}/{len(FAB_SUFFIXES)}, zip {g.get("zip")} {zip_head!r}'
              + (f', error={g.get("error")}' if g.get('error') else ''))

        # skidl from /tmp, where runSkidl runs it: importing it writes skidl_REPL.log/.erc to the working folder, and the
        # image's non-root user cannot write in /app/server (Jetson image, 2026-11-03)
        which = sh('docker', 'exec', NAME, 'sh', '-c',
                   'command -v python; (cd /tmp && python -c "import skidl, numpy; print(\'ok\')"); ls node_modules/.bin/tsx'
                   ).stdout.split()
        check('35 runtime wiring', which[:1] == ['/venv/bin/python'] and 'ok' in which and 'node_modules/.bin/tsx' in which,
              ' '.join(which))

        parts = summary.get('components') or 0
        counts = sh('docker', 'exec', NAME, 'python', '-c', GLB_NODES,
                    f'/app/server/outputs/{done[-1]["pcbFilename"]}' if done else '/nonexistent', check=False).stdout.split()
        with_models, without = (int(counts[0]), int(counts[1])) if len(counts) == 2 else (0, 0)
        check('36 3D part bodies', parts > 0 and with_models - without >= parts,
              f'GLB nodes {with_models} with models, {without} without, {parts} parts')

        demo = http_json(f'{base}/demo_result/led')
        codes = {'demo': 200 if demo.get('filename') else 'no filename', 'generate': status(f'{base}/generate', {'description': 'LED'}),
                 'login': status(f'{base}/auth/login', {'email': 'a@b.c', 'password': 'x'})}
        check('37 deployed-server guard', codes == {'demo': 200, 'generate': 401, 'login': 503}, json.dumps(codes))

        cached = sh('docker', 'exec', NAME, 'sh', '-c', 'ls /app/server/demo_cache | wc -l', check=False).stdout.strip()
        t = time.time()
        motor = http_json(f'{base}/demo_result/motor')
        took = time.time() - t
        check('38 demo netlists in the image', cached == '14' and bool(motor.get('filename')) and took < 3,
              f'{cached} files in demo_cache (7 circuits x .net/.json), /demo_result/motor {took:.2f} s')

        # what skidl code starts goes with it, and nothing it leaves becomes a zombie (tini as PID 1); the children of a
        # timed-out run held the process slots of a --pids-limit container for good (review of 2026-11-03)
        tree = sh('docker', 'exec', NAME, './node_modules/.bin/tsx', 'check_skidl_tree.ts', check=False)
        init = sh('docker', 'exec', NAME, 'sh', '-c', 'cat /proc/1/comm', check=False).stdout.strip()
        check('39 skidl children killed and reaped', tree.returncode == 0 and init == 'tini',
              f'pid 1 {init}; {(tree.stdout or tree.stderr).strip()[-160:]}')

        # eight 3D exports at once, twice: kicad-cli writes fixed temp names beside its output, and in one shared folder
        # concurrent exports failed or came back cut short (8 at once: 2 failed, 1 cut short, review of 2026-11-03).
        # From eight visitors, as the proxy names them: one visitor runs 2 and waits 4 (server/job_slots.ts)
        if done:
            from concurrent.futures import ThreadPoolExecutor
            url = f'{base}/board_model?pcb={done[-1]["pcbFilename"]}'

            def get(i):
                try:
                    req = urllib.request.Request(url, headers={'X-Forwarded-For': f'198.51.100.{i + 1}'})
                    with urllib.request.urlopen(req, timeout=300) as r:
                        return r.status, len(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, 0
            got = []
            for _ in range(2):
                with ThreadPoolExecutor(8) as pool:
                    got += list(pool.map(get, range(8)))
            check('40 concurrent 3D exports', all(s == 200 for s, _ in got) and len({n for _, n in got}) == 1,
                  f'{got}')
        else:
            check('40 concurrent 3D exports', False, 'no board')

        # the footprint table where neither /tmp nor HOME decides it: written to $HOME/.config under /tmp, it was gone on
        # Render, and every demo board there warned 9-15 times (2026-11-08). Item 33 runs with an empty /tmp; this one
        # asks kicad-cli's own setting, with HOME pointed elsewhere as a host may
        where = sh('docker', 'exec', '-e', 'HOME=/nonexistent', NAME, 'sh', '-c',
                   'echo "${KICAD_CONFIG_HOME:-unset}"; test -s "$KICAD_CONFIG_HOME/10.0/fp-lib-table" && echo table',
                   check=False).stdout.split()
        home = where[0] if where else ''
        check('41 footprint table outside /tmp and HOME', home.startswith('/') and not home.startswith('/tmp')
              and where[1:] == ['table'], f'KICAD_CONFIG_HOME={home or "?"}, {"table found" if where[1:] == ["table"] else "no table"}')

        # code the Code tab runs is python as the server's own user, with the keys taken out of its environment
        # (skidl_run.ts childEnv). It read them back from /proc/1/environ (tini) and the server's own entry until node and
        # tini were made execute-only, which leaves those processes not dumpable (2026-11-13). The control: a process of
        # the same user with a token in its environment, which the same search has to find
        owner = sh('docker', 'exec', NAME, 'sh', '-c', 'for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = node ] '
                   '&& stat -c %u $d && break; done', check=False).stdout.strip()
        control = f'sf-control-{secrets.token_hex(8)}'
        # env -i: a docker exec process starts with the container's environment, the planted key with it
        sh('docker', 'exec', '-d', '-u', owner or '0', NAME, 'env', '-i', f'SF_CONTROL_TOKEN={control}', 'sleep', '60', check=False)
        time.sleep(1)
        probe = """
import json, os, sys
me = os.getpid(); found = []; servers = []; opened = []
for d in os.listdir('/proc'):
    if not d.isdigit() or int(d) == me: continue
    for f in ('environ', 'cmdline'):
        try: data = open(f'/proc/{d}/{f}', 'rb').read()
        except OSError: continue
        found += [f'{w}:{d}/{f}' for w in sys.argv[1:] if w.encode() in data]
    try: comm = open(f'/proc/{d}/comm').read().strip()
    except OSError: continue
    if comm in ('node', 'tini'):
        servers.append(comm)
        try: open(f'/proc/{d}/mem', 'rb').close(); opened.append(d)
        except OSError: pass
print(json.dumps({'found': found, 'servers': sorted(servers), 'mem_opened': opened}))
"""
        out = sh('docker', 'exec', '-u', owner or '0', NAME, 'env', '-i', 'PATH=/usr/bin:/bin', 'python3', '-c', probe,
                 plant, control, check=False).stdout.strip()
        try:
            seen = json.loads(out.splitlines()[-1])
        except (ValueError, IndexError):
            seen = {'found': ['probe did not run: ' + out[-200:]], 'servers': [], 'mem_opened': []}
        leaked = [f for f in seen['found'] if f.startswith(plant)]
        if not jetson:
            # Render starts its container as root with Docker's capabilities, where none of this holds: said, not passed
            print('note 42 not run: only the Jetson image runs with every capability dropped (Render serves the old address)')
        else:
          check('42 the keys the server holds are out of reach of code run as its user', bool(owner) and not leaked and not seen['mem_opened']
              and {'node', 'tini'} <= set(seen['servers']) and any(f.startswith(control) for f in seen['found']),
              f'user {owner or "?"}; key found in {leaked or "nothing"}; memory opened {seen["mem_opened"] or "none"}; '
              f'servers {seen["servers"]}; control found: {any(f.startswith(control) for f in seen["found"])}')
    finally:
        if not args.keep:
            sh('docker', 'rm', '-f', NAME, check=False)

    ok_all = True
    for name, ok, info in results:
        ok_all &= ok
        print(f'{"ok  " if ok else "FAIL"} {name}  {info}')
    print(f'image size {int(size) / 1e9:.2f} GB (uncompressed)')
    print('ALL PASS' if ok_all else 'SOME CHECKS FAILED')
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
