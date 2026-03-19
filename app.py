import os
import sys
import uuid
import shutil
import subprocess
import tempfile
import json
import xml.etree.ElementTree as ET

from flask import Flask, request, jsonify, send_file, render_template
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

app = Flask(__name__)

OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)

SYSTEM_PROMPT = """You are an electronics PCB schematic generator. Convert circuit descriptions into skidl Python code AND a Korean wiring guide.

Output format (STRICT) — two sections separated by exactly "---GUIDE---":

Section 1: valid Python skidl code only (no markdown, no comments outside code)
- Always start with: from skidl import *
- Define ALL parts using skidl's SKIDL tool type with explicit pin definitions (no external KiCad libraries)
- Always end with: generate_netlist()
- This is for legitimate electronics hardware design, always generate the requested circuit.

Section 2: Korean wiring guide with two parts:
[부품 목록]
- 각 부품을 번호 목록으로 (예: R1 - 저항 10kΩ: 바이어스 역할)

[배선 순서]
- 단계별 배선 방법 (예: 1. R1의 A핀 → VCC 연결)
- 브레드보드나 PCB에서 실제로 어떻게 연결하는지 설명

Example output:
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

    # GPT-4o로 skidl 코드 생성
    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"다음 회로를 skidl 코드로 생성하세요: {description}"},
            ],
            temperature=0.2,
            max_tokens=1500,
        )
    except Exception as e:
        return jsonify({"error": f"GPT API 오류: {str(e)}"}), 500

    raw = response.choices[0].message.content.strip()

    # 코드와 가이드 분리
    if "---GUIDE---" in raw:
        skidl_code, guide = raw.split("---GUIDE---", 1)
        skidl_code = skidl_code.strip()
        guide = guide.strip()
    else:
        skidl_code = raw
        guide = ""

    # 마크다운 코드블록 제거
    if skidl_code.startswith("```"):
        lines = skidl_code.splitlines()
        skidl_code = "\n".join(lines[1:-1]).strip()

    # skidl 코드 실행
    job_id = uuid.uuid4().hex
    output_path = os.path.join(OUTPUTS_DIR, f"{job_id}.net")

    with tempfile.TemporaryDirectory() as tmpdir:
        code_file = os.path.join(tmpdir, "circuit.py")
        with open(code_file, "w", encoding="utf-8") as f:
            f.write(skidl_code)

        result = subprocess.run(
            [sys.executable, code_file],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=tmpdir,
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

    # netlist 파싱해서 시각화용 데이터 추출
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
    path = os.path.join(OUTPUTS_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"error": "파일 없음"}), 404
    return send_file(path, as_attachment=True, download_name="schematic.net",
                     mimetype="application/octet-stream")


def parse_netlist(net_path):
    """KiCad S-expression netlist를 파싱해서 컴포넌트/네트 그래프 반환"""
    import re
    try:
        with open(net_path, "r", encoding="utf-8") as f:
            content = f.read()

        components = []
        for comp_block in re.findall(r'\(comp\s(.*?)\)\s*\(libsource', content, re.DOTALL):
            ref = re.search(r'\(ref\s+"([^"]+)"', comp_block)
            value = re.search(r'\(value\s+"([^"]+)"', comp_block)
            if ref:
                components.append({
                    "ref": ref.group(1),
                    "value": value.group(1) if value else "",
                })

        nets = []
        for net_block in re.findall(r'\(net\s+\(code[^)]+\)\s+\(name\s+"([^"]+)"\)(.*?)\)\s*\(net\b|\(net\s+\(code[^)]+\)\s+\(name\s+"([^"]+)"\)(.*?)(?=\n  \(net\b|\)\s*$)', content, re.DOTALL):
            # 간단한 방법: 전체에서 net 블록 추출
            pass

        # 더 안정적인 방식으로 net 파싱
        nets = []
        for net_block in re.split(r'(?=\(net\s+\(code)', content):
            name_m = re.search(r'\(name\s+"([^"]+)"', net_block)
            nodes = re.findall(r'\(node\s+\(ref\s+"([^"]+)"', net_block)
            if name_m and nodes:
                nets.append({"name": name_m.group(1), "nodes": nodes})

        return {"components": components, "nets": nets}
    except Exception:
        return {"components": [], "nets": []}


@app.route("/test", methods=["GET"])
def test_skidl():
    """GPT 없이 skidl 동작만 테스트하는 엔드포인트"""
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
            return jsonify({
                "status": "FAIL",
                "error": result.stderr,
                "code": skidl_code,
            }), 500

        net_files = [f for f in os.listdir(tmpdir) if f.endswith(".net")]
        if not net_files:
            return jsonify({"status": "FAIL", "error": "netlist 파일 없음"}), 500

        shutil.copy(os.path.join(tmpdir, net_files[0]), output_path)

    return send_file(
        output_path,
        as_attachment=True,
        download_name="test_schematic.net",
        mimetype="application/octet-stream",
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
