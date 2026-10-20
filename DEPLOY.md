# SchemaForge 배포 가이드 (Railway)

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

플랜: 이미지가 약 4.3 GB(압축 전)라 이미지 한도 4 GB인 Trial·Free 플랜으로는 올라가지 않을 수 있다 (한도를 압축 전 크기로 재는지는 확인하지 못했다). Hobby는 100 GB다 ([Railway 플랜 표](https://docs.railway.com/pricing/plans)). 로컬 컨테이너에서 데모·3D·거버를 돌렸을 때 메모리는 최대 약 486 MB였다.

```bash
railway login                     # 브라우저에서 로그인
railway init --name schemaforge   # 프로젝트 만들기 (루트에서)
railway up                        # 지금 폴더를 올려 Dockerfile로 빌드 (.gitignore에 있는 파일은 올라가지 않는다)
railway domain                    # 공개 주소 만들기 (*.up.railway.app)
```

확인 순서: `https://<주소>/health`에서 `kicad` 버전이 나오는지 → `https://<주소>/?demo=motor` → PCB 만들기 → 거버 내려받기.

## 2. 로그인과 회로 생성 열기

1. [supabase.com](https://supabase.com)에서 프로젝트를 만든다.
2. **SQL Editor**에 `server/schema.sql` 전체를 붙여 넣고 실행한다.
3. **Authentication**의 Email 로그인 설정에서 **Confirm email을 켠다.** 끄면 가입하자마자 확인된 계정이 되어, 남의 주소로 가입해도 `ALLOWED_EMAILS`를 통과한다.
4. Railway 서비스의 **Variables** 탭에 아래 값을 넣는다. 키 값은 대시보드에 직접 넣는 것이 안전하다 (명령줄에 쓰면 셸 기록에 남는다).
5. OpenAI 대시보드에서 월 사용 한도를 걸어 둔다.

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
| `PORT` | 자동 | Railway가 넣는다 |

## 4. 이미지를 로컬에서 먼저 확인

```bash
docker build -t schemaforge:local .
docker run --rm -p 8002:8002 schemaforge:local
```

`http://localhost:8002/?demo=motor`에서 PCB → 3D → 거버까지 되는지 본다. 키를 넣지 않았으니 회로 생성은 거절되는 것이 맞다.

## 5. 로컬 개발

```bash
cp server/.env.example server/.env   # 값 채우기 (PORT=8080: vite 프록시가 8080을 본다)
npm run dev                          # 화면 3000 + API 8080
```

개발 모드(`NODE_ENV`가 production이 아님)에서는 0절의 제한이 없다.
