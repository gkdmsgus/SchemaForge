"""Edit a raw tour recording again, with the sped-up waits found in the recording itself.

The runner's edit (lib.mjs edit()) places each sped-up wait by the wall clock, and in take 10 of 2026-10-30 the
recording ran up to 15 s apart from it: waits with a "▶▶ n배속" badge played at 1x and the scenes after them were
fast-forwarded. Here a wait is where the badge is on screen (orange, top right), frame by frame; its speed comes from
the waits shots_b.mjs logs in order (videos/tour_fast_B.json), matched by length, or from --speeds. Two waits back to
back can leave one badge run; it is cut in the ratio of their logged lengths, each part at its own speed.

  python scripts/tour/reedit.py RAW.webm RUNNER.mp4 OUT.mp4 [--calls videos/tour_fast_B.json | --speeds 6,6,8,...]

RUNNER.mp4 is the runner's own edit, used to find where it cut the white start. Every wait in OUT.mp4 is measured
again and printed next to the length it should have.
"""
import argparse
import json
import subprocess

import numpy as np

FPS = 25
X, Y, W, H = 1130, 58, 140, 42          # around the badge: right 18 px, top 64 px of a 1280 x 720 page
MIN_FAST = 1.5                          # shorter waits stay at 1x, as in lib.mjs


def badge_runs(video):
    cmd = ['ffmpeg', '-v', 'error', '-i', video, '-vf', f'fps={FPS},crop={W}:{H}:{X}:{Y}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (W * H * 3)
    f = np.frombuffer(raw[:n * W * H * 3], dtype=np.uint8).reshape(n, H, W, 3).astype(int)
    on = ((f[..., 0] > 215) & (f[..., 1] > 105) & (f[..., 1] < 175) & (f[..., 2] < 70)).reshape(n, -1).sum(axis=1) > 600
    runs, i = [], 0
    while i < n:
        if on[i]:
            j = i
            while j + 1 < n and (on[j + 1] or on[j + 2:j + 4].any()):
                j += 1
            runs.append((i / FPS, (j + 1) / FPS))
            i = j + 1
        else:
            i += 1
    return runs


def gray(video, start, dur):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', video, '-vf', f'fps={FPS},scale=160:90,format=gray', '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, 90, 160).astype(float)


def find_trim(raw, runner_mp4, first_wait):
    """the runner's cut: frames of its mp4 before the first wait, each found at its earliest place in the raw video
    (still frames repeat, so each gives a lower bound) - the largest bound"""
    w = gray(raw, 0, min(first_wait, 30))
    bounds = []
    for t in np.arange(0.5, max(1.0, min(first_wait - 4, 12)), 0.5):
        ref = gray(runner_mp4, float(t), 0.04)[0]
        d = ((w - ref) ** 2).mean(axis=(1, 2))
        bounds.append(int(d.argmin()) / FPS - float(t))
    return max(bounds)


