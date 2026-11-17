-- SchemaForge Supabase Schema
-- Supabase Dashboard > SQL Editor 에서 실행. 여러 번 실행해도 됩니다 (이미 있는 표·열·인덱스는 그대로 둡니다).
-- 이 표들은 서버만 secret(service_role) 키로 읽고 씁니다. 서버가 쿼리마다 user_id로 주인을 확인합니다.
-- 브라우저용 키(anon, authenticated)는 권한을 빼고 정책도 두지 않아서 어떤 행에도 닿지 못합니다.

-- sessions 테이블
CREATE TABLE IF NOT EXISTS public.sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  code        TEXT,
  guide       TEXT,
  graph       JSONB,
  filename    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 기록 이름 바꾸기 (PATCH /sessions/:id). 비어 있으면 화면은 prompt를 보여 줍니다.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS name TEXT;

-- chat_messages 테이블
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  actions     JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- favorites 테이블
CREATE TABLE IF NOT EXISTS public.favorites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, session_id)
);

-- feedback 테이블: 화면의 '의견' 버튼으로 받은 별점과 의견 (POST /feedback, 로그인 없이).
-- 누가 보냈는지(계정, IP 주소, 브라우저)는 저장하지 않습니다. 길이는 서버가 먼저 확인하고, 여기서 한 번 더 막습니다.
CREATE TABLE IF NOT EXISTS public.feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT CHECK (char_length(comment) <= 500),
  circuit     TEXT CHECK (char_length(circuit) <= 80),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 권한: 새 프로젝트는 public 표에 GRANT를 자동으로 주지 않으므로 서버(service_role)에 직접 줍니다.
-- 오래된 프로젝트가 anon·authenticated에 자동으로 준 권한은 뺍니다.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions, public.chat_messages, public.favorites, public.feedback TO service_role;
REVOKE ALL ON TABLE public.sessions, public.chat_messages, public.favorites, public.feedback FROM anon, authenticated;

-- RLS (Row Level Security) 활성화. service_role은 RLS를 건너뛰고, 다른 역할은 정책이 없어 행을 못 봅니다.
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback      ENABLE ROW LEVEL SECURITY;

-- 예전 schema.sql이 만든 정책을 지웁니다. 'user_id IS NULL'·'WITH CHECK (true)'가 anon에게도 열려 있었습니다.
DROP POLICY IF EXISTS "sessions_owner"       ON public.sessions;
DROP POLICY IF EXISTS "sessions_insert"      ON public.sessions;
DROP POLICY IF EXISTS "messages_via_session" ON public.chat_messages;
DROP POLICY IF EXISTS "messages_insert"      ON public.chat_messages;
DROP POLICY IF EXISTS "favorites_owner"      ON public.favorites;
DROP POLICY IF EXISTS "favorites_insert"     ON public.favorites;

-- 인덱스
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON public.sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_session_idx ON public.chat_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS favorites_user_idx   ON public.favorites (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_time_idx    ON public.feedback (created_at DESC);
