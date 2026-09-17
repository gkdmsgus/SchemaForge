// Terms of service and privacy policy. Written from what the server actually does
// (server/index.ts): Supabase auth, the sessions/chat_messages/favorites tables,
// OpenAI calls, Mouser part search, and files kept in server/outputs.

const UPDATED = '2026-09-17'

export default function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  return (
    <main className="sf-legal">
      {kind === 'terms' ? <Terms /> : <Privacy />}
      <p style={{ marginTop: 48 }}><a href="/">처음 화면으로</a></p>
    </main>
  )
}

function Terms() {
  return (
    <>
      <h1>이용약관</h1>
      <p className="meta">최종 수정 {UPDATED} · 개인 프로젝트 베타</p>

      <h2>1. 서비스</h2>
      <p>
        SchemaForge는 회로 설명을 받아 넷리스트, 회로도, PCB 파일(.net, .kicad_pcb, 거버)을 만들어 주는
        개인 개발 프로젝트입니다. 베타 단계라 기능이 예고 없이 바뀌거나 멈출 수 있습니다.
      </p>

      <h2>2. 결과물 확인 책임</h2>
      <p>
        생성된 회로와 기판은 자동으로 만든 초안입니다. KiCad 설계 규칙 검사(DRC)를 통과해도 부품 값,
        전류 용량, 발열, 안전 규격까지 보장하지 않습니다. 제작이나 전원 인가 전에 직접 검토해 주세요.
        결과물을 사용해 생긴 손해는 사용자가 책임집니다.
      </p>

      <h2>3. 결과물의 권리</h2>
      <p>입력한 설명과 생성된 파일은 사용자가 자유롭게 쓸 수 있습니다. 풋프린트는 KiCad 라이브러리 라이선스를 따릅니다.</p>

      <h2>4. 금지 행위</h2>
      <ul>
        <li>서버에 과도한 요청을 자동으로 보내는 행위</li>
        <li>다른 사람의 계정을 쓰거나 서비스 동작을 방해하는 행위</li>
      </ul>

      <h2>5. 외부 서비스</h2>
      <p>회로 생성과 AI 다듬기는 OpenAI API를, 부품 검색은 Mouser API를 씁니다. 각 서비스의 약관도 함께 적용됩니다.</p>

      <h2>6. 문의</h2>
      <p>문의는 프로젝트 저장소의 이슈로 남겨 주세요.</p>
    </>
  )
}

function Privacy() {
  return (
    <>
      <h1>개인정보 처리방침</h1>
      <p className="meta">최종 수정 {UPDATED} · 개인 프로젝트 베타</p>

      <h2>1. 수집하는 정보</h2>
      <table>
        <thead><tr><th>항목</th><th>언제</th><th>어디에</th></tr></thead>
        <tbody>
          <tr><td>이메일, 비밀번호</td><td>회원가입·로그인</td><td>Supabase 인증 (비밀번호는 Supabase가 해시로 저장)</td></tr>
          <tr><td>회로 설명, 생성 결과, 채팅 수정 내용</td><td>로그인한 상태로 생성·수정할 때</td><td>Supabase sessions, chat_messages 테이블</td></tr>
          <tr><td>즐겨찾기</td><td>즐겨찾기를 누를 때</td><td>Supabase favorites 테이블</td></tr>
          <tr><td>생성된 파일 (.net, .kicad_pcb, 거버)</td><td>생성할 때</td><td>서버의 outputs 폴더</td></tr>
          <tr><td>최근 결과, 설정</td><td>브라우저에서</td><td>이 브라우저의 localStorage (서버로 보내지 않음)</td></tr>
        </tbody>
      </table>

      <h2>2. 외부로 보내는 정보</h2>
      <ul>
        <li>회로 설명과 회로 구성은 생성·수정·AI 다듬기를 위해 OpenAI API로 보냅니다.</li>
        <li>부품 검색을 하면 부품 이름·값을 Mouser API로 보냅니다.</li>
        <li>그 밖의 제3자에게 제공하거나 광고에 쓰지 않습니다.</li>
      </ul>

      <h2>3. 보관과 삭제</h2>
      <p>
        계정과 저장된 세션은 삭제를 요청할 때까지 보관합니다. 삭제를 원하면 저장소 이슈로 요청해 주세요.
        브라우저에 남은 기록은 브라우저의 사이트 데이터 삭제로 지울 수 있습니다.
      </p>

      <h2>4. 로그인 없이 쓰는 경우</h2>
      <p>데모(<a href="/?demo=motor">모터 드라이버 데모</a>)는 계정 정보를 받지 않습니다. 생성된 파일만 서버 outputs 폴더에 남습니다.</p>
    </>
  )
}