def speeds_from_calls(runs, calls):
    """badge runs and logged waits paired in order, the whole list at once (dynamic programming): a wait of under a
    second can leave a badge of one frame or none, and pairing one by one slipped a place there (take 11)"""
    calls = [c for c in calls if c.get('b') is not None]
    n, m = len(runs), len(calls)
    cost = lambda r, c: abs(np.log((r[1] - r[0] + 0.3) / (c['b'] - c['a'] + 0.3)))
    skip = lambda c: 0.2 if c['b'] - c['a'] < 1.0 else 3.0     # a long wait always shows its badge
    INF = float('inf')
    dp = np.full((n + 1, m + 1), INF)
    back = {}
    dp[0, 0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            if dp[i, j] == INF:
                continue
            if j < m and dp[i, j] + skip(calls[j]) < dp[i, j + 1]:
                dp[i, j + 1] = dp[i, j] + skip(calls[j])
                back[(i, j + 1)] = (i, j, None)
            if i < n and j < m and dp[i, j] + cost(runs[i], calls[j]) < dp[i + 1, j + 1]:
                dp[i + 1, j + 1] = dp[i, j] + cost(runs[i], calls[j])
                back[(i + 1, j + 1)] = (i, j, (j,))
            # two waits back to back leave one badge run when the badge is off for less than a frame between them
            # (AI 다듬기 at 8x, then the 3D model at 4x, in take 1 of 2026-11-01)
            if i < n and j + 1 < m:
                both = {'a': calls[j]['a'], 'b': calls[j]['a'] + (calls[j]['b'] - calls[j]['a']) + (calls[j + 1]['b'] - calls[j + 1]['a'])}
                c2 = dp[i, j] + cost(runs[i], both) + 0.15
                if c2 < dp[i + 1, j + 2]:
                    dp[i + 1, j + 2] = c2
                    back[(i + 1, j + 2)] = (i, j, (j, j + 1))
    out, at = [None] * n, (n, m)
    if dp[n, m] == INF:
        return out
    while at != (0, 0):
        i, j, ks = back[at]
        if ks is not None:
            durs = [calls[k]['b'] - calls[k]['a'] for k in ks]
            out[i] = [(d / sum(durs), calls[k]['speed']) for d, k in zip(durs, ks)]
            if abs((runs[i][1] - runs[i][0]) - sum(durs)) > max(1.0, 0.25 * sum(durs)) and runs[i][1] - runs[i][0] > MIN_FAST:
                print(f'  run {i} ({runs[i][1] - runs[i][0]:.2f} s) paired with waits of {sum(durs):.2f} s: check it')
        at = (i, j)
    return out


def segments(run, parts):
    """a badge run cut into its waits, each (start, end, speed); a part of MIN_FAST or less stays at 1x"""
    s, e = run
    out, t = [], s
    for share, sp in parts:
        end = t + share * (e - s)
        out.append((t, end, sp if end - t > MIN_FAST else 1))
        t = end
    return out


def edit(raw, out, trim, fast):
    segs, t = [], trim
    for a, b, s in sorted(fast):
        if b <= t:
            continue
        a2 = max(a, t)
        if a2 > t + 0.05:
            segs.append((t, a2, 1))
        segs.append((a2, b, s))
        t = b
    segs.append((t, None, 1))
    parts = [f"[0:v]trim=start={a:.2f}{'' if b is None else f':end={b:.2f}'},setpts=(PTS-STARTPTS)/{s}[v{i}]" for i, (a, b, s) in enumerate(segs)]
    filt = ';'.join(parts) + ';' + ''.join(f'[v{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0[out]'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-filter_complex', filt, '-map', '[out]', '-r', str(FPS),
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw')
    ap.add_argument('runner_mp4')
    ap.add_argument('out')
    ap.add_argument('--calls')
    ap.add_argument('--speeds')
    ap.add_argument('--trim', type=float)
    a = ap.parse_args()

    runs = badge_runs(a.raw)
    if a.speeds:
        speeds = [int(x) for x in a.speeds.split(',')]
        if len(speeds) != len(runs):
            raise SystemExit(f'{len(runs)} badge runs but {len(speeds)} speeds')
        plans = [[(1.0, sp)] for sp in speeds]
    else:
        plans = speeds_from_calls(runs, json.load(open(a.calls, encoding='utf-8'))['calls'])
    for k, ((s, e), p) in enumerate(zip(runs, plans)):
        print(f'#{k:2d} {s:8.2f}-{e:8.2f} ({e - s:6.2f} s)  ' + (' then '.join(f'x{sp} for {sh * (e - s):.2f} s' for sh, sp in p) if p else 'x?'))
    unknown = [k for k, ((s, e), p) in enumerate(zip(runs, plans)) if p is None and e - s > MIN_FAST]
    if unknown:
        raise SystemExit(f'no logged wait matches badge runs {unknown}: give --speeds')

    trim = a.trim if a.trim is not None else find_trim(a.raw, a.runner_mp4, runs[0][0] if runs else 20)
    print(f'start cut at {trim:.2f} s')
    cuts = [segments(r, p or [(1.0, 1)]) for r, p in zip(runs, plans)]
    edit(a.raw, a.out, trim, [seg for c in cuts for seg in c if seg[2] > 1])

    # each wait measured again in the result
    again = badge_runs(a.out)
    bad = 0
    print(f'{len(runs)} badge runs in the recording, {len(again)} in {a.out}')
    for k, (c, (s2, e2)) in enumerate(zip(cuts, again)):
        want = sum((e - s) / sp for s, e, sp in c)
        ok = abs((e2 - s2) - want) < 0.25
        bad += not ok
        print(f'#{k:2d} should last {want:5.2f} s, lasts {e2 - s2:5.2f} s  {"ok" if ok else "CHECK"}')
    if len(again) != len(runs) or bad:
        raise SystemExit(f'{bad} waits off, {len(again)} of {len(runs)} badge runs found again')


if __name__ == '__main__':
    main()
