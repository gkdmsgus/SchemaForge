# SchemaForge — 작업 지침

회로를 말로 설명하면 넷리스트 → 회로도 → 2층 PCB → KiCad DRC → 거버까지 만드는 웹 앱. 혼자 개발하는 공개 저장소(github.com/gkdmsgus/SchemaForge).
자세한 소개는 `README.md`, 계획·일정은 `docs/project-plan.md`.

## 구조
- `src/` 화면 (React 19 + TypeScript + Vite + SCSS). 기판 화면 `components/BoardView.tsx`, 3D `components/KiCad3DViewer.tsx`
- `server/index.ts` API · 생성 단계 SSE 스트리밍 · KiCad 호출 / `server/ai_layout.ts` AI 다듬기 루프
- `server/pcb/` Python: `board.py`(배치→배선→동박→구멍) · `placer.py`(힘 기반) · `router.py`(A*) · `erc.py`(회로 점검) · `footprints/`(KiCad 벤더 풋프린트 사본 — 손으로 고치지 않는다)
- `server/test_circuits/` 검사·데모 회로 / `dev/board.html` 로그인 없이 기판 화면만 띄우는 개발 페이지

## 명령
```bash
npm run dev            # 화면 3000 + API (vite 프록시는 8080을 본다 → server/.env 에 PORT=8080. 코드 기본값은 8002)
npm test               # 모델 없이 도는 검사 전부: 타입(화면·서버) → AI 판정 규칙 → ERC 자동 수정 판정 → 배포 서버 차단 → Code 탭·BOM·배치하기·방향 확인·경고 해결책 → 기판 8개 × 19항목 (몇 분 걸림, KiCad 필요)
npm run test:types     # 타입만 (빠름)
npm run lint
```
데모(키 없이): `http://localhost:3000/?demo=motor` (`led`, `ne555`, `relay`). AI 루프 검사는 `SF_AI_STUB=1`로 모델 없이 (`README.md` 검사 절).

## 지킬 것
- **AI는 제안만, 적용·판정·되돌리기는 코드가 한다.** 점수 순서(`server/ai_layout.ts`의 `better()`: DRC 오류 → 미배선 → 겹침 → 기판 밖 → 디커플링 거리(1 mm 이상 변할 때만) → 좁은 전원선 → 선 길이(HPWL) → 비아 → 트랙 길이)를 바꾸면 `server/check_ai_layout.ts`에 검사 항목을 같이 추가한다
- 검사가 실패하거나 시간 초과면 "통과"로 세지 않는다 (DRC 시간 초과를 오류 0으로 읽던 버그 이력)
- 핀 매핑은 (부품, 핀 번호) → 패드 표로만. 표에 없으면 조용히 대체하지 말고 unmapped로 보고
- 코드를 바꾸면 같은 작업 안에서 `npm test`(최소 `npm run test:types`)를 돌리고 결과를 보고한다. 화면을 바꾸면 데모 URL로 직접 확인한다
- `server/.env`, 키 값은 커밋하지 않는다. 배포 이미지에 `.env`가 들어가지 않게 `.dockerignore` 유지
- 커밋은 작게(대략 300줄 이하), 기능과 그 검사를 같은 커밋에. 푸시는 사용자 확인 후
- 데모 기판은 제작용이 아니다 (README "알려진 제약": 트랜지스터 핀 배열, 모터 전류 정격)
