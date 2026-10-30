# SchemaForge로 만든 기판을 실제로 주문하고 조립하기

조사일은 2026-10-29다. 웹 정보는 모두 이날 열어 본 페이지가 기준이다. 가격과 규정은 바뀌니 주문 직전에 다시 본다.
`[ ]` 안은 출처 기호이고, 목록은 맨 아래에 있다. 열지 못했거나 검색 요약으로만 본 것은 **미확인**이라고 적었다.
측정은 로컬 KiCad 10.0.6으로 했다. 배포 서버의 KiCad는 10.0.5다(https://schemaforge.kro.kr/health 응답, Dockerfile:23). 버전이 달라 결과가 조금 다를 수 있다.

## 0) 먼저 알아 둘 것

### 데모 기판은 그대로 주문하면 안 된다
README '알려진 제약'은 "데모 기판을 그대로 제작하지 마세요"라고 데모 전체에 대해 말한다 [README].
- 릴레이 데모 Q1=2N3904는 SMD로 만들면 MMBT3904 다리 순서(1=B, 2=E, 3=C)로 배선된다.
- 모터 데모 Q1=2N7002는 THT로 만들면 2N7000 다리 순서(1=S, 2=G, 3=D)로 배선된다.
- 모터 데모의 2 A는 검증한 값이 아니다. 2N7002 연속 드레인 전류는 최대 115 mA, 2N7000은 200 mA다. README가 인용한 onsemi 데이터시트 값이고, 링크는 이번에 열지 않았다 → 미확인.
- 하이사이드 스위치, 555 방전 핀 전류와 출력 LOW 전압, 커패시터 내압(견딜 수 있는 최대 전압), 555 주파수가 요청값과 맞는지는 검사하지 않는다.

데모별로 따로 찾은 문제 [측정]:

| 데모 | 문제 |
|---|---|
| motor | 감지 저항 R2(0.1 Ω)는 2 A에서 0.4 W를 낸다(회로 주석). 그런데 자리는 0805(0.125 W 기준)나 DIN0207(0.25 W 기준)이다. 모터 전류가 흐르는 MOT_LOW·SENSE 선도 0.25 mm 신호선 폭이다. THT판 Q1(TO-92_Inline, 패드 1.05 mm·구멍 0.75 mm)은 링이 0.15 mm다(계산) |
| relay | 접점 COM·NO·NC 선도 0.25 mm다. IPC-2221 근사식(외층 1 oz, 온도 상승 10 °C)으로 약 0.88 A다 [IPC-계산기]. NO–NC 간격은 0.57 mm다. 상용 전원(220 V) 절연을 고려한 배치가 아니다(절연 거리 기준은 이번에 확인하지 않음). THT판 Q1 링 0.15 mm는 JLCPCB 값 0.20 mm(일반 표기)와 절대 최소 0.18 mm 둘 다에 못 미친다 [JLC-능력] |
| led | 문제는 없다. 부품이 3개뿐이라 배울 것이 적다 |
| ne555 | 핀 배열 경고가 없다 |

### ne555만은 그대로 써도 되는 이유
README가 든 이유(트랜지스터 핀 배열, 모터 전류)는 ne555에 해당하지 않는다. 이 회로에는 트랜지스터가 없다. README가 검사하지 않는 항목은 회로 값 [ne555_blink.py]으로 직접 계산했다.
- 방전 핀 전류: 9 V ÷ 10 kΩ(R1) = 0.9 mA에 C1이 R2로 빠지는 6 V ÷ 68 kΩ ≈ 0.09 mA를 더해 약 1 mA다(계산). 방전 핀 한계값은 TI 데이터시트 글에서 찾지 못했다(미확인).
- C1 최대 전압: 문턱이 CONT 전압 2/3 × VCC라 2/3 × 9 V = 6 V다 [TI-555](계산).
- 출력 LOW 전압: LED는 OUT → R3 → D1 → GND에 달려 OUT이 HIGH일 때만 켜진다. LOW 전압과는 상관없다.
- 주파수 1.44 ÷ ((10 kΩ + 2 × 68 kΩ) × 10 µF) = 0.986 Hz로 회로 주석의 목표값과 같다 [TI-555 식](계산). 전원 9 V는 권장 범위 4.5~16 V 안이다 [TI-555].

### 주문 전에 화면에서 볼 것
1. PCB 탭 줄에 빨간 '부품 확인 N', '풋프린트 없음 N' 칩이나 '제작 전 부품 확인 필요' 배너가 없어야 한다 [화면 863-874, 920-947].
2. 기판 아래 지표 줄에 'DRC 오류 0', '미연결 0'이 떠야 한다. 이 두 칸은 배치·배선 재생이 끝난 뒤에만 보인다 [BoardView 658, 1187-1189].
   - DRC(Design Rule Check): 선 간격, 구멍 크기 같은 규칙을 KiCad가 자동으로 검사하는 것.
3. 검사 목록에서 'KiCad 설계 규칙'과 'KiCad 미연결'이 통과여야 하고, '핀 배열 가정' 행이 없어야 한다 [boardChecks 153, 160, 229].
4. 동작 검사(부품 값으로 계산한 동작 판정)에 '경고'나 '판단 불가'가 있으면 이유를 읽는다. 이 검사는 PCB 생성을 막지 않는다 [README 97-120].
5. '방향 확인' 항목을 기억해 둔다. 조립할 때 하나씩 체크한다.

### 거버 zip에 들어 있는 것
- 거버(Gerber): 제조사가 기판을 찍어 내는 층별 그림 파일.
- **거버**를 누르면 PCB 업체에 그대로 올릴 zip 하나가 나온다(2026-10-29 수정분부터) [코드-거버]. 안에는 JLCPCB의 KiCad 안내대로 7개 층(위·아래 동박, 위·아래 솔더마스크, 위·아래 실크, 기판 외곽선)과 드릴 파일 2개가 들어 있다 [JLC-KiCad].
  - 드릴은 PTH와 NPTH로 나뉜다. PTH: 안쪽이 구리로 도금된 구멍(부품 다리·비아용). NPTH: 도금 없는 구멍(나사 구멍).
- 화면에 보이는 GND 동박(pour: 빈 자리를 GND 구리로 채운 면)도 거버에 들어간다. 동박은 다른 구리에서 0.5 mm 떨어져 채워지고, GND 패드에는 통째로 붙는다 [board.py].
  - 그 전 버전은 거버에 동박이 없었고, 동박이 다른 구리에 0.2 mm까지 붙었고, 파일 18개를 하나씩 받아야 했다. 예전에 받은 거버는 쓰지 말고 다시 만든다.

### 첫 기판은 ne555 THT로 만든다
- THT(Through-Hole): 다리를 구멍에 꽂아 뒷면에서 납땜하는 부품. SMD는 기판 표면에 바로 붙이는 작은 부품이다.

이유 [측정]:
- 납땜할 곳이 전부 구멍이다(PTH 패드 26개, SMD 패드 0개, 비아 0개).
- 9 V 배터리로 돈다. 상용 전원이 없다.
- 핀 배열 경고가 없고 DRC 오류 0·경고 0·미연결 0이다. 동작 검사도 모두 통과한다.
- LED가 0.986 Hz(대략 1초에 한 번)로 깜빡여서 성공했는지 눈으로 바로 안다.
- 치수 여유가 크다(선·패드 사이 최소 0.355 mm, 링 0.35 mm, 드릴 0.7 mm).
- 볼트 기록을 보면 손납땜은 해 봤지만 SMD 작업은 아직 안 해 봤다 [볼트]. 화면도 THT를 '손납땜 쉬움'이라고 적는다 [화면 857].

기판 크기는 38.86 × 50.17 mm다. 부품 9개(BT1, C1~C3, D1, R1~R3, U1), 시험 패드 2개(TP1, TP2), M3 나사 구멍 4개가 있다 [측정].
- 고정 구멍 4개는 직사각형 꼭짓점에 있지 않다. 좌표는 H1 (98.48, 96.54), H2 (125.94, 97.29), H3 (128.44, 136.535), H4 (99.23, 134.035) mm이고, 가로 간격은 27.46 / 29.21 mm, 세로 간격은 37.495 / 39.245 mm다(계산) [측정]. 케이스나 받침에 구멍을 낼 때는 KiCad에서 좌표를 재서 쓴다.

## 1) 기판 파일 만들기와 내려받기

- 배포 서버 https://schemaforge.kro.kr 에서는 지금 '설명으로 새 회로 만들기'가 안 된다(OpenAI 크레딧 소진, 429 오류). 데모·PCB·거버는 모델 없이 돌고 로그인도 필요 없다 [DEPLOY 7-10].
- 배포 서버는 15분 동안 요청이 없으면 잠들고, 깨는 데 약 1분 걸린다 [DEPLOY 22]. 데모 하나(넷리스트 → 기판·DRC → 3D → 거버)에 대략 40~60초 걸렸다(같은 제한의 로컬 컨테이너, 2026-10-21) [DEPLOY 28].
- 잠들거나 재시작하면 만든 파일이 지워진다 [DEPLOY 23]. 만들면 바로 받는다.
- 로컬 개발 서버(http://localhost:3000)에서 해도 순서는 같다.

1. https://schemaforge.kro.kr/?demo=ne555 를 연다(로컬: http://localhost:3000/?demo=ne555).
2. 결과 화면 위 탭 줄에서 **PCB**를 누른다.
3. 같은 줄 오른쪽의 **THT**를 누른다. 기본값은 SMD다 [화면 855-862]. 창이 좁으면 이 버튼들이 가로 스크롤 영역에 숨는다. 탭 줄 오른쪽을 가로로 스크롤한다 [화면 852-854].
4. **PCB 생성**을 누르고 끝날 때까지 기다린다. 끝나면 **↓ .kicad_pcb**와 **거버** 버튼이 생긴다 [화면 896-904].
5. 기판 아래 지표 줄을 본다. 기판 38.9 × 50.2 mm, DRC 오류 0, 미연결 0, 방향 확인 0/4(BT1, C1, D1, U1)이면 맞다 [측정].
6. **거버**를 누르고 기다린다. 끝나면 같은 자리에 초록색 **↓ 거버 zip**이 생긴다. 눌러서 zip을 받는다 [화면].
   - 아래 서랍의 **Netlist** 탭을 열면 GERBER 패널에도 **↓ zip 한 번에 받기**와 zip 안의 파일 9개 목록이 있다.
7. 아래 서랍의 **BOM** 탭에서 **부품표 CSV**를 누르면 `<넷리스트 이름>_BOM.csv`가 받아진다 [BOM].
8. (선택) **↓ .kicad_pcb**로 기판 파일도 받아 두면 KiCad에서 열어 보거나 3-2처럼 직접 다시 뽑을 수 있다.
9. 받은 파일은 브라우저의 다운로드 폴더에 생긴다. PowerShell에서 작업 폴더로 옮기고 이름을 바꾼다. 16진수 이름은 받을 때마다 다르니 실제 이름으로 바꿔 쓴다.
   ```powershell
   New-Item -ItemType Directory -Force C:\pcb
   Move-Item "$env:USERPROFILE\Downloads\d67adf47b5b842638d1889b3b2fd7549-gerber.zip" C:\pcb\ne555_tht_gerber.zip
   ```

주의:
- 이름을 바꾸는 이유는 알아보기 쉽게 하려는 것뿐이다(선택). 16진수 이름도 영문 소문자와 숫자뿐이라 JLCPCB의 '영문 파일명, 특수문자 없음' 요구를 어기지 않는다 [JLC-KiCad]. 한글과 특수문자만 피한다.
- 받은 .kicad_pcb는 KiCad 10 형식이다(`(version 20260206)`, `generator_version "10.0"` [board.py HEADER]). KiCad 10.0 이상에서 연다. 그보다 옛 버전에서 열리는지는 시험하지 않았다. 다른 PC에서 할 때 확인한다.
- 회로를 바꾸면 기판이 옛것이 되어 버튼과 패널이 숨는다. 그때는 **PCB 다시 생성**을 누른다 [화면 896].
- 재생 애니메이션('반복' 숫자, 지표 줄)은 requestAnimationFrame으로만 돈다 [BoardView 248-262]. 브라우저는 숨겨진 탭에서 이 호출을 멈추거나 늦추므로, 서버가 끝났어도 '반복 0'에서 멈춘 것처럼 보일 수 있다(유력한 원인, 숨긴 창에서 다시 해 보지 않아 미확인). 창을 앞에 띄워 두면 이어서 진행된다.

## 2) 제조 규격 확인

- 링(annular ring): 구멍 둘레에 남는 구리 고리의 폭.
- 실크스크린: 기판 위에 하얗게 찍히는 글자와 선.
- 비아: 윗면과 아랫면 구리를 잇는 작은 도금 구멍.

ne555 THT 실측값 [측정]과 제조사 최소값 [JLC-능력][PCBWay-능력]:

| 항목 | SchemaForge 값 | JLCPCB 최소 | PCBWay 최소 | 판정 |
|---|---|---|---|---|
| 선 폭 | 신호 0.25 mm, 전원 0.5 mm [코드-배선] | 0.10 mm | 0.1 mm | 통과 |
| 다른 선과 간격 | 규칙 0.25 mm [코드-배선], 선·패드 실측 최소 0.355 mm. 동박–다른 구리는 0.5 mm 설정(같은 설정으로 채운 측정 0.5005 mm). 수정 전 설정은 0.2005 mm까지 붙었다 | 0.10 mm | 0.1 mm | 통과 |
| 가장 작은 구멍 | 0.7 mm(시험 패드) | 0.15 mm | 0.15 mm | 통과 |
| PTH 링 | 0.35 mm | 0.20 mm(일반 표기) / 2층 1 oz 권장 0.25 mm·절대 최소 0.18 mm. 같은 페이지 안에서 값이 다르다 | 0.15 mm | 통과(어느 값으로 봐도) |
| 패드 구멍 사이 | 1.2 mm | 0.45 mm | 약 0.41 mm(Advanced 표 '≥16MIL', Standard 값 없음) | 통과 |
| NPTH(M3 구멍) | 3.2 mm | 0.50 mm | 미확인 | 통과 |
| 구리–기판 가장자리 | 규칙 0.5 mm [코드-배선], 동박 채운 뒤 0.500 mm | 0.2 mm | 0.25 mm(Advanced 표 CNC milling, Standard 값 없음) | 통과 |
| 실크 글자 | 높이 1.0 mm, 굵기 0.15 mm | 높이 1.0 mm, 선 0.15 mm | 높이 0.8 mm, 폭 0.15 mm | 통과(JLCPCB 최소와 같아 여유 0) |
| 실크 선(부품 테두리) | 0.12 mm | 0.15 mm | 미확인 | **미달**: 흐리게 찍힐 수 있다 |
| 패드–실크 간격 | 재지 않음 | 0.15 mm | 미확인 | 미확인 |
| 기판 크기 | 38.86 × 50.17 mm | 3 × 3 ~ 670 × 600 mm | 3 × 3 ~ 600 × 1200 mm | 통과 |
| 두께 | 1.6 mm [board.py 434] | 1.6 mm 선택 가능 | 0.2~3.2 mm | 통과 |

- 실크 선 0.12 mm는 KiCad 기본 풋프린트(부품 자리 모양) 값이라 앱에서 바꿀 수 없다 [측정]. 실크는 전기 연결과 상관없는 인쇄층이다.
- 다른 데모: SMD 기판의 비아(지름 0.8 mm, 구멍 0.4 mm)는 지름이 구멍보다 0.4 mm 크다. JLCPCB 기준(0.1 mm 이상, 권장 0.15 mm 이상)을 넉넉히 넘는다 [JLC-능력]. relay·motor THT판 Q1 링 0.15 mm는 JLCPCB 값에 못 미친다(0절 표).
- SchemaForge DRC는 KiCad 기본 규칙으로 돌고, 제조사 규격과 자동으로 비교하지 않는다 [board.py 456-459]. 그래서 이 표로 대신 확인한다.

## 3) 거버 zip 확인, 업로드, 주문 옵션

### 3-1. 앱의 거버 zip을 그대로 쓴다
1절 6번의 **↓ 거버 zip**이 주문용 파일이다. 서버가 아래 일을 한 번에 한다 [코드-거버].
- 7개 층만 내보낸다: `-F_Cu.gtl`, `-B_Cu.gbl`, `-F_Mask.gts`, `-B_Mask.gbs`, `-F_Silkscreen.gto`, `-B_Silkscreen.gbo`, `-Edge_Cuts.gm1`. 페이스트 층은 스텐실·조립 주문 때만 쓰여서 넣지 않는다 [JLC-KiCad].
- 내보내기 전에 동박을 채운다(`--check-zones`). 화면의 GND 동박이 그대로 동박 층에 들어간다.
- 드릴은 `-PTH.drl`과 `-NPTH.drl`로 나눈다(`--excellon-separate-th`) [JLC-KiCad]. 드릴 맵과 gbrjob(작업 파일)은 안내에 없어 넣지 않는다.
- 이 9개 파일만 zip 하나로 묶는다. JLCPCB는 zip이나 rar 파일 하나, 100 MB 이하만 받는다 [JLC-견적]. PCBWay는 rar·zip·7z, 50 MB 이하를 받는다 [PCBWay-견적].
- 앱의 기판 검사는 같은 코드로 테스트 기판 10개의 zip을 만들어, 파일 9개, 도금·비도금 드릴 분리, 동박이 거버에 들어갔는지, 동박 간격 0.5 mm를 매번 확인한다. DRC도 동박을 채운 상태로 돈다 [run_checks].

### 3-2. (선택) KiCad로 직접 다시 뽑기
KiCad에서 기판을 고쳤을 때만 한다. 1절 8번의 .kicad_pcb를 `C:\pcb\ne555_tht.kicad_pcb`로 두고 PowerShell에서 실행한다. 앱이 쓰는 설정과 같다.

```powershell
$k = "$env:LOCALAPPDATA\Programs\KiCad\10.0\bin\kicad-cli.exe"
cd C:\pcb
# 1) 동박을 채운 상태로 DRC (파일은 바뀌지 않는다). violations 0, unconnected 0이어야 한다
& $k pcb drc --format json --severity-all --refill-zones -o drc.json ne555_tht.kicad_pcb
$d = Get-Content drc.json -Raw | ConvertFrom-Json; "violations $($d.violations.Count) unconnected $($d.unconnected_items.Count)"
# 2) out 폴더를 비우고, 제조에 쓰는 7개 층만 동박을 채워서
if (Test-Path out) { Remove-Item out\* -Confirm:$false }
New-Item -ItemType Directory -Force out | Out-Null
& $k pcb export gerbers -l F.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,Edge.Cuts --check-zones -o out\ ne555_tht.kicad_pcb
# 3) 드릴: PTH와 NPTH를 따로 (드릴 맵 없이)
& $k pcb export drill --excellon-separate-th -o out\ ne555_tht.kicad_pcb
# 4) 작업 파일은 빼고 zip으로 묶는다
Remove-Item out\*.gbrjob -Confirm:$false
Compress-Archive -Path out\* -DestinationPath ne555_tht_gerber.zip -Force
```

- `-Force`가 있어 다시 실행해도 zip을 덮어쓴다.
- 이 컴퓨터의 kicad-cli는 위 경로(KiCad 10.0.6)에 있다 [server/index.ts:1606].

### 3-3. 올리기 전 준비와 미리보기
1. zip을 풀어 GerbView로 열고 GND 동박, 외곽 직사각형, 3.2 mm 구멍 4개를 눈으로 본다. GerbView는 KiCad와 함께 설치된다. 이 컴퓨터에서는 `%LOCALAPPDATA%\Programs\KiCad\10.0\bin\gerbview.exe`에 있다. 여는 메뉴는 이번에 시험하지 않았다.
2. 관세청 개인통관고유부호에 등록된 성명·휴대폰 번호·우편번호와, JLCPCB 배송지의 수취인 이름·전화·우편번호를 맞춘다. 2026-02-02부터 우편번호까지 일치해야 한다 [정책-유효기간]. 영문 주소를 쓸 때 우편번호와 전화번호를 다르게 넣지 않는다.
3. 해외 결제가 되는 카드나 PayPal을 준비한다. 학생 체크카드는 해외 결제가 막혀 있을 수 있다. JLCPCB가 받는 결제 수단, 카드사 해외 결제 수수료는 확인하지 않았다(미확인).
4. https://cart.jlcpcb.com/quote 에 zip을 올린다. 계정 만들기, 로그인, 결제는 직접 한다.
5. 외곽이 직사각형 하나이고 크기가 약 38.9 × 50.2 mm인지 본다. 외곽선 굵기 0.05 mm를 포함해 38.91 × 50.22 mm로 읽힐 수 있다 [측정]. 3.2 mm 구멍 4개와 층 수 2가 맞는지 본다.
6. 실제 업로드는 이번에 시험하지 않았다(설계를 외부로 보내는 일이라서). 업로드 화면에 뜨는 경고는 미확인이다.

### 3-4. 첫 기판 주문 옵션 (JLCPCB 견적 화면 기준 [JLC-견적])

| 옵션 | 고를 값 | 이유 |
|---|---|---|
| Base Material | FR-4 | 일반 유리섬유 기판. 견적 기준값 |
| Layers | 2 | SchemaForge는 2층만 만든다 [README] |
| 크기 | 업로드에서 읽힌 값 그대로 | 약 38.9 × 50.2 mm인지만 확인 |
| 수량 | 5 | 위 견적을 낸 수량 |
| 두께 | 1.6 mm | 기판 파일 값 [board.py 434] |
| 색 | Green | 추가 요금이 없다. Black도 $4.00이지만 제작이 3 days로 늘고 24시간 옵션이 없어진다 |
| 표면 처리 | HASL(유연) | 기본값 $0. LeadFree HASL은 +$1.30 |
| 외층 동박 | 1 oz | 기본값 |
| 제작 기간 | 2 days | $0. 24 hours로 당기면 +$7.60 |
| 주문번호 표시(Mark on PCB) | 기본값 | 기본값이면 실크 어딘가에 주문번호가 찍힌다고 알려져 있다. 동작과는 상관없다. 옵션 이름과 비용은 견적 화면에서 확인한다(미확인) |
| 나머지 | 기본값 | 'Confirm Production file' 비용은 미확인 |

- HASL: 패드에 납을 입혀 평평하게 고른 마감.

## 4) 가격·배송·통관 (2026-10-29 견적 화면 기준)

견적은 모두 100 × 100 mm, 5장, 2층, 1.6 mm, Green, HASL 조건으로 냈다. 실제 크기(38.9 × 50.2 mm)로는 견적을 내 보지 않았다(미확인).

| 주문처 | 기판 값 | 제작 | 한국 배송 예시 | 합계(계산) |
|---|---|---|---|---|
| JLCPCB 웹 [JLC-견적] | $4.00 | 2 days | UPS $9.71(2-4 영업일), E-POST $6.58(10-16 영업일) | $13.71 / $10.58 |
| PCBWay [PCBWay-견적] | Green $5.00. Blue·Black은 $19.22였다. Red·Yellow는 미확인 | 24 hours | Global Standard $2.72(6-8 영업일), SF $10.15(3-5 영업일) | $7.72 / $15.15 |
| 디바이스마트 샘플 PCB [DM-PCB] | 19,000원(VAT 별도) | 6 영업일 | 롯데택배 2,700원 | 23,600원(VAT 10%를 더해 계산) |

- 원화로는 $13.71 ≈ 18,191원이다(1 USD = 1,326.81원으로 계산 [환율]). 카드사 환율과 해외 결제 수수료가 붙어 실제 청구액은 다르다(미확인).
- JLCPCB 배송비는 '참고용'이고 최종 금액은 결제 단계에서 정해진다 [JLC-견적]. PCBWay 화면에는 "Customs duties and VAT are not included!"라고 적혀 있다 [PCBWay-견적].
- JLCPCB 홈의 '$2.00 / 5 pcs'는 JLCONE Desktop 앱으로 주문할 때 가격이다. 웹 견적은 $4.00이었다 [JLC-견적].
- PCBWay 능력표에는 'No extra charge (Green, Red, Yellow, Blue)'라고 적혀 있지만 Blue 견적은 $19.22였다 [PCBWay-능력][PCBWay-견적]. PCBWay의 옛 KiCad 안내(2017)는 X2 형식을 끄라고 하는데, SchemaForge 거버는 X2다. 지금도 그 안내가 맞는지는 미확인이다 [PCBWay-KiCad옛].
- 디바이스마트는 해외 업체와 협력해 생산한다. 주문 제작이라 취소·반품이 안 된다. 받는 파일 형식은 미확인이다 [DM-PCB].

**권장: JLCPCB + UPS($13.71 예상).** JLCPCB의 현재 KiCad 안내가 3-1의 파일 구성과 맞는다. 또 특송(UPS 같은 특급 배송)의 목록통관 규칙은 확인했지만, 우편(E-POST) 통관 절차는 확인하지 못했다.

### 통관
- 목록통관: 개인이 쓸 물건이 USD 150 이하(미국발은 USD 200 이하)이면 수입신고 없이 관세·부가세를 면제하는 제도다 [관세청-FAQ]. 중국에서 오는 JLCPCB·PCBWay 주문은 USD 150 기준을 따른다 [관세청-계산].
- 기준 금액은 통관 방식에 따라 다르다 [정책-배제].
  - 목록통관: 상품 가격 + 현지 세금 + 현지 배송비 ≤ USD 150. 국제 배송비는 들어가지 않는다.
  - 일반수입신고: 상품 가격 + 현지 세금 + 현지 배송비 + 국제 배송비 ≤ USD 150. 국제 배송비가 들어간다.
  - 이 주문은 어느 쪽이든 $13.71이라 기준보다 훨씬 낮다.
- 맨 PCB가 목록통관에서 빠지는 '방송통신기자재 등 전자제품'에 들어가는지는 미확인이다. 빠지면 일반수입신고 기준(국제 배송비 포함)으로 본다 [정책-배제].
- PCB(HS 8534) 관세율은 0%다. 다만 관세율표를 옮긴 제3자 사이트 기준이고, UNIPASS 원문은 미확인이다 [HS].
- 개인통관고유부호: 해외 직구 때 주민등록번호 대신 쓰는 번호. 2020-12-01부터는 특송 목록통관에도 꼭 넣어야 한다 [부호-의무].
  - 발급과 수정은 관세청 전자통관시스템이나 관세청 앱에서 본인인증을 거쳐 한다 [정책-유효기간]. 인증 수단(휴대폰·공동인증서)은 세무 기사 기준이다(미확인).
  - 2026-01-01부터 유효기간이 생겼다. 2026년 이후 발급분은 1년이고, 그 전 발급분은 2027년 본인 생일에 만료된다. 갱신은 만료일 앞뒤 30일씩, 모두 60일 동안만 된다 [정책-유효기간].
  - 2026-02-02부터 성명·전화번호에 더해 우편번호까지 일치해야 한다 [정책-유효기간]. 3-3의 2번처럼 주문 전에 맞춘다.
  - 2026-08-28부터 시범 운영 중이다. 부호를 새로 발급했거나 주소 등을 바꾼 사람은 일회용 인증번호도 함께 넣는다(기사 기준, 관세청 원문 미확인) [기사-인증].
  - JLCPCB 결제 화면의 어디에 넣는지는 미확인이다(로그인해야 보이는 화면).
- 판매자가 다르면(예: JLCPCB 기판 + DigiKey 부품) 같은 날 들어와도 합산해서 세금을 매기지 않는다(2022-11-17부터) [합산].

## 5) 부품 사기

### ne555 THT 부품표 [측정: board.json, 회로 server/test_circuits/ne555_blink.py]

| 기호 | 값 | 기판 자리 | 살 때 맞출 것 |
|---|---|---|---|
| U1 | NE555 | DIP-8, 줄 간격 7.62 mm | NE555P 같은 바이폴라 NE555, DIP-8(TI 데이터시트의 P 패키지 [TI-555]). TLC555 같은 CMOS 555는 피한다. 동작 검사가 TI NE555 값으로 계산했다 [partSpecs] |
| (U1 자리) | DIP-8 IC 소켓 1개 | 같은 자리 | 줄 간격 7.62 mm. 칩 대신 소켓을 납땜한다. 칩 보호와 칩 없이 하는 전원 점검용. 예: SIC-DIP-8핀 44원(VAT 포함) [DM-소켓] |
| R1, R2, R3 | 10 kΩ, 68 kΩ, 680 Ω | 축형 DIN0207, 다리 간격 10.16 mm | 축형 저항, 0.25 W 기준 자리 |
| C1 | 10 µF 전해 | 지름 5 mm, 다리 간격 2.00 mm, 구멍 0.8 mm | 16 V 이상(C1에 걸리는 최대 전압은 계산상 6 V), 지름 5 mm, 다리 간격 2.0 mm |
| C2, C3 | 10 nF, 100 nF | 디스크 지름 5 mm, 다리 간격 5.00 mm | 다리 간격 5 mm 세라믹. 내압 16 V 이상(C3에는 9 V가 그대로 걸린다, 계산) |
| D1 | 빨강 LED | 5 mm LED, 구멍 0.9 mm | 5 mm 빨강 LED |
| BT1 | 9 V | 2.54 mm 2핀 헤더, 구멍 1.0 mm | 2.54 mm 2핀 수 헤더. 배터리는 악어클립 리드로 잇는다(7절) |

- SchemaForge는 커패시터 내압을 검사하지 않으니 직접 고른다 [README].
- BOM CSV에는 테스트 패드와 고정 구멍이 빠져 있다 [BOM].

### 덤으로 살 것
- 9 V 배터리와 9 V 배터리 스냅(똑딱이 커넥터). BT1은 배터리 홀더가 아니라 2.54 mm 2핀 헤더 자리다 [측정].
- 220 Ω 축형 저항 1개. 기판에 달지 않고, 첫 전원 때 전류를 제한하는 데 쓴다(7절).
- 부품마다 1~2개 여분. 쇼핑몰마다 최소 수량이 있다(예: 엘레파츠 1N4007은 10개부터) [엘레파츠].

### 어디서 찾나
- 화면 **BOM** 탭의 표에는 줄마다 Mouser 검색 링크가 하나 있다(제품을 찾았으면 '제품' 링크) [BomTable 184]. CSV에는 링크가 없다. CSV의 열은 Item, Qty, Designator, Value, Footprint, Type, Pinout basis, Notes, Manufacturer, Manufacturer PN, Mouser PN이다 [BOM]. 크기는 Footprint 열(예: `Capacitor_THT:CP_Radial_D5.0mm_P2.00mm`)로 맞춘다.
- 제조사 부품번호 칸은 서버에 MOUSER_API_KEY가 있을 때만 채워진다 [BOM]. 그래서 정확한 품번은 직접 고른다.
- **권장: 디바이스마트 한 곳에서 부품과 공구를 같이 산다.** 배송비는 2,700원이고, 배송비를 뺀 결제액이 66,000원(VAT 포함) 이상이면 무료다. 롯데택배로 보내고, 영업일 오후 3시 전에 결제하면 재고 상품은 당일 출고된다 [DM-배송]. 공구까지 담으면 무료 기준을 넘기 쉽다.
  - 사이트 검색창에 'NE555 DIP' 같은 말을 넣어 찾는다. 주소에 검색어를 넣는 방식은 3번 모두 0건이 나와 미확인이다.
  - '해외구매' 상품(DigiKey 재고 대행)은 준비에 4~5일이 걸리고 취소·반품이 안 된다. 검색 화면의 '해외구매 제외' 필터를 켠다 [DM-해외].
- 다른 곳:
  - 엘레파츠: 공급가 6만원 이상이면 무료, 아니면 3,000원이다. 로젠택배로 보낸다. '주문수입상품'은 주문부터 배송까지 10~15일 걸린다 [엘레파츠].
  - DigiKey Korea: 60,000원 이상이면 무료, 아니면 20,000원이다. 관세·세금은 받을 때 낸다(CPT 조건). 보통 3~4일 걸린다 [DigiKey].
  - Mouser Korea: '₩60,000 이상 대부분 무료'라는 검색 요약만 봤다. 페이지는 3번 다 시간 초과로 열지 못했다 → 미확인.
  - 아이씨뱅큐 배송비: 이미지로만 되어 있어 읽지 못했다 → 미확인.

## 6) 공구

먼저 가진 것을 확인한다. 볼트에는 '납땜 도구'가 있다고만 적혀 있고, 모델·온도 조절·팁은 기록이 없다 [볼트-장비]. 멀티미터와 벤치 전원은 보유 기록이 없다 [볼트-로드맵].

### 꼭 필요 (가격은 디바이스마트 [DM-공구])

| 공구 | 조건 | 예시 |
|---|---|---|
| 온도 조절 인두 | 지금 인두가 온도 조절이 안 되면 산다. Adafruit는 25 W 이상을 권한다 [Adafruit]. LED 데이터시트는 온도 조절 인두로 제한 온도 아래에서 작업하라고 한다 [Kingbright] | SEQURE SQ-001 71,500원(VAT 포함, 100~400 ℃, 65 W). 'DC 전원 사용 / 외부 배터리 사용'이고 어댑터는 별매 옵션이다. 기본값이 '선택안함'이니 '아답터 12V 5A (추가 8,800원)'을 꼭 고른다. '팁 선택'은 TS-B2를 고른다(아래). 거치대가 들어 있다는 말은 페이지에 없다 |
| 인두 거치대 | 인두는 쓰지 않을 때 항상 스탠드에 둔다 [StonyBrook] | Coms 확대경 스탠드 BB469 18,040원(VAT 포함, 인두 거치대·악어클립 포함, 배율 미기재). SQ-001이 그 거치대에 맞는지는 미확인 |
| 팁 클리너 | 팁을 닦는 수세미형 | HAKKO 599B 14,630원(VAT 포함) |
| 실납 | 유연 Sn63/Pb37, 0.6~0.8 mm, 플럭스 코어. 납땜할 곳이 26곳뿐이라 100 g 이하면 충분하다 | Prokit 납/100g/Sn63%/0.8mm 실납 [T9335] 19,600원(목록가). 플럭스 코어 여부는 상품 페이지를 열지 못해 미확인이니 주문 전에 본다 |
| 플럭스 | 펜형 | SME HS02 11,210원(VAT 포함) |
| 솔더윅(납을 빨아들이는 구리 편조) | 2.0 mm 폭 | HAKKO FR551-2015 4,600원(목록가) |
| 니퍼 | 다리 자르기 | TTC CN-160 11,770원(VAT 포함, 일반용) |
| 멀티미터 | 연속성 부저(통하면 삑 소리)와 DC 전압 측정 | UNI-T UT120C 20,000원(판매가). 리뷰 실측으로는 20 Ω 아래에서 부저가 울리고 약 50 Ω까지 소리가 나기도 한다 [lygte] |
| 악어클립 테스트 리드 | 첫 전원과 배터리 연결용 | 가격 미확인(DFRobot FIT0112 10개 8,100원은 검색 요약만 봄) |
| 보안경 | ANSI Z87.1 등급 [StonyBrook]. 자른 다리가 튄다 [SparkFun-THT] | 가격 미조사 |

- 합계(계산, 악어클립·보안경 제외): 180,150원이다. 지금 인두가 온도 조절형이라 SQ-001과 어댑터를 빼면 99,850원이다.
  - 목록가 두 개(실납, 솔더윅)는 VAT 별도로 보인다. 같은 실납 목록의 Telecore가 60,000원으로, 상품 페이지의 VAT 별도 값과 같았다 [DM-실납목록]. VAT를 더하면 합계는 182,570원이다(계산).
- 팁은 무료 선택지 중 TS-B2(원뿔형)로 한다. iFixit은 굵은 다리(0.75 mm)에 bevel·chisel 팁을, knife 팁은 브리지 제거·드래그 납땜에 쓴다고 한다 [iFixit]. 이 기판의 구멍은 0.7~1.0 mm이고 다리는 그보다 가늘다. 원뿔은 끝이 아니라 옆면을 댄다 [iFixit]. TS-B2가 원뿔, TS-KU가 칼 모양이라는 것은 이름과 검색 요약 기준이다(미확인). bevel·chisel 팁(TS-BC2, TS-D24 등)은 추가 옵션으로 13,000원씩이다.
- 유연 Sn63/Pb37을 권하는 이유: 녹는점이 183 ℃로 낮아 다루기 쉽다. 무연납은 팁을 유연납보다 4~5배 빨리 산화시킨다 [Hakko]. 대신 손 씻기와 환기는 꼭 지킨다.
- 실습용납땜세트B(26,400원, 30 W)는 온도 조절 여부와 납 종류가 적혀 있지 않다 [DM-공구].

### 있으면 좋음
- ESD 핀셋 Seeed 4,400원(VAT 포함): THT에서는 없어도 되고, SMD 작업에는 필요하다.
- 이소프로필 알코올 99.9% 945 ml 28,270원(VAT 포함): 플럭스를 닦는 데 쓴다. 페이지에 인화성 주의 문구가 없으니 SDS(물질안전보건자료)를 따로 본다.
- 벤치 전원(전류를 제한할 수 있는 실험용 전원): 지금 살 수 있는 가장 싼 것은 DP30-03A(30 V/3 A) 208,000원이다(목록가, VAT 포함 여부 미확인).
- 집진기 자바석션C 244,750원(VAT 포함): 활성탄 필터이고 HEPA 표기가 없다. HSE는 HEPA 필터가 없으면 효과가 제한적이라고 한다 [HSE].

### 안전
- 로진 플럭스 연기는 직업성 천식의 주요 원인이다. 연기 위에 머리를 두지 않고, 인두를 과열하지 않고, 환기한다 [HSE].
- 납땜하는 곳에서 먹거나 마시지 않는다. 끝나면 비누와 물로 손을 씻는다. 인두는 쓰지 않을 때 항상 스탠드에 둔다 [StonyBrook].

## 7) 납땜 순서와 첫 전원 넣기 전 점검

### 온도
- 300~330 ℃에서 시작한다. Hakko는 팁 최적 온도를 '녹는점 + 50 ℃'(180 ℃ 납이면 230 ℃)로 두고, 인두 설정은 여기에 약 60~70 ℃ 또는 100 ℃를 더한다는 두 가지 경험칙을 함께 적는다(290~330 ℃) [Hakko]. SparkFun은 325~375 ℃를 권한다 [SparkFun-THT]. Sn63/Pb37의 녹는점은 183 ℃다 [DM-공구 Telecore].
- GND 패드 7곳(BT1 2번, C1 −, C2·C3의 GND 쪽, D1 캐소드, U1 1번, TP1)은 양면 GND 동박에 통째로 붙어 있어 열이 빠진다 [측정][board.py]. 써멀(가는 살로만 잇는 연결)은 SMD 기판의 스루홀 커넥터에서 KiCad DRC 오류가 나서 쓰지 않는다. 잘 녹지 않으면 팁 옆면을 넓게 대고 플럭스를 더하고 조금 더 오래 댄다. 그래도 안 되면 온도를 올린다. SparkFun은 큰 GND 패드와 도금 구멍에 더 큰 팁과 720 °F(약 382 ℃)를 쓰라고 한다 [SparkFun-THT].
- D1(LED)은 예외다. 캐소드가 GND 패드지만 온도를 올리지 않는다. 일반 LED는 유연납 기준 300 ℃까지, 한 번에 3초 이내로 대고, 팁이 렌즈에 닿지 않게 한다 [Kingbright]. 열이 모자라면 온도 대신 팁을 넓게 대서 보탠다. 산 LED의 데이터시트를 다시 본다.
- 볼트에 적힌 400 ℃는 히팅건(열풍기) 온도다. 인두 온도로 쓰지 않는다 [볼트-리볼].

### 실물 기판에서 방향 보는 법
화면의 1·+·− 표시와 패드 번호는 SchemaForge 화면에만 겹쳐 그린 것이다. 실크에는 참조 기호(R1, U1 등)와 부품 외곽선만 찍힌다 [측정]. 실크 선은 0.12 mm라 흐릴 수 있으니(2절 표) 패드 모양을 먼저 본다.

| 부품 | 실물 기판에서 볼 것 | 부품을 꽂는 법 |
|---|---|---|
| U1(소켓) | 실크 외곽선 한쪽 끝의 반달 홈 쪽, 모서리가 둥근 네모 패드가 1번 | 소켓의 홈을 거기에 맞추고, 칩의 홈·점도 같은 쪽으로 |
| C1 | 실크 원 안의 빗금 친 반쪽이 −(둥근 패드). 작은 + 표시 옆의 둥근 네모 패드가 + | 긴 다리를 + 패드에. 몸통의 '−' 띠는 빗금 쪽으로 [SparkFun-극성] |
| D1 | 실크 바깥선이 평평하게 잘린 쪽의 네모 패드가 캐소드(−) | 짧은 다리, 몸통이 깎인 쪽을 네모 패드에 [SparkFun-극성] |
| BT1 | 실크에 +/− 글자가 없다. 네모 패드가 +(VCC), 둥근 패드가 −(GND) | 납땜 전에 네모 패드 옆에 마커로 '+'를 적는다 |

**C1·BT1은 네모 패드가 +이고, D1만 네모 패드가 −(캐소드)다. '네모 = +'로 외우면 LED를 거꾸로 단다.** [측정: 패드 모양, humanReview]

### 조립 순서
화면의 **배치하기** 탭을 옆에 띄운다. 부품을 누르면서 체크하고, 방향이 있는 부품은 위 표대로 실물을 맞춘 뒤 **맞췄어요**를 누른다 [README 83]. 체크는 그 브라우저에만 남는다. 값(10k 등)은 실크에 찍히지 않으니 BOM과 배치하기 탭에서 본다 [측정].

1. 받은 기판을 눈으로 본다: 외곽, 3.2 mm 구멍 4개, 실크 기호.
2. 저항은 꽂기 전에 멀티미터로 값을 재서 구분한다. 특히 R2 68 kΩ(파랑·회색·주황)과 R3 680 Ω(파랑·회색·갈색)은 색띠가 하나만 다르다. 둘을 바꿔 달면 1.44 ÷ ((10 kΩ + 2 × 680 Ω) × 10 µF) ≈ 12.7 Hz로 빨라지고, LED 전류는 1/100인 0.074~0.104 mA로 줄어 거의 안 보인다(계산).
3. 키가 낮은 부품부터 단다: R1~R3 → C2, C3 → U1 소켓 → C1 → D1 → BT1 헤더(흔히 쓰는 순서이고, 출처는 따로 확인하지 않았다).
4. 부품마다: 다리를 꽂고 뒷면에서 살짝 벌려 고정 → 팁 옆면을 패드와 다리에 함께 대고 납땜 [SparkFun-THT] → 니퍼로 다리를 자른다(보안경 착용, 잘린 다리가 튄다 [SparkFun-THT]).
5. 칩은 아직 꽂지 않는다. 아래 점검 3번 뒤에 꽂는다.

### 첫 전원 넣기 전 점검 (배터리를 잇기 전)
1. 눈으로 본다: 옆 패드와 납이 붙은 곳(브리지), 납이 빠진 곳, 방향 4개(BT1, C1, D1, U1)가 4/4로 체크됐는지.
2. 멀티미터를 연속성 모드에 두고 전원 없이 잰다. 몇 Ω 미만이면 부저가 울리고, 그러면 두 점이 이어져 있다는 뜻이다 [SparkFun-멀티미터]. UT120C는 20 Ω 아래에서 울린다 [lygte].
   - 이번에 만든 기판은 TP2가 VCC(+), TP1이 GND다 [측정]. BT1 네모 패드와 TP2 사이가 울리는지 본다(BT1 + = 네모 패드 = TP2 쪽).
   - 처음에 짧게 '삑' 하고 멈추면 커패시터가 충전되는 것이라 정상이다 [SparkFun-멀티미터].
3. 칩을 꽂기 전에 VCC–GND(TP2–TP1)를 저항 모드로 잰다. 칩이 없으면 이 사이에는 커패시터만 있다(C3 100 nF, R1·R2를 거친 C1 10 µF) [ne555_blink.py]. 숫자가 올라가다가 OL이 되면 정상이다. C1이 78 kΩ을 거쳐 충전되므로 몇 초 걸릴 수 있다(어림). 계속 0 Ω 근처면 쇼트다.
4. 전원을 끈 채 칩을 소켓에 꽂는다. 이제는 VCC–GND가 kΩ대로 읽혀도 정상일 수 있다. NE555 안에는 VCC 쪽에 저항 분압기가 있다(TI 블록도, 값은 표기 없음 → 미확인) [TI-555]. 쇼트의 기준은 연속성 부저가 계속 울리는 것이다.
5. 배터리 극성을 본다. 멀티미터를 DC V 모드로 두고 빨간 프로브를 스냅의 빨간 선, 검은 프로브를 검은 선에 대 +9 V 근처로 읽히는지 본다. 이 회로에는 역극성 보호 다이오드가 없다 [ne555_blink.py]. 거꾸로 이으면 NE555와 C1에 9 V가 반대로 걸린다.
6. 전류를 제한하며 처음 켠다. 벤치 전원이 있으면 9 V, 전류 제한 50~100 mA로 시작한다. 제한에 걸렸는데 전압이 0 V 가까이 떨어지면 쇼트다 [Altium].
   - 벤치 전원이 없으면 220 Ω 저항을 직렬로 넣는다. 빨간 선 → 악어클립 → 220 Ω → 악어클립 → BT1 네모 패드 쪽 핀, 검은 선 → 악어클립 → BT1 둥근 패드 쪽 핀. 두 클립이 서로 닿지 않게 한다.
   - 쇼트면 9 V ÷ 220 Ω ≈ 41 mA로 제한된다. 이때 저항은 약 0.37 W를 내서 0.25 W 저항이 뜨거워지니 몇 초 안에 뗀다(계산).
   - 정상 소비를 15 mA로 가정하면 저항에서 3.3 V가 떨어져 기판 전압은 약 5.7 V다(계산). 기대 소비는 LED 7.35~10.4 mA [측정: 동작 검사]에 NE555 전류를 더한 값이다. NE555 전류는 TI 표에 5 V에서 일반 2~3 mA, 15 V에서 일반 9~10 mA이고 9 V 값은 없다 [TI-555].
   - TP2–TP1 전압을 DC V로 잰다. 4.5 V(NE555 권장 최소 [TI-555]) 이상이고 LED가 깜빡이면 정상이다. 1 V 아래면 쇼트를 의심하고 바로 뗀다. 이 방법은 옴의 법칙 계산이고, 권하는 문서는 이번에 확인하지 않았다.
   - mA 모드 직렬로 전류를 볼 수도 있지만 관찰용이고 출처 있는 절차가 아니다. 끝나면 프로브를 전압 단자로 되돌린다. mA 단자에 꽂은 채 전원 양단에 대면 퓨즈가 탄다고 SparkFun은 경고한다 [SparkFun-멀티미터]. UT120C는 PTC로 보호하고 정격은 리뷰에 없다 [lygte].
7. 정상이면 220 Ω을 빼고 배터리를 악어클립으로 바로 잇는다. 성공하면 LED가 대략 1초에 한 번(약 0.8~1.2 Hz) 깜빡인다. 설계값은 0.986 Hz, 켜짐 비율 53%다 [측정]. 범위는 C1 오차를 흔히 쓰는 ±20%로 가정해 0.986 ÷ 1.2 ≈ 0.82 Hz ~ 0.986 ÷ 0.8 ≈ 1.23 Hz로 계산했다. 실제 오차는 산 커패시터의 데이터시트로 확인한다(미확인).

## 8) 잘 안 될 때

| 증상 | 할 일 |
|---|---|
| 설명으로 회로를 만들면 429 오류 | 배포 서버의 OpenAI 크레딧이 떨어진 것이다. 데모를 쓰거나 로컬 개발 서버의 Code 탭에서 skidl을 실행한다. Code 탭 실행은 로그인해야 켜진다 [화면 1152, CodeEditor 263]. 로컬 서버에 Supabase가 없으면(/health가 db:false) 화면 위쪽의 **로그인**에 아무 이메일과 비밀번호를 넣어도 들어가진다. 비밀번호를 검사하지 않으니 실제 비밀번호는 넣지 않는다 [server/index.ts:235-242] |
| 배포 서버에서 거버 링크가 안 받아짐 | 서버가 잠들면서 파일이 지워졌을 수 있다. PCB 생성부터 다시 한다 [DEPLOY 23]. 처음 열 때 응답이 없으면 깨는 중이니 1분쯤 기다린다 [DEPLOY 22] |
| PCB 생성이 '반복 0'에서 멈춤 | 창을 앞에 띄운다. 재생 시계가 숨긴 창에서 멈췄을 가능성이 크다(1절 주의, 미확인) |
| '제작 전 부품 확인 필요' 배너 | 가정한 부품(예: MMBT3904)을 사거나 'THT로 다시 만들기'를 누른다 [화면 920-947] |
| 배너에 'D1(다이오드)의 다리 2개가 기판에 놓인 부품 모양에 없습니다' | 그 다리의 연결이 기판에 없으니 그대로 주문하지 않는다. 다리가 4개인 다이오드는 브리지 정류기다. 회로를 다시 생성해 브리지 정류기 부품(SMD는 MB6S, THT는 DF06M 다리 배열)으로 받은 뒤 PCB를 만든다 [src/lib/fixes.ts missingLegs] |
| 업로드 후 외곽선이 없다고 나옴 | zip에 `-Edge_Cuts.gm1`이 있는지 본다 |
| 탭 줄에 **↓ 거버 zip**이 안 보임 | 창이 좁으면 탭 줄 오른쪽 버튼이 가로 스크롤 영역에 숨는다. 아래 서랍 **Netlist** 탭의 GERBER 패널에서 **↓ zip 한 번에 받기**를 누른다 |
| 업로드 미리보기에 GND 면이 없음, 드릴 경고 | 2026-10-29 수정 전에 받은 거버일 수 있다. PCB 생성부터 다시 하고 zip을 새로 받는다 |
| 실크가 흐림 | 선 굵기 0.12 mm 때문일 수 있다. 동작과는 상관없다 |
| 다리가 구멍에 안 들어감 | 다리 간격과 굵기를 본다. 예: 1N4007(DO-41)은 다리가 0.71~0.86 mm라 DO-35 자리(구멍 0.8 mm)에 안 들어갈 수 있다(검색 요약, 미확인). relay·motor 데모 이야기이고, ne555에는 다이오드가 없다 |
| 옆 패드와 납이 붙음 | 솔더윅을 누르지 말고 미끄러지듯 대서 납을 걷어 낸다 [볼트-리볼]. 다시 녹일 때는 코어 플럭스가 이미 타 버렸으니 플럭스를 새로 바른다(SparkFun 글 검색 요약, 미확인) |
| LED가 안 켜지거나 아주 흐림 | D1 방향(네모 패드 = 캐소드), C1 방향, U1 1번 위치를 본다. R2와 R3이 바뀌었는지 저항값을 잰다. 배터리 전압(TP2–TP1)이 4.5 V 이상인지 잰다. 그다음 점검 2번을 다시 한다 |
| 전원을 넣자 부품이 뜨거움 | 바로 배터리를 떼고 점검 2~3번으로 돌아간다 |

2026-10-29 앱 수정: 거버 zip 한 번에 받기, 동박 채운 거버, 도금·비도금 드릴 분리, 동박 간격 0.5 mm(전에는 0)를 반영했다. 이 가이드의 순서는 수정된 앱 기준이다.

## 출처 (웹은 모두 2026-10-29 열람)

- [README] C:\SchemaForge\README.md:289-296(알려진 제약), :83(배치하기), :97-120(동작 검사)
- [측정] 2026-10-29 로컬 API(http://localhost:8080, KiCad 10.0.6)로 데모 기판 6개를 만들어 측정. 측정에 쓴 기판·거버는 server/outputs와 임시 폴더에 만든 파일이라 저장소에는 없다. 앱 수정 뒤 ne555 THT를 다시 만들어 zip 안 파일 9개, 동박 영역(위 2·아래 1), 도금·비도금 드릴 분리를 확인했다.
- [ne555_blink.py] C:\SchemaForge\server\test_circuits\ne555_blink.py / [partSpecs] C:\SchemaForge\src\lib\partSpecs.ts:45, 145-151
- [코드-배선] C:\SchemaForge\server\pcb\router.py:24-33 / [코드-동박][board.py] server\pcb\board.py (HEADER, write_kicad_pcb의 zone 블록, POUR_CLEARANCE)
- [코드-거버] C:\SchemaForge\server\index.ts의 /generate_gerber, server\pcb\fab_export.py / [run_checks] server\pcb\run_checks.py 5·6·6b 항목 / [화면] src\components\ResultPanel.tsx(줄 번호는 2026-10-29 기준이라 조금 어긋날 수 있다) / [CodeEditor] src\components\CodeEditor.tsx
- [BoardView] src\components\BoardView.tsx / [boardChecks] src\lib\boardChecks.ts
- [BOM] src\lib\bom.ts:5-11, 274-293, src\components\BomTable.tsx:111, 135 / [BomTable] src\components\BomTable.tsx / [humanReview] src\lib\humanReview.ts:30-44, server\pcb\footprints_table.py:11-12, 34
- [DEPLOY] C:\SchemaForge\DEPLOY.md
- [TI-555] https://www.ti.com/lit/ds/symlink/ne555.pdf (SLFS022K, 2026-03 개정. 5.3 권장 동작 조건, 5.5 Supply current, 6.2 블록도)
- [IPC-계산기] https://www.advancedpcb.com/en-us/tools/trace-width-calculator/ (식 I = 0.048 × ΔT^0.44 × A^0.725)
- [JLC-능력] https://jlcpcb.com/capabilities/pcb-capabilities
- [JLC-견적] https://cart.jlcpcb.com/quote
- [JLC-KiCad] https://jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-kicad-9 (요약 모델을 거쳐 읽음)
- [PCBWay-능력] https://www.pcbway.com/capabilities.html
- [PCBWay-견적] https://www.pcbway.com/orderonline.aspx , https://www.pcbway.com/QuickOrderOnline.aspx
- [PCBWay-KiCad옛] https://www.pcbway.com/blog/help_center/Generate_Gerber_file_from_Kicad.html (2017-07-03 글)
- [환율] https://open.er-api.com/v6/latest/USD (1 USD = 1,326.806219원, 2026-10-28 00:02 UTC 갱신값)
- [DM-PCB] https://www.devicemart.co.kr/goods/maker?custom=pcb
- [DM-배송] https://www.devicemart.co.kr/goods/view?no=27634 / [DM-해외] https://www.devicemart.co.kr/goods/view?no=6602665 / [DM-소켓] https://www.devicemart.co.kr/goods/view?no=2798
- [DM-공구] https://www.devicemart.co.kr/goods/view?no=번호 형식이고, 번호는 13912409(SQ-001, 어댑터·팁 옵션), 36981(FX-888DX), 1328324(Telecore), 1077790(HS02), 12138733(핀셋), 12539550(BB469), 1274074(IPA), 12219144(자바석션C), 10894366(실습용세트B), 2598(니퍼 CN-160), 2313(HAKKO 599B) / 솔더윅 목록 https://www.devicemart.co.kr/goods/catalog?code=0012000100010006 / UT120C https://www.devicemart.co.kr/goods/brand?code=1310 / 전원 목록 https://www.devicemart.co.kr/goods/catalog?code=001300030001
- [DM-실납목록] https://www.devicemart.co.kr/goods/catalog?code=0012000100010001
- [엘레파츠] https://eleparts.co.kr/goods/view?no=251 , https://eleparts.co.kr/goods/view?no=7476223
- [DigiKey] https://www.digikey.kr/ko/help-support/delivery-information/international-shipping-rates
- [관세청-계산] https://www.customs.go.kr/kcs/ad/tax/BuyTaxCalculation.do?mode=add
- [관세청-FAQ] https://www.customs.go.kr/call/ad/crmcc/selectFaqViewPage.do?mi=6822&cnslKnwlSrno=463
- [정책-배제] https://www.korea.kr/news/policyNewsView.do?newsId=148907365 (2022-10-24 글)
- [정책-유효기간] https://www.korea.kr/news/policyNewsView.do?newsId=148958140 (2026-01-22 글)
- [부호-의무] https://m.korea.kr/briefing/pressReleaseView.do?newsId=156421493 (2020-11-18 보도자료)
- [합산] https://www.customs.go.kr/kcs/na/ntt/selectNttInfo.do?mi=2891&nttSn=10069842&nttSnUrl=search
- [기사-인증] https://www.taxwatch.co.kr/article/tax/2026/08/24/0004 / [HS] https://seenthis.kr/hscode/1075
- [Adafruit] https://learn.adafruit.com/adafruit-guide-excellent-soldering/tools
- [iFixit] https://www.ifixit.com/Wiki/Soldering_Iron_Tips
- [SparkFun-THT] https://learn.sparkfun.com/tutorials/how-to-solder-through-hole-soldering/all
- [SparkFun-극성] https://learn.sparkfun.com/tutorials/polarity/all
- [SparkFun-멀티미터] https://learn.sparkfun.com/tutorials/how-to-use-a-multimeter/all
- [Hakko] https://www.hakko.co.uk/?p=4397 / [Kingbright] https://www.kingbrightusa.com/webimages/2021/ecatalog/files/basic-html/page74.html
- [Altium] https://resources.altium.com/p/expert-tips-safely-powering-your-new-pcb-first-time
- [HSE] https://www.hse.gov.uk/asthma/solderers.htm / [StonyBrook] https://www.stonybrook.edu/ehs/safety-information/Safety-Guide-Soldering-Safety.html
- [lygte] https://lygte-info.dk/review/DMMUNI-T%20UT120C%20UK.html
- [볼트] C:\brain\me\profile.md:26, 105, 125 / C:\brain\wiki\sources\src-yt-soldering-reballing-kit.md:67
- [볼트-장비] C:\brain\me\profile.md:153 / [볼트-로드맵] C:\brain\wiki\roadmap.md:42, C:\brain\wiki\sources\src-cyberdeck-cm5-build.md:145
- [볼트-리볼] C:\brain\wiki\sources\src-yt-soldering-reballing-kit.md:27, 34, 44, 55, 74
