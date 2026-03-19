import os
import sys
import uuid
import shutil
import subprocess
import tempfile
import json

from flask import Flask, request, jsonify, send_file, render_template
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUTS_DIR, exist_ok=True)

SYSTEM_PROMPT = """You are an expert KiCad schematic generator using the skidl Python library.

Rules (STRICT):
- Output ONLY valid Python code. No markdown, no explanation, no comments outside code.
- Always start with: from skidl import *
- Define ALL parts using skidl's SKIDL tool type with explicit pin definitions (do NOT reference external KiCad libraries)
- Always end with: generate_netlist()

Example of correct part definition:
from skidl import *

r1 = Part(tool=SKIDL, name='R', ref_prefix='R',
          pins=[Pin(num=1, name='A', func=Pin.types.PASSIVE),
                Pin(num=2, name='B', func=Pin.types.PASSIVE)])
r1.ref = 'R1'
r1.value = '1k'

vcc = Net('VCC')
gnd = Net('GND')
r1['A'] += vcc
r1['B'] += gnd

generate_netlist()
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
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"다음 회로를 skidl 코드로 생성하세요: {description}"},
            ],
            temperature=0.2,
        )
    except Exception as e:
        return jsonify({"error": f"GPT API 오류: {str(e)}"}), 500

    skidl_code = response.choices[0].message.content.strip()

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

    return send_file(
        output_path,
        as_attachment=True,
        download_name="schematic.net",
        mimetype="application/octet-stream",
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
