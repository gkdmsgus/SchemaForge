# SchemaForge 배포 가이드 (Render 무료 인스턴스)

## 0. 배포 서버가 막는 것

이미지는 `NODE_ENV=production`으로 돈다 (`Dockerfile`). 이때 서버는 아래처럼 나눠서 연다 (`server/deploy_guard.ts`, 검사 `server/check_deploy_guard.ts`).

| 누가 | 쓸 수 있는 것 |
|---|---|
| 누구나 (로그인 없이) | 데모 (`/?demo=led`, `ne555`, `relay`, `motor`), 기판 만들기, 3D, 거버 내려받기 |
| `ALLOWED_EMAILS`에 있고 가입 확인 메일을 누른 Supabase 계정 | 위 + 설명으로 회로 생성, AI 편집, Code 탭 실행, AI 다듬기, BOM의 Mouser 가격 조회 |

- 코드 실행은 서버의 키를 읽을 수 있고(`/proc`), 모델 호출은 돈이 든다. 그래서 둘 다 허용한 계정만 쓴다. Mouser 가격 조회도 줄마다 운영자 키의 한도를 써서 같은 계정만 쓰고, 다른 방문자에게는 BOM의 검색 링크가 남는다.
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

1. [supabase.com](https://supabase.com)에서 프로젝트를 만든다. 리전은 Render와 같은 **Southeast Asia (Singapore)** (로그인 확인은 서버가 Supabase에 묻는다). 만들 때 Security의 "Automatically expose new tables"는 끄고 "Enable automatic RLS"는 켠다.
2. **SQL Editor**에 `server/schema.sql` 전체를 붙여 넣고 실행한다. 여러 번 실행해도 된다. 2026-05 이후 새 프로젝트는 표 권한을 자동으로 주지 않아서, 이 파일의 GRANT가 없으면 기록·즐겨찾기가 "permission denied"로 실패한다. 예전 schema.sql을 실행한 프로젝트도 다시 실행한다 (`sessions.name` 열과 권한).
3. **Authentication → Sign In / Providers**에서 **Confirm email이 켜져 있는지** 확인한다 (호스팅 프로젝트 기본값). 끄면 가입하자마자 확인된 계정이 되어, 남의 주소로 가입해도 `ALLOWED_EMAILS`를 통과한다.
4. **Authentication → URL Configuration**의 Site URL을 공개 주소 `https://schemaforge-app.duckdns.org`(젯슨, 7절)로 바꾸고, Redirect URLs에 `https://schemaforge-app.duckdns.org/**`를 넣는다. 기본값 `http://localhost:3000`이면 확인 메일 링크가 열리지 않는다. Render와 젯슨이 Supabase 프로젝트 하나를 함께 쓰고 서버가 돌아갈 주소를 따로 주지 않으므로, 어느 주소에서 가입해도 확인 메일의 링크는 이 주소로 간다 (2026-11-08까지는 `https://schemaforge.kro.kr`).
5. Supabase 기본 메일은 **조직 멤버 주소로만, 시간당 2통** 보낸다. 그래서 `ALLOWED_EMAILS`에는 Supabase 계정 메일을 넣고 그 주소로 가입한다. 다른 사람도 가입하게 하려면 Authentication → SMTP에 메일 서버를 붙인다.
6. Render 서비스의 **Environment** 페이지에 아래 값을 넣고 저장해 다시 배포한다. 키 값은 `render.yaml`에 절대 쓰지 않는다. 로그에 `[guard] deployed: code runs and model calls for 1 listed account(s)`가 나오고 `none until Supabase is set`이 붙지 않으면 맞다.
7. `https://schemaforge-app.duckdns.org`에서 가입 → "확인 메일을 보냈습니다" 안내 → 메일의 링크 → "가입 확인이 끝났습니다" → 로그인 → 회로 생성 순서로 확인한다.
8. OpenAI 대시보드에서 월 사용 한도를 걸어 둔다.

무료 인스턴스(CPU 0.1)에서는 회로 생성과 AI 다듬기도 느리다는 점을 감안한다. Supabase 무료 프로젝트는 7일 동안 활동이 적으면 멈춘다. 멈추면 로그인이 "로그인 서버(Supabase)에 연결하지 못했습니다"로 실패하니, 대시보드에서 Resume project로 다시 켠다.

## 3. 환경 변수

| 변수 | 필요 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | 회로 생성 | 없으면 데모만 동작. 다른 회사 모델을 쓰면 그 회사 키 |
| `OPENAI_BASE_URL` | 선택 | OpenAI 대신 OpenAI 호환 API. xAI Grok은 `https://api.x.ai/v1` |
| `SF_MODEL` | 선택 | 회로 코드 모델 (기본 `gpt-4o`). Grok이면 예: `grok-4.3` |
| `SF_MODEL_MINI` | 선택 | 되묻기·계획·AI 편집·AI 다듬기 모델 (기본 `gpt-4o-mini`). Grok이면 예: `grok-4.3` |
| `SF_REASONING_EFFORT` | 선택 | 모든 모델 호출에 보내는 `reasoning_effort`. `grok-4.3`이면 `none` (추론 토큰이 답 길이 한도를 먹지 않게) |
| `SUPABASE_URL` | 로그인 | 프로젝트 첫 화면이나 Connect 창의 `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | 로그인 | Settings → API Keys의 Secret key (`sb_secret_…`, 비밀). 서버는 이 키로만 표에 접근한다 |
| `ALLOWED_EMAILS` | 회로 생성 | 쉼표로 구분한 메일 주소. 대소문자·공백은 무시 |
| `FRONTEND_URL` | 선택 | 다른 주소의 화면이 API를 부를 때 그 화면의 주소 하나 (CORS). 배포 서버는 이 값이 없으면 다른 주소의 화면에 응답을 열어 주지 않는다. 화면과 API가 같은 주소면 없어도 된다 |
| `MOUSER_API_KEY` | 선택 | BOM 가격·재고 조회. 없으면 검색 링크만 |
| `SF_JOB_SLOTS` | 선택 | 무거운 작업(기판·AI 다듬기 라운드·3D·거버·회로 점검)을 한 번에 몇 개까지 돌릴지 (기본 4). 나머지는 16개까지 줄을 서고, 넘치거나 60초 넘게 기다리면 "잠시 뒤에" 안내(503, `Retry-After: 15`). 한 방문자는 2개 돌고 4개 기다린다. `/health`의 `jobs`로 지금 상태를 본다 |
| `PORT` | 자동 | `render.yaml`이 10000으로 정한다 (이미지 기본값 8002, 로컬 개발 기본값 8113) |

방문자를 나누는 주소: 서버는 바로 앞 프록시 하나만 믿고(`trust proxy` 1) `X-Forwarded-For`의 마지막 주소를 방문자로 본다. 젯슨은 앞의 Caddy가 그 주소를 붙인다고 보고 맞췄다(젯슨에서는 확인하지 않음). Render는 앞에 프록시가 더 있을 수 있어(확인하지 않음), 그러면 방문자들이 프록시 주소 하나로 묶여 한 방문자 몫(2개 실행·4개 대기)을 나눠 쓴다. 바쁘다는 안내가 잦으면 `/health`의 `jobs`를 먼저 본다.

## 4. 이미지를 로컬에서 먼저 확인

```bash
docker build -t schemaforge:local .
docker run --rm --cpus=0.1 --memory=512m --memory-swap=512m -p 8114:8002 schemaforge:local
```

무료 인스턴스와 같은 제한으로 띄운다. `http://localhost:8114/?demo=motor`에서 PCB → 3D → 거버까지 되는지 본다. 키를 넣지 않았으니 회로 생성은 거절되는 것이 맞다. 이미지 검사는 `python server/pcb/check_deploy.py` (README 검사 절).

## 5. 로컬 개발

```bash
cp server/.env.example server/.env   # 값 채우기 (vite 프록시는 PORT 값을 따른다)
npm run dev                          # 화면 3000 + API 8113
```

개발 모드(`NODE_ENV`가 production이 아님)에서는 0절의 제한이 없다.

## 6. 유료로 옮길 때 (Railway)

`railway.json`이 남아 있어 Railway Hobby 플랜(월 5달러, 이미지 한도 100 GB)에서는 `railway up`으로 같은 이미지를 올릴 수 있다. Trial·Free 플랜은 이미지 한도가 4 GB라 이 이미지(압축 전 약 4.3 GB)가 넘을 수 있다 ([Railway 플랜 표](https://docs.railway.com/pricing/plans)).

## 7. 젯슨 (집 서버)

`https://schemaforge-app.duckdns.org`는 집의 젯슨(ARM64)에서 돈다. 이미지는 `Dockerfile.jetson`(KiCad 10 PPA, `KICAD_EXPECT` 10.0.8)으로 만들고, 앞에서 Caddy가 HTTPS를 맡는다. 컨테이너는 이 기계에만(`127.0.0.1:8002`) 열린다.

### 빌드와 실행

젯슨의 저장소 폴더에서 한다.

```bash
git pull
scripts/jetson_run.sh              # 빌드 → 돌던 이미지를 schemaforge:jetson-prev로 → 새 컨테이너 → /health 확인
scripts/jetson_run.sh --no-build   # 빌드 없이 지금 이미지로 다시 띄운다 (env 파일을 바꾼 뒤)
scripts/jetson_run.sh --rollback   # schemaforge:jetson-prev로 돌아간다
```

새 이미지는 `/health`가 `"kicad":"10.0.8"`을 말해야 뜬 것으로 본다(2초 간격 60번, 120초까지). 뜨지 않으면 스크립트가 `schemaforge:jetson-prev`를 다시 띄우고 exit 1로 끝난다. 그때는 배포가 된 것이 아니다. 스크립트가 함께 보여 주는 `docker logs --tail 30 schemaforge`를 보고 고친 뒤 다시 돌린다. PPA에서 다른 KiCad가 오면 빌드가 멈추고 그 버전을 말한다. 그 버전으로 `python server/pcb/check_deploy.py --dockerfile Dockerfile.jetson`이 통과한 뒤에 `KICAD_EXPECT`를 바꾼다.

컨테이너 제한은 메모리 2 GB(`MEMORY`), 코어 4개(`CPUS`), 프로세스 512개, Linux 권한 없음, 로그 10 MB × 3개다.

### 키: `~/schemaforge.env`

`chmod 600 ~/schemaforge.env`. 값은 이 문서에도 저장소에도 적지 않는다. 들어가는 이름은 이렇다 (뜻은 3절 표).

- `OPENAI_API_KEY` (다른 회사 모델이면 `OPENAI_BASE_URL`, `SF_MODEL`, `SF_MODEL_MINI`, `SF_REASONING_EFFORT`도)
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `ALLOWED_EMAILS`
- `FRONTEND_URL=https://schemaforge-app.duckdns.org`
- `SF_JOB_SLOTS` (선택. 기판·DRC·3D·거버처럼 무거운 작업을 동시에 몇 개 돌릴지. 기본 4, 컨테이너의 코어 4개에 맞춘 값)
- `MOUSER_API_KEY` (선택)

`PORT`와 `NODE_ENV`는 파일에 있어도 스크립트가 8002와 production으로 덮는다. 파일을 고친 뒤에는 `scripts/jetson_run.sh --no-build`로 다시 띄운다.

### Caddy: `~/Caddyfile.sf` 적용

`~/Caddyfile.sf`는 지금 쓰는 `/etc/caddy/Caddyfile`에서 같은 젯슨의 다른 사이트(동글 숲 게임 주소 두 개, 친구 주소의 비밀번호 포함)를 그대로 두고, SchemaForge 사이트에 세 가지를 더한 것이다. 보안 헤더(HSTS 하루, `nosniff`, 다른 사이트 안에 넣지 못하게, CSP), Node보다 짧은 `keepalive 3s`(Node가 닫는 연결로 요청을 보내 가끔 나던 502를 막는다), 컨테이너가 내려가 있는 동안(다시 빌드, 재시작) 빈 502 대신 한국어 안내와 503이다.

친구 주소의 `basic_auth` 줄이 지금 파일과 같은지 먼저 본다. 아무것도 나오지 않아야 한다.

```bash
diff <(sudo grep -A2 basic_auth /etc/caddy/Caddyfile) <(grep -A2 basic_auth ~/Caddyfile.sf)
```

그다음 백업, 복사, 검사, 다시 읽기 순서로 한다.

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M)
sudo cp ~/Caddyfile.sf /etc/caddy/Caddyfile
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

검사는 Caddy가 도는 `caddy` 사용자로 한다. `validate`는 설정의 로그 파일까지 열어 보므로, root로 돌리면 `/var/log/caddy/schemaforge.log`가 root 것(권한 600)으로 생겨서 reload가 "permission denied"로 거절된다(2026-11-08). 그때는 Caddy가 예전 설정으로 계속 돌지만 `/etc/caddy/Caddyfile`은 이미 새 파일이라, 재부팅하면 뜨지 못한다. `sudo chown caddy:caddy /var/log/caddy/schemaforge.log` 뒤에 다시 reload한다.

`validate`가 실패하면 reload하지 않고 백업을 되돌린다(`sudo cp /etc/caddy/Caddyfile.bak-<시각> /etc/caddy/Caddyfile`). reload가 실패하면 `systemctl status caddy`의 Status 줄에 이유가 있다. 고치지 못하면 같은 방법으로 백업을 되돌리고 reload한다. reload 뒤에는 `systemctl status caddy`와 `curl -sI https://schemaforge-app.duckdns.org/ | grep -i strict-transport-security`로 새 설정이 쓰이는지 본다.

### 지금 도는 커밋

```bash
curl -s https://schemaforge-app.duckdns.org/health
```

`"commit":"<짧은 해시>"`가 이미지를 만든 커밋이다(`scripts/jetson_run.sh`가 빌드할 때 넣는다). `"unknown"`이면 이 스크립트 없이(`--build-arg SF_COMMIT` 없이) 만든 젯슨 이미지, `null`이면 그 값이 없는 서버(Render 이미지, `npm run dev`)다. 이 항목이 생기기 전에 만든 이미지는 `docker exec schemaforge printenv SF_COMMIT`로 본다.

### 옮긴 뒤 확인

멈추지 않고 할 수 있는 확인 세 가지다.

1. 불러온 설정이 파일과 같은지: `sudo caddy adapt --config /etc/caddy/Caddyfile | grep -o '"host":\[[^]]*\]'`와 `curl -s localhost:2019/config/apps/http/servers | grep -o '"host":\[[^]]*\]'`가 같은 주소 목록을 내야 한다.
2. 재부팅 뒤에도 컨테이너가 뜨는지: `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' schemaforge`가 `unless-stopped`.
3. 재부팅 뒤에 Caddy와 Docker가 켜지는지: `systemctl is-enabled caddy docker`가 둘 다 `enabled`.

재부팅 시험은 사용하는 사람이 없는 시간에 한 번 한다(선택). `sudo reboot` 뒤 대략 3분 기다렸다가 확인한다.

- `systemctl status caddy` (`--config /etc/caddy/Caddyfile`로 떠 있는지)
- `docker ps` (schemaforge가 Up, `127.0.0.1:8002`)
- `curl -s https://schemaforge-app.duckdns.org/health` (`"kicad":"10.0.8"`, `"commit"`)
- 친구 주소가 비밀번호 없이 401을 주는지
- `~/duckdns/duck2.log`에 재부팅 뒤 시각의 `OK`가 있는지
- `node scripts/check_live.mjs https://schemaforge-app.duckdns.org` (이 PC에서)
