export default function KicadGuide() {
  return (
    <div className="card kicad-guide-card">
      <details>
        <summary className="kicad-guide-summary">KiCad로 가져오는 방법</summary>
        <ol className="kicad-steps">
          <li><span className="ks-num">1</span><div><strong>.net 파일 다운로드</strong><p>위의 ".net 다운로드" 버튼을 눌러 schematic.net 파일을 저장하세요</p></div></li>
          <li><span className="ks-num">2</span><div><strong>KiCad 실행 → Schematic Editor 열기</strong><p>KiCad 메인 화면에서 Schematic Editor를 시작하세요</p></div></li>
          <li><span className="ks-num">3</span><div><strong>File → Import → Netlist...</strong><p>상단 메뉴에서 File → Import → Netlist를 선택하세요</p></div></li>
          <li><span className="ks-num">4</span><div><strong>다운로드한 .net 파일 선택</strong><p>파일 탐색기에서 schematic.net 파일을 찾아 선택하세요</p></div></li>
          <li><span className="ks-num">5</span><div><strong>Import Netlist 클릭</strong><p>버튼을 누르면 회로도에 부품과 연결이 자동으로 배치돼요!</p></div></li>
        </ol>
      </details>
    </div>
  )
}
