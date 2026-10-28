# SchemaForge 배포 가이드 (Render 무료 인스턴스)

## 0. 배포 서버가 막는 것

이미지는 `NODE_ENV=production`으로 돈다 (`Dockerfile`). 이때 서버는 아래처럼 나눠서 연다 (`server/deploy_guard.ts`, 검사 `server/check_deploy_guard.ts`).

| 누가 | 쓸 수 있는 것 |
|---|---|
| 누구나 (로그인 없이) | 데모 (`/?demo=led`, `ne555`, `relay`, `motor`), 기판 만들기, 3D, 거버 내려받기 |
| `ALLOWED_EMAILS`에 있고 가입 확인 메일을 누른 Supabase 계정 | 위 + 설명으로 회로 생성, AI 편집, Code 탭 실행, AI 다듬기 |

- 코드 실행은 서버의 키를 읽을 수 있고(`/proc`), 모델 호출은 돈이 든다. 그래서 둘 다 허용한 계정만 쓴다.
- Supabase가 없으면 로그인 자체가 꺼진다. 개발용 로그인은 비밀번호를 보지 않기 때문이다.
- `ALLOWED_EMAILS`가 비어 있으면 아무도 회로 생성을 쓸 수 없다.

## 1. 첫 배포 — 키 없이 데모만

설정은 저장소 루트의 `render.yaml`(Render Blueprint)에 있다: Docker 웹 서비스 하나, 무료 인스턴스, Singapore 리전, `/health` 헬스 체크, `PORT=10000`. 문서만 바꾼 푸시(`*.md`, `docs/`)는 자동 빌드를 하지 않는다.

