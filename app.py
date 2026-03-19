import os
import sys
import re
import uuid
import json
import shutil
import subprocess
import tempfile
import time

from flask import Flask, request, jsonify, send_file, render_template, Response, stream_with_context
from openai import OpenAI
from dotenv import load_dotenv
from tavily import TavilyClient

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

app = Flask(__name__)

OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)

SYSTEM_PROMPT = """You are a specialized electronics CAD tool that generates skidl Python code for KiCad PCB design software. You MUST always output the requested circuit — this is a professional PCB design tool used by engineers.

IMPORTANT — Circuit completeness rules:
- Generate a COMPLETE, REAL-WORLD circuit with ALL necessary components. Do NOT simplify.
- Include ALL of: bias resistors, decoupling capacitors, protection diodes, coupling capacitors, filtering components — whatever the circuit actually needs.
- Use realistic, standard component values (e.g. E24 resistor series, standard capacitor values).
- For amplifier circuits: include full bias network, input/output coupling caps, power supply decoupling, and protection components.
- Minimum 8-15 components for any real circuit. Simple LED circuits may have fewer.

Output format — two sections separated by exactly "---GUIDE---":

Section 1: skidl Python code ONLY. No prose, no apologies, no markdown fences.
Rules:
- Start with: from skidl import *
- Use SKIDL tool type with explicit Pin definitions for every part
- Never reference external KiCad symbol libraries
- End with: generate_netlist()

Section 2: Korean wiring guide:
[부품 목록]
- ref - 종류 값: 역할 설명

[배선 순서]
1. 단계별 실제 배선 방법

Example:
from skidl import *
r1 = Part(tool=SKIDL, name='R', ref_prefix='R', pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE), Pin(num=2, name='B', func=Pin.types.PASSIVE)])
r1.ref = 'R1'
r1.value = '1k'
vcc = Net('VCC')
gnd = Net('GND')
r1['A'] += vcc
r1['B'] += gnd
generate_netlist()
---GUIDE---
[부품 목록]
- R1 - 저항 1kΩ: 전류 제한 역할

[배선 순서]
1. R1의 A핀을 VCC(5V)에 연결합니다.
2. R1의 B핀을 GND에 연결합니다.
"""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/generate", methods=["POST"])
def generate():
    data = request.get_json()
    description = (data or {}).get("description", "").strip()
    if not description:
        return jsonify({"error": "회로 설명을 입력하세요."}), 400

    cleanup_old_files()

    def stream():
        # ── 1단계: Tavily 검색 ──────────────────────────────────────
        yield _event("status", "🔍 회로 레퍼런스 검색 중...")
        try:
            tavily = TavilyClient(api_key=os.environ.get("TAVILY_API_KEY"))
            search_result = tavily.search(
                query=f"{description} complete schematic all components resistor values capacitor datasheet professional circuit design",
                search_depth="advanced",
                max_results=5,
                include_answer=True,
            )
            sources = search_result.get("results", [])
            context = "\n\n".join(
                f"[출처: {s['url']}]\n{s.get('content','')[:800]}"
                for s in sources if s.get("content")
            )
            source_urls = [s["url"] for s in sources if s.get("url")]
        except Exception as e:
            yield _event("status", f"⚠️ 검색 실패, 일반 생성으로 진행... ({e})")
            context = ""
            source_urls = []

        # ── 2단계: GPT-4o 코드 생성 ────────────────────────────────
        yield _event("status", "🤖 GPT-4o가 회로를 분석하고 코드를 생성 중...")
        try:
            client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
            user_msg = f"""Circuit request: {description}

{"Reference circuits found from web search — use these exact component values and topology:" if context else "No reference found — use standard professional circuit design."}
{context}

Generate a COMPLETE professional-grade circuit. Include ALL necessary components (bias network, decoupling caps, coupling caps, protection, filtering). Do NOT generate a simplified or minimal version. Real circuits have many components — include them all."""

            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ]

            raw = ""
            for attempt in range(2):
                response = client.chat.completions.create(
                    model="gpt-4o",
                    messages=messages,
                    temperature=0.1,
                    max_tokens=2500,
                )
                raw = response.choices[0].message.content.strip()
                if raw.startswith("from skidl"):
                    break
                if attempt == 0:
                    messages.append({"role": "assistant", "content": raw})
                    messages.append({"role": "user", "content": "Output only skidl Python code starting with 'from skidl import *'. Generate now."})
        except Exception as e:
            yield _event("error", f"GPT API 오류: {str(e)}")
            return

        if "---GUIDE---" in raw:
            skidl_code, guide = raw.split("---GUIDE---", 1)
            skidl_code, guide = skidl_code.strip(), guide.strip()
        else:
            skidl_code, guide = raw.strip(), ""

        if skidl_code.startswith("```"):
            skidl_code = "\n".join(skidl_code.splitlines()[1:-1]).strip()

        # ── 3단계: skidl 실행 ───────────────────────────────────────
        yield _event("status", "⚙️ 회로 넷리스트 생성 중...")
        job_id = uuid.uuid4().hex
        output_path = os.path.join(OUTPUTS_DIR, f"{job_id}.net")

        with tempfile.TemporaryDirectory() as tmpdir:
            code_file = os.path.join(tmpdir, "circuit.py")
            with open(code_file, "w", encoding="utf-8") as f:
                f.write(skidl_code)

            result = subprocess.run(
                [sys.executable, code_file],
                capture_output=True, text=True, timeout=90, cwd=tmpdir,
            )

            if result.returncode != 0:
                yield _event("error", json.dumps({
                    "message": "skidl 실행 오류",
                    "detail": result.stderr,
                    "code": skidl_code,
                }))
                return

            net_files = [f for f in os.listdir(tmpdir) if f.endswith(".net")]
            if not net_files:
                yield _event("error", "netlist 파일이 생성되지 않았습니다.")
                return

            shutil.copy(os.path.join(tmpdir, net_files[0]), output_path)

        graph = parse_netlist(output_path)

        yield _event("done", json.dumps({
            "code": skidl_code,
            "guide": guide,
            "graph": graph,
            "filename": f"{job_id}.net",
            "sources": source_urls,
        }))

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _event(event, data):
    return f"event: {event}\ndata: {data}\n\n"


