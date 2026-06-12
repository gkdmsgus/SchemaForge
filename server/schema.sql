-- SchemaForge Supabase Schema
-- Supabase Dashboard > SQL Editor 에서 실행

-- sessions 테이블
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  code        TEXT,
  guide       TEXT,
  graph       JSONB,
  filename    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- chat_messages 테이블
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  actions     JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- favorites 테이블
CREATE TABLE IF NOT EXISTS favorites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, session_id)
);

-- RLS (Row Level Security) 활성화
ALTER TABLE sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites     ENABLE ROW LEVEL SECURITY;

-- sessions 정책: 비로그인은 자신의 익명 세션도 못 읽음 (서버에서 service_role로 접근)
CREATE POLICY "sessions_owner" ON sessions
  USING (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "sessions_insert" ON sessions
  FOR INSERT WITH CHECK (true);

-- chat_messages: 세션 소유자만 접근
CREATE POLICY "messages_via_session" ON chat_messages
  USING (session_id IN (
    SELECT id FROM sessions WHERE user_id = auth.uid() OR user_id IS NULL
  ));

CREATE POLICY "messages_insert" ON chat_messages
  FOR INSERT WITH CHECK (true);

-- favorites: 본인 것만
CREATE POLICY "favorites_owner" ON favorites
  USING (user_id = auth.uid());

CREATE POLICY "favorites_insert" ON favorites
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- 인덱스
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_session_idx ON chat_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS favorites_user_idx   ON favorites (user_id, created_at DESC);
