# SchemaForge v2 배포 가이드

## 1. Supabase 설정

1. [supabase.com](https://supabase.com) → New project 생성
2. **Project Settings → API** 에서 복사:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key (secret) → `SUPABASE_SERVICE_KEY`
3. **SQL Editor** → `server/schema.sql` 전체 붙여넣고 실행

## 2. Railway 배포

```bash
# Railway CLI 설치 (이미 있으면 skip)
npm i -g @railway/cli
railway login

# 프로젝트 초기화 (루트에서)
railway init

# 환경 변수 설정
railway variables set OPENAI_API_KEY=sk-...
railway variables set SUPABASE_URL=https://xxx.supabase.co
railway variables set SUPABASE_SERVICE_KEY=eyJ...
railway variables set FRONTEND_URL=https://[your-app].up.railway.app

# 배포
railway up
```

Railway가 `Dockerfile`을 자동 감지하여 빌드합니다.

## 3. 환경 변수 목록

| 변수 | 필수 | 설명 |
|------|------|------|
| `OPENAI_API_KEY` | ✅ | OpenAI GPT-4o |
| `SUPABASE_URL` | ✅ | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase service_role key |
| `FRONTEND_URL` | 권장 | CORS origin (배포 URL) |
| `PORT` | 자동 | Railway가 자동 주입 |
| `MOUSER_API_KEY` | 선택 | Mouser 부품 검색 |
| `TAVILY_API_KEY` | 선택 | 웹 검색 |

## 4. 로컬 개발

```bash
# server/.env 생성 (server/.env.example 참고)
cp server/.env.example server/.env
# 값 채우기...

npm run dev   # Vite(5173) + Express(8002) 동시 실행
```

## 5. 프로덕션 빌드 테스트

```bash
npm run build          # React → dist/
cd server && tsx index.ts  # Express가 dist/ 정적 서빙
```