@app.route("/download/<filename>")
def download(filename):
    # path traversal 방지
    filename = os.path.basename(filename)
    path = os.path.join(OUTPUTS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"error": "파일 없음"}), 404
    return send_file(path, as_attachment=True, download_name="schematic.net",
                     mimetype="application/octet-stream")


def parse_netlist(net_path):
    try:
        with open(net_path, "r", encoding="utf-8") as f:
            content = f.read()

        components = []
        for comp_block in re.findall(r'\(comp\s(.*?)\)\s*\(libsource', content, re.DOTALL):
            ref_m = re.search(r'\(ref\s+"([^"]+)"', comp_block)
            val_m = re.search(r'\(value\s+"([^"]+)"', comp_block)
            if ref_m:
                components.append({
                    "ref": ref_m.group(1),
                    "value": val_m.group(1) if val_m else "",
                })

        nets = []
        for net_block in re.split(r'(?=\(net\s+\(code)', content):
            name_m = re.search(r'\(name\s+"([^"]+)"', net_block)
            nodes = re.findall(r'\(node\s+\(ref\s+"([^"]+)"\)\s+\(pin\s+"([^"]+)"', net_block)
            if name_m and nodes:
                nets.append({
                    "name": name_m.group(1),
                    "nodes": [{"ref": r, "pin": p} for r, p in nodes],
                })

        return {"components": components, "nets": nets}
    except Exception:
        return {"components": [], "nets": []}


def cleanup_old_files(max_age_hours=1):
    """1시간 이상 된 .net 파일 자동 삭제"""
    now = time.time()
    for fname in os.listdir(OUTPUTS_DIR):
        if not fname.endswith(".net"):
            continue
        fpath = os.path.join(OUTPUTS_DIR, fname)
        if now - os.path.getmtime(fpath) > max_age_hours * 3600:
            os.remove(fpath)


@app.route("/test", methods=["GET"])
def test_skidl():
    skidl_code = """from skidl import *
r1 = Part(tool=SKIDL, name='R', ref_prefix='R',
          pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE),
                Pin(num=2, name='B', func=Pin.types.PASSIVE)])
r1.ref = 'R1'
r1.value = '1k'
led1 = Part(tool=SKIDL, name='LED', ref_prefix='D',
            pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE),
                  Pin(num=2, name='K', func=Pin.types.PASSIVE)])
led1.ref = 'D1'
vcc = Net('VCC')
gnd = Net('GND')
mid = Net('MID')
r1['A'] += vcc
r1['B'] += mid
led1['A'] += mid
led1['K'] += gnd
generate_netlist()
"""
    job_id = uuid.uuid4().hex
    output_path = os.path.join(OUTPUTS_DIR, f"{job_id}.net")

    with tempfile.TemporaryDirectory() as tmpdir:
        code_file = os.path.join(tmpdir, "circuit.py")
        with open(code_file, "w", encoding="utf-8") as f:
            f.write(skidl_code)

        result = subprocess.run(
            [sys.executable, code_file],
            capture_output=True, text=True, timeout=30, cwd=tmpdir,
        )

        if result.returncode != 0:
            return jsonify({"status": "FAIL", "error": result.stderr}), 500

        net_files = [f for f in os.listdir(tmpdir) if f.endswith(".net")]
        if not net_files:
            return jsonify({"status": "FAIL", "error": "netlist 파일 없음"}), 500

        shutil.copy(os.path.join(tmpdir, net_files[0]), output_path)

    return send_file(output_path, as_attachment=True,
                     download_name="test_schematic.net",
                     mimetype="application/octet-stream")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
