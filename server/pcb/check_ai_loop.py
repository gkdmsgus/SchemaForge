"""
Stage-4 checks: fixed placement and the AI improvement loop.

The loop itself lives in the Node server, so this script talks to a server started
with SF_AI_STUB=1 (a deterministic stand-in for the model: round 1 proposes a GND widening
and an off-board move together, round 2 stops). SF_AI_STUB_MODE=fail2: round 2 fails instead.
What a stopped run leaves behind (24f on) goes through the real OpenAI SDK to a fake model on a local port, which counts
the calls and can leave one hanging: no real model is called. These servers are started here, with SF_AI_BUDGET_MS short.

Usage: python check_ai_loop.py [--port 8098]   (a stub server already running; without --port it starts its own)
Exit code 0 only if every check passes.
"""
import argparse, http.client, json, os, re, select, socket, subprocess, sys, tempfile, threading, shutil, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from board import generate  # noqa: E402


def sse_post(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    events = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        name = None
        for raw in r:
            line = raw.decode('utf-8').rstrip('\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: ') and name:
                events.append((name, json.loads(line[6:])))
                name = None
    return events


class Server:
    """The real server on a free port, with a temp folder of its own (sf_bak_ files are counted there)."""
    def __init__(self, **env):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        self.base = f'http://127.0.0.1:{self.port}'
        self.tmp = tempfile.mkdtemp(prefix='sf_ailoop_')
        self.log = open(os.path.join(self.tmp, 'server.log'), 'w', encoding='utf-8')
        # node --import tsx: one process to stop, where the tsx command would leave its child running on Windows.
        # Every setting named, so a server/.env in the checkout (dotenv never overrides one) adds no model or login
        self.proc = subprocess.Popen(['node', '--import', 'tsx', 'index.ts'], cwd=SERVER, stdout=self.log, stderr=self.log, env={
            **os.environ, 'PORT': str(self.port), 'NODE_ENV': 'development', 'SUPABASE_URL': '', 'SUPABASE_SERVICE_KEY': '',
            'ALLOWED_EMAILS': '', 'SF_AI_JSON': '', 'SF_AI_STUB': '', 'SF_AI_STUB_MODE': '', 'OPENAI_API_KEY': '',
            'TMP': self.tmp, 'TEMP': self.tmp, 'TMPDIR': self.tmp, **env})

    def __enter__(self):
        t0 = time.time()
        while time.time() - t0 < 60:
            try:
                urllib.request.urlopen(f'{self.base}/health', timeout=2).close()
                return self
            except OSError:
                time.sleep(0.3)
        self.stop()
        raise RuntimeError(f'the server did not start in 60 s on port {self.port}')

    def __exit__(self, *_):
        self.stop()

    def stop(self):
        self.proc.terminate()
        self.proc.wait(30)
        self.log.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def backups(self):
        return sorted(f for f in os.listdir(self.tmp) if f.startswith('sf_bak_'))


class FakeModel(ThreadingHTTPServer):
    """An OpenAI-compatible API on a free port. answer(n) is the n-th call's edit, or None to leave that call hanging
    until its caller goes away (dropped counts those)."""
    def __init__(self, answer, delay=0):
        super().__init__(('127.0.0.1', 0), FakeModelCall)
        self.answer, self.delay = answer, delay
        self.calls = self.answered = self.dropped = 0
        self.closing = threading.Event()
        self.base = f'http://127.0.0.1:{self.server_address[1]}/v1'

    def handle_error(self, *_):
        pass    # the caller hung up, which is what these checks do

    def __enter__(self):
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.closing.set()
        self.shutdown()
        self.server_close()

    def env(self):
        return {'OPENAI_API_KEY': 'check-only', 'OPENAI_BASE_URL': self.base, 'SF_AI_MODEL': 'fake-model'}


class FakeModelCall(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        fake = self.server
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        fake.calls += 1
        edit = fake.answer(fake.calls)
        if edit is None:
            while not fake.closing.is_set():
                if select.select([self.connection], [], [], 0.2)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                    fake.dropped += 1
                    return
            return
        time.sleep(fake.delay)
        call = {'id': 't', 'type': 'function', 'function': {'name': 'edit_board', 'arguments': json.dumps(edit)}}
        body = json.dumps({'id': 'c', 'object': 'chat.completion', 'created': 0, 'model': 'fake-model', 'choices': [
            {'index': 0, 'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': None, 'tool_calls': [call]}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        fake.answered += 1


class Stream:
    """A board stream read as it comes; close() hangs up as a closed tab does."""
    def __init__(self, base, body, timeout=300):
        url = urllib.parse.urlsplit(base)
        self.conn = http.client.HTTPConnection(url.hostname, url.port, timeout=timeout)
        self.conn.request('POST', '/generate_pcb_stream', json.dumps(body).encode('utf-8'), {'Content-Type': 'application/json'})
        self.res = self.conn.getresponse()

    def events(self):
        name = None
        for raw in self.res:
            line = raw.decode('utf-8').rstrip('\r\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: ') and name:
                yield name, json.loads(line[6:])
                name = None

    def close(self):
        self.res.close()
        self.conn.close()


def wait_for(ready, seconds):
    t0 = time.time()
    while time.time() - t0 < seconds and not ready():
        time.sleep(0.1)
    return ready()


def outputs_board(stem):
    with open(os.path.join(SERVER, 'outputs', f'{stem}.board.json'), encoding='utf-8') as f:
        return json.load(f)


def board_or_none(stem):
    """None while a process is halfway through writing it."""
    try:
        return outputs_board(stem)
    except ValueError:
        return None


def new_net(work, stem):
    shutil.copy(os.path.join(work, 'ne555_blink.net'), os.path.join(SERVER, 'outputs', f'{stem}.net'))
    return {'filename': f'{stem}.net', 'style': 'smd'}


def gnd_widths(board):
    return sorted({t['width'] for t in board['tracks'] if t['net'] == 'GND'})


def check_fixed_placement(work):
    """20. re-running with the produced positions reproduces the same board."""
    shutil.copy(os.path.join(SERVER, 'test_circuits', 'ne555_blink.py'), work)
    subprocess.run([sys.executable, 'ne555_blink.py'], cwd=work, check=True, capture_output=True)
    net = os.path.join(work, 'ne555_blink.net')
    a = generate(net, os.path.join(work, 'fx_a.kicad_pcb'), 'smd')
    ja = json.load(open(os.path.join(work, 'fx_a.board.json'), encoding='utf-8'))
    ov = {'parts': {p['ref']: [p['x'], p['y'], p['rot']] for p in ja['parts']}, 'net_width': {'GND': 0.8}}
    b = generate(net, os.path.join(work, 'fx_b.kicad_pcb'), 'smd', placer='fixed', overrides=ov)
    jb = json.load(open(os.path.join(work, 'fx_b.board.json'), encoding='utf-8'))
    same = all(abs(p['x'] - q['x']) < 1e-6 and abs(p['y'] - q['y']) < 1e-6 and p['rot'] == q['rot']
               for p, q in zip(ja['parts'], jb['parts']))
    widths = {t['width'] for t in jb['tracks'] if t['net'] == 'GND'}
    ok = same and not b['unrouted'] and widths == {0.8} and not b['overlaps'] and not b['outside']
    return ok, f'same positions={same} GND widths={sorted(widths)} unrouted={len(b["unrouted"])}'


def check_loop(port, work):
    """21-23. the stub loop: good round kept, bad round rolled back, stream well formed."""
    shutil.copy(os.path.join(work, 'ne555_blink.net'), os.path.join(SERVER, 'outputs', 'ai_check.net'))
    events = sse_post(f'http://localhost:{port}/generate_pcb_stream',
                      {'filename': 'ai_check.net', 'style': 'smd', 'ai': True})
    kinds = [k for k, _ in events]
    rounds = [d for k, d in events if k == 'ai']
    done = [d for k, d in events if k == 'done'][-1]
    board = json.load(open(os.path.join(SERVER, 'outputs', 'ai_check.board.json'), encoding='utf-8'))

    res = {}
    # A bad move is rolled back either after rerouting (numbers got worse) or before it,
    # by the courtyard/outline precheck (note says so, no `after`).
    bad = [r for r in rounds if not r['kept'] and not r['actions'].get('stop')]
    res['21 bad round rolled back'] = (
        any((r.get('after') and r['after']['hpwl'] > r['before']['hpwl']) or '사전 검사' in (r.get('note') or '')
            for r in bad)
        and max(p['x'] for p in board['parts']) < board['outline'][2],
        f'rounds kept={[r["kept"] for r in rounds]} notes={[r.get("note") for r in bad]}')
    # what the AI rounds list shows: Korean, no English words (2026-11-01 tour: "C3 would overlap R2"; a stopped round
    # had "stop"). Part refs, net names and mm stay
    notes = [r.get('note') or '' for r in rounds]
    english = [n for n in notes if re.search(r'[A-Za-z]{2,}', re.sub(r'\b(?:[A-Z0-9_$+\-]+|mm)\b', '', n))]
    res['21b notes in Korean'] = (any('사전 검사' in n for n in notes) and not english, f'notes={notes}')
    gnd = {t['width'] for t in board['tracks'] if t['net'] == 'GND'}
    res['22 good round kept'] = (
        any(r['kept'] for r in rounds) and gnd == {0.8} and done['summary']['net_width'].get('GND') == 0.8,
        f'GND widths={sorted(gnd)} net_width={done["summary"]["net_width"]}')
    res['23 stream shape'] = (
        kinds.count('ai') == len(rounds) and kinds.index('ai') < len(kinds) - 1 and kinds[-1] == 'done'
        and all('before' in r for r in rounds),
        f'{len(rounds)} ai events, order ok')
    res['24 board still clean'] = (
        not done['summary']['unrouted'] and not done['summary']['overlaps'] and
        (done.get('drc') or {}).get('errors', 0) == 0,
        f'unrouted={len(done["summary"]["unrouted"])} drc={done.get("drc", {}).get("errors")}')
    first = [r for r in rounds if r['round'] == 1]
    res['24b mixed proposal split'] = (
        [r.get('part') for r in first] == ['width', 'place']
        and first[0]['kept'] and not first[1]['kept']
        and not first[0]['actions'].get('moves') and not first[1]['actions'].get('net_widths'),
        f'round 1 parts={[(r.get("part"), r["kept"]) for r in first]}')
    return res


def check_failed_round(work):
    """24c-24e. round 1 is kept and the model fails in round 2 (a 429, JSON that does not parse): what the screen gets
    is what the file holds. It got the first board while downloads and gerbers read the kept one (review of 2026-11-06)."""
    shutil.copy(os.path.join(work, 'ne555_blink.net'), os.path.join(SERVER, 'outputs', 'ai_fail_check.net'))
    with Server(SF_AI_STUB='1', SF_AI_STUB_MODE='fail2') as server:
        events = sse_post(f'{server.base}/generate_pcb_stream', {'filename': 'ai_fail_check.net', 'style': 'smd', 'ai': True})
        left = server.backups()
    kinds = [k for k, _ in events]
    rounds = [d for k, d in events if k == 'ai']
    done = [d for k, d in events if k == 'done'][-1]
    disk = outputs_board('ai_fail_check')
    last = rounds[-1]
    return {
        '24c failed round: done.board is the file': (
            any(r['kept'] for r in rounds) and done['board'] == disk and gnd_widths(disk) == [0.8] and kinds[-1] == 'done',
            f'done GND {gnd_widths(done["board"])}, disk GND {gnd_widths(disk)}, same={done["board"] == disk}'),
        # stop and a round number: round 0 is what the screen reads as "AI 다듬기 건너뜀", and a round was kept
        '24d failed round: said once, as a stop': (
            last['round'] == 2 and last['actions'].get('stop') is True and not last['kept'] and '여기서 멈추고' in last['reason']
            and kinds[-2] == 'drc' and kinds[-3] == 'ai',
            f'last round={last["round"]} {last["reason"]!r}, stream ends {kinds[-3:]}'),
        '24e no backup left in the temp folder': (not left, f'sf_bak_ files: {len(left)} (a kept trial left 2 each)'),
    }


def check_left(work):
    """24f. the visitor leaves in the middle of the AI rounds and nothing else stops the run: the model is not called again.
    24g-24h. the visitor leaves and retries at once: the file stays the retry's. The loop went on, and the file changed
    under a board already on screen (review of 2026-11-06)."""
    body = new_net(work, 'ai_left_check')
    widths = [0.8, 0.9, 1.0]
    fake = FakeModel(lambda n: {'reason': '(테스트) GND 폭', 'net_widths': [{'net': 'GND', 'mm': widths[min(n, 3) - 1]}]}, delay=1)
    with fake, Server(**fake.env()) as server:
        def leave():
            stream = Stream(server.base, {**body, 'ai': True})
            for kind, _ in stream.events():
                if kind == 'ai':
                    break
            stream.close()
            time.sleep(1)   # a call already on its way when the line dropped may still arrive
            return fake.calls
        calls = leave()
        time.sleep(20)      # longer than a model answer, a reroute and a DRC. No request here: a retry would stop the run too
        alone = fake.calls
        again = leave()
        retry = sse_post(f'{server.base}/generate_pcb_stream', body)
        done = [d for k, d in retry if k == 'done'][-1]
        differs = 0
        for _ in range(20):     # longer than a model answer, a reroute and a DRC, which is how the old loop overwrote it
            time.sleep(1)
            differs += board_or_none('ai_left_check') != done['board']
        later = fake.calls
        left = server.backups()
    return {
        '24f left: the model calls stop': (alone == calls and later == again and calls >= 1,
                                           f'{calls} call(s) when the line dropped, {alone} 20 s after; left again at {again}, {later} after the retry'),
        '24g left: the retry\'s board stays in the file': (differs == 0, f'differed from done.board in {differs} of 20 looks, 1 s apart'),
        '24h left: no backup left': (not left, f'sf_bak_ files: {len(left)}'),
    }


def check_replaced(work):
    """24i. a second request for a board stops the run writing it, whoever is still reading that run's stream.
    24p. while the model thinks the run holds no slot (job_slots.ts): an AI round takes one for its reroute and DRC only,
    and four members waiting on the model held all four for up to 7 minutes (review of 2026-11-08)."""
    body = new_net(work, 'ai_replaced_check')
    fake = FakeModel(lambda n: None)
    with fake, Server(**fake.env()) as server:
        first = Stream(server.base, {**body, 'ai': True})
        seen = []
        reader = threading.Thread(target=lambda: seen.extend(first.events()), daemon=True)
        reader.start()
        called = wait_for(lambda: fake.calls >= 1, 90)
        with urllib.request.urlopen(f'{server.base}/health', timeout=10) as r:
            thinking = json.loads(r.read()).get('jobs')
        second = sse_post(f'{server.base}/generate_pcb_stream', body)
        reader.join(20)
        done = [d for k, d in second if k == 'done'][-1]
        same = done['board'] == outputs_board('ai_replaced_check')
        dropped = wait_for(lambda: fake.dropped >= 1, 5)
        first.close()
    kinds = [k for k, _ in seen]
    said = next((d.get('error', '') for k, d in seen if k == 'error'), '')
    return {'24i a new request takes the board over': (
        called and kinds[-1:] == ['error'] and 'done' not in kinds and '멈췄습니다' in said and same and dropped,
        f'first stream ends {kinds[-2:]}, second done.board is the file: {same}, the hanging model call dropped: {dropped}'),
        '24p no slot held while the model thinks': (
            called and isinstance(thinking, dict) and thinking.get('running') == 0 and thinking.get('waiting') == 0,
            f'/health jobs during the model call: {thinking}')}


def check_cut_trial(work):
    """24j. the visitor leaves while a trial reroutes: the generator is stopped and the file goes back to the best board."""
    body = new_net(work, 'ai_cut_check')
    fake = FakeModel(lambda n: {'reason': '(테스트) GND 폭', 'net_widths': [{'net': 'GND', 'mm': 0.8}]}, delay=1)
    with fake, Server(**fake.env()) as server:
        stream = Stream(server.base, {**body, 'ai': True})
        for kind, _ in stream.events():
            if kind == 'drc':
                break
        before = outputs_board('ai_cut_check')
        answered = wait_for(lambda: fake.answered >= 1, 30)
        time.sleep(0.2)
        stream.close()
        quiet = [0]

        def settled():
            quiet[0] = 0 if server.backups() else quiet[0] + 1
            time.sleep(0.5)
            return quiet[0] >= 6
        wait_for(settled, 60)
        after = board_or_none('ai_cut_check')
        left = server.backups()
    return {'24j a trial cut short is rolled back': (
        answered and after == before and not left,
        f'GND {gnd_widths(before)} before, {gnd_widths(after) if after else "(half written)"} after; sf_bak_ files: {len(left)}')}


def check_budget(work, label, stem, answer, budget_s):
    """The budget ends a run whose model hangs: done with the best board so far, an ai event saying so, no error."""
    body = new_net(work, stem)
    fake = FakeModel(answer)
    t0 = time.time()
    with fake, Server(SF_AI_BUDGET_MS=str(budget_s * 1000), **fake.env()) as server:
        events = sse_post(f'{server.base}/generate_pcb_stream', {**body, 'ai': True}, timeout=240)
        seconds = time.time() - t0
        dropped = wait_for(lambda: fake.dropped >= 1, 5)
        left = server.backups()
    kinds = [k for k, _ in events]
    rounds = [d for k, d in events if k == 'ai']
    done = next((d for k, d in events if k == 'done'), {})
    disk = outputs_board(stem)
    said = rounds[-1]['reason'] if rounds else ''
    # the SDK alone would give up on a hanging call after 60 s, twice
    return kinds, rounds, done, disk, {
        f'{label} hanging model, {budget_s} s budget: done, its board is the file': (
            kinds[-1:] == ['done'] and 'error' not in kinds and done.get('board') == disk and dropped and seconds < budget_s + 60 and not left,
            f'ends {kinds[-2:]} after {seconds:.0f} s, done.board is the file: {done.get("board") == disk}, call dropped: {dropped}, sf_bak_ files: {len(left)}'),
        f'{label}b the screen is told': ('정해진 시간' in said, said),
    }


def check_budget_nothing_kept(work):
    """24k-24l. the model hangs from its first call: the first board, whole."""
    kinds, rounds, done, disk, res = check_budget(work, '24k', 'ai_hang_check', lambda n: None, 20)
    res['24l nothing kept: round 0'] = (rounds[-1:] and rounds[-1]['round'] == 0, f'last round {rounds[-1:] and rounds[-1]["round"]}')
    return res


def check_budget_kept(work):
    """24m-24o. the model answers once, then hangs: the kept board, not the first one (which was an error before)."""
    edit = {'reason': '(테스트) GND 폭', 'net_widths': [{'net': 'GND', 'mm': 0.8}]}
    kinds, rounds, done, disk, res = check_budget(work, '24m', 'ai_hang2_check', lambda n: edit if n == 1 else None, 60)
    res['24o kept round stays, a stop in its round'] = (
        gnd_widths(disk) == [0.8] and rounds[-1]['round'] == 2 and rounds[-1]['actions'].get('stop') is True,
        f'GND {gnd_widths(disk)}, last round {rounds[-1]["round"]}, stop={rounds[-1]["actions"].get("stop")}')
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=0, help='a stub server already running; without it, one is started')
    ap.add_argument('--skip-loop', action='store_true', help='only the generator-side check')
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix='sf_ai_')
    all_ok = True

    ok, info = check_fixed_placement(work)
    all_ok &= ok
    print(f'{"ok  " if ok else "FAIL"} 20 fixed placement  {info}')

    if not args.skip_loop:
        def stub_loop():
            if args.port:
                return check_loop(args.port, work)
            with Server(SF_AI_STUB='1') as server:
                return check_loop(server.port, work)
        groups = [stub_loop, check_failed_round, check_left, check_replaced, check_cut_trial, check_budget_nothing_kept, check_budget_kept]
        for group in groups:
            try:
                for name, (passed, info) in (group() if group is stub_loop else group(work)).items():
                    all_ok &= passed
                    print(f'{"ok  " if passed else "FAIL"} {name}  {info}')
            except Exception as e:
                all_ok = False
                print(f'FAIL loop checks  {e!r}' + (f' (is the stub server running on {args.port}?'
                      f' SF_AI_STUB=1 PORT={args.port} npx tsx index.ts)' if args.port else ''))

    print('ALL PASS' if all_ok else 'SOME CHECKS FAILED')
    sys.exit(0 if all_ok else 1)


if __name__ == '__main__':
    main()
