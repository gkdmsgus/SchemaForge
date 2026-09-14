"""
Stage-6 checks: the deploy image really can make and check boards.

Builds the Dockerfile, runs the container, and drives it over HTTP the way the
app does. Needs a running Docker engine.

Usage: python check_deploy.py [--port 8097] [--keep] [--no-build]
Exit code 0 only if every check passes.

  31 health reports KiCad 10 inside the container
  32 no secrets baked into the image (.env absent)
  33 board stream finishes with KiCad DRC available, 0 errors, 0 unrouted
  34 gerbers + drill files come out of /generate_gerber
  35 image runs as the Dockerfile says (tsx from node_modules, python from venv)
"""
import argparse, json, os, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
ROOT = os.path.dirname(SERVER)
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8097)
    ap.add_argument('--keep', action='store_true', help='leave the container running')
    ap.add_argument('--no-build', action='store_true')
    args = ap.parse_args()
    results = []
    check = lambda name, ok, info='': results.append((name, bool(ok), info))

    if not args.no_build:
        t = time.time()
        sh('docker', 'build', '-t', IMAGE, ROOT, capture=False)
        print(f'build {time.time() - t:.0f} s')
    size = sh('docker', 'image', 'inspect', IMAGE, '--format', '{{.Size}}').stdout.strip()

    sh('docker', 'rm', '-f', NAME, check=False)
    sh('docker', 'run', '-d', '--name', NAME, '-p', f'{args.port}:8002', IMAGE)
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
        check('33 board + DRC in container',
              done and drc.get('available') and drc.get('errors') == 0 and drc.get('unconnected') == 0
              and not summary.get('unrouted'),
              f'{time.time() - t:.1f} s, drc={{available:{drc.get("available")}, errors:{drc.get("errors")}, '
              f'unconnected:{drc.get("unconnected")}}}, unrouted={len(summary.get("unrouted") or [])}')

        g = http_json(f'{base}/generate_gerber', {'pcbFilename': done[-1]['pcbFilename']} if done else {})
        files = g.get('files') or []
        gbr = [f for f in files if f.lower().endswith('.gbr')]
        drl = [f for f in files if f.lower().endswith('.drl')]
        check('34 gerbers + drill', len(gbr) >= 4 and len(drl) >= 1,
              f'{len(files)} files, gerber-like {len(gbr)}, drill {len(drl)}' + (f', error={g.get("error")}' if g.get('error') else ''))

        which = sh('docker', 'exec', NAME, 'sh', '-c',
                   'command -v python; python -c "import skidl, numpy; print(\'ok\')"; ls node_modules/.bin/tsx').stdout.split()
        check('35 runtime wiring', which[:1] == ['/venv/bin/python'] and 'ok' in which and 'node_modules/.bin/tsx' in which,
              ' '.join(which))
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
