import os
import sys
import uuid
import shutil
import subprocess
import tempfile

from django.conf import settings
from django.http import FileResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

import json
from openai import OpenAI

from .prompts import SYSTEM_PROMPT


def index(request):
    return render(request, 'index.html')


@csrf_exempt
@require_POST
def generate(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': '잘못된 요청입니다.'}, status=400)

    description = data.get('description', '').strip()
    if not description:
        return JsonResponse({'error': '회로 설명을 입력하세요.'}, status=400)

    api_key = settings.OPENAI_API_KEY
    if not api_key:
        return JsonResponse({'error': 'OPENAI_API_KEY가 설정되지 않았습니다.'}, status=500)

    client = OpenAI(api_key=api_key)

    # GPT-4o로 skidl 코드 생성
    try:
        response = client.chat.completions.create(
            model='gpt-4o',
            messages=[
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': f'다음 회로를 skidl 코드로 생성하세요: {description}'},
            ],
            temperature=0.2,
        )
    except Exception as e:
        return JsonResponse({'error': f'GPT API 오류: {str(e)}'}, status=500)

    skidl_code = response.choices[0].message.content.strip()

    # 마크다운 코드블록 제거
    if skidl_code.startswith('```'):
        lines = skidl_code.splitlines()
        skidl_code = '\n'.join(lines[1:-1]).strip()

    # 임시 디렉토리에서 skidl 코드 실행
    job_id = uuid.uuid4().hex
    output_path = settings.OUTPUTS_DIR / f'{job_id}.net'

    with tempfile.TemporaryDirectory() as tmpdir:
        code_file = os.path.join(tmpdir, 'circuit.py')
        with open(code_file, 'w', encoding='utf-8') as f:
            f.write(skidl_code)

        result = subprocess.run(
            [sys.executable, code_file],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=tmpdir,
        )

        if result.returncode != 0:
            return JsonResponse({
                'error': 'skidl 실행 오류',
                'detail': result.stderr,
                'code': skidl_code,
            }, status=500)

        net_files = [f for f in os.listdir(tmpdir) if f.endswith('.net')]
        if not net_files:
            return JsonResponse({
                'error': 'netlist 파일이 생성되지 않았습니다.',
                'code': skidl_code,
            }, status=500)

        shutil.copy(os.path.join(tmpdir, net_files[0]), output_path)

    return FileResponse(
        open(output_path, 'rb'),
        as_attachment=True,
        filename='schematic.net',
        content_type='application/octet-stream',
    )
