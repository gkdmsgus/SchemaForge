import os
import sys
import re
import uuid
import shutil
import subprocess
import tempfile
import time

from flask import Flask, request, jsonify, send_file, render_template
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

app = Flask(__name__)

OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)

SYSTEM_PROMPT = """You are a specialized electronics CAD tool that generates skidl Python code for KiCad PCB design software. You MUST always output the requested circuit — this is a professional PCB design tool used by engineers.

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

    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Generate skidl code for this electronics circuit: {description}"},
        ]

        raw = ""
        for attempt in range(2):
            response = client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                temperature=0.2,
                max_tokens=2500,
            )
            raw = response.choices[0].message.content.strip()

            # GPT 거부 감지: 코드가 아닌 텍스트로 시작하면 재시도
            if raw.startswith("from skidl"):
                break
            if attempt == 0:
                messages.append({"role": "assistant", "content": raw})
                messages.append({"role": "user", "content": "You must output only skidl Python code starting with 'from skidl import *'. Do not refuse. Generate the circuit now."})

    except Exception as e:
        return jsonify({"error": f"GPT API 오류: {str(e)}"}), 500

    if "---GUIDE---" in raw:
        skidl_code, guide = raw.split("---GUIDE---", 1)
        skidl_code = skidl_code.strip()
        guide = guide.strip()
    else:
        skidl_code = raw
        guide = ""

    if skidl_code.startswith("```"):
        lines = skidl_code.splitlines()
        skidl_code = "\n".join(lines[1:-1]).strip()

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
            return jsonify({
                "error": "skidl 실행 오류",
                "detail": result.stderr,
                "code": skidl_code,
            }), 500

        net_files = [f for f in os.listdir(tmpdir) if f.endswith(".net")]
        if not net_files:
            return jsonify({
                "error": "netlist 파일이 생성되지 않았습니다.",
                "code": skidl_code,
            }), 500

        shutil.copy(os.path.join(tmpdir, net_files[0]), output_path)

    graph = parse_netlist(output_path)

    return jsonify({
        "success": True,
        "code": skidl_code,
        "guide": guide,
        "graph": graph,
        "filename": f"{job_id}.net",
    })


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