무료 인스턴스에서 알아 둘 것 ([Render 무료 인스턴스](https://render.com/docs/free)):

- CPU 0.1 · 메모리 512 MB, 인스턴스 하나. 15분 동안 요청이 없으면 잠들고, 다음 요청에 깨는 데 약 1분 걸린다.
- 디스크는 휘발성이라 재배포·재시작·잠들기 때 `server/outputs`가 지워진다.
- 워크스페이스 한도: 무료 인스턴스 시간 월 750시간, 외부로 나가는 트래픽 월 5 GB ([outbound bandwidth](https://render.com/docs/outbound-bandwidth)), 빌드 시간 월 500분(가격표 기준). 결제 수단 없이 트래픽을 다 쓰면 그달 말까지 무료 서비스가 모두 정지되고, 빌드 시간을 다 쓰면 새 빌드가 막힌다.

같은 제한(`--cpus=0.1 --memory=512m`)으로 묶은 로컬 컨테이너에서 확인한 것 (2026-10-21):

- 데모 5개(led, ne555, relay SMD·THT, motor)와 화면 시험 7개가 모두 통과했다. 데모 하나(넷리스트 → 기판·DRC → 3D → 거버)에 대략 40~60초 걸렸다.
- 기판·3D·거버를 만드는 동안 `/health`를 1초마다 150번 불렀고, 실패 0번, 가장 느린 응답 0.44초였다 (Render는 5초 안에 응답하지 않는 상태가 15초 이어지면 트래픽을 끊고 60초면 재시작한다).
- 메모리는 캐시까지 한도에 닿았지만 강제 종료(OOM)는 0번이었다.

순서:

1. [render.com](https://render.com)에 GitHub 계정으로 가입한다.
2. 대시보드에서 **New → Blueprint**를 누르고 `gkdmsgus/SchemaForge` 저장소를 연결한 뒤 브랜치 `master`를 고른다. Blueprint Path는 비워 둔다.
3. 변경 목록에서 `schemaforge`가 **새로 만드는** 서비스이고 Free · Singapore · Docker인지 확인한다. Singapore에서 Free를 받지 않으면 `render.yaml`의 `region`을 `oregon`으로 바꿔 다시 푸시한다 (리전은 만든 뒤 바꿀 수 없다).
4. 비밀값 6개(`sync: false`)를 묻는 화면이 나오면 비워 둔다. 데모에는 필요 없다. 나중에 넣는 값은 서비스의 **Environment** 페이지에서 넣는다.
5. 첫 빌드는 KiCad 이미지를 받느라 몇 분 걸린다. 끝나면 `node scripts/check_live.mjs https://<주소>`로 `/health` → `/?demo=motor` → PCB → 3D → 거버 내려받기를 한 번에 확인한다.

이 Blueprint는 GitHub 앱 연결 없이 공개 저장소 주소로 만들어서 자동 배포가 없다. 새 코드는 서비스 화면의 **Manual Deploy → Deploy latest commit**, `render.yaml` 변경은 Blueprint 화면의 **Manual sync**로 반영한다 (사용자 도메인 `schemaforge.kro.kr`도 이 동기화로 추가했다. 무료 인스턴스 대시보드에는 도메인 추가 칸이 없다).

## 2. 로그인과 회로 생성 열기

1. [supabase.com](https://supabase.com)에서 프로젝트를 만든다.
2. **SQL Editor**에 `server/schema.sql` 전체를 붙여 넣고 실행한다.
3. **Authentication**의 Email 로그인 설정에서 **Confirm email을 켠다.** 끄면 가입하자마자 확인된 계정이 되어, 남의 주소로 가입해도 `ALLOWED_EMAILS`를 통과한다.
4. Render 서비스의 **Environment** 페이지에 아래 값을 넣는다. 키 값은 `render.yaml`에 절대 쓰지 않는다.
5. OpenAI 대시보드에서 월 사용 한도를 걸어 둔다.

무료 인스턴스(CPU 0.1)에서는 회로 생성과 AI 다듬기도 느리다는 점을 감안한다.

## 3. 환경 변수

| 변수 | 필요 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | 회로 생성 | 없으면 데모만 동작 |
| `SUPABASE_URL` | 로그인 | Project Settings → API의 Project URL |
| `SUPABASE_SERVICE_KEY` | 로그인 | 같은 곳의 service_role 키 (비밀) |
| `ALLOWED_EMAILS` | 회로 생성 | 쉼표로 구분한 메일 주소. 대소문자·공백은 무시 |
| `FRONTEND_URL` | 선택 | CORS 허용 주소. 화면과 API가 같은 주소면 없어도 된다 |
| `MOUSER_API_KEY` | 선택 | BOM 가격·재고 조회. 없으면 검색 링크만 |
| `TAVILY_API_KEY` | 선택 | 웹 검색 |
| `PORT` | 자동 | `render.yaml`이 10000으로 정한다 (코드 기본값 8002) |

## 4. 이미지를 로컬에서 먼저 확인

```bash
docker build -t schemaforge:local .
docker run --rm --cpus=0.1 --memory=512m --memory-swap=512m -p 8002:8002 schemaforge:local
```

무료 인스턴스와 같은 제한으로 띄운다. `http://localhost:8002/?demo=motor`에서 PCB → 3D → 거버까지 되는지 본다. 키를 넣지 않았으니 회로 생성은 거절되는 것이 맞다. 이미지 검사는 `python server/pcb/check_deploy.py` (README 검사 절).

## 5. 로컬 개발

```bash
cp server/.env.example server/.env   # 값 채우기 (PORT=8080: vite 프록시가 8080을 본다)
npm run dev                          # 화면 3000 + API 8080
```

개발 모드(`NODE_ENV`가 production이 아님)에서는 0절의 제한이 없다.

## 6. 유료로 옮길 때 (Railway)

`railway.json`이 남아 있어 Railway Hobby 플랜(월 5달러, 이미지 한도 100 GB)에서는 `railway up`으로 같은 이미지를 올릴 수 있다. Trial·Free 플랜은 이미지 한도가 4 GB라 이 이미지(압축 전 약 4.3 GB)가 넘을 수 있다 ([Railway 플랜 표](https://docs.railway.com/pricing/plans)).
