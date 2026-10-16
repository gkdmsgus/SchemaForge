// How the files from this app open in KiCad: one collapsible line in the Netlist tab.
// Checked here: the generated .net has (footprint "") on every part (server/outputs), and the
// .kicad_pcb from PCB 생성 carries footprints, tracks and the ground zone (server/pcb/board.py).
// Not verified against KiCad 10, so kept out of the text: the menu paths "PCB Editor → File → Open"
// and "PCB Editor → File → Import → Netlist…" (KiCad 7/8 menus).
export default function KicadGuide() {
  return (
    <details className="sf-kicad-guide">
      <summary>KiCad에서 열기</summary>
      <ul>
        <li><b>.kicad_pcb</b> — PCB 생성 뒤 나오는 ↓ .kicad_pcb 파일은 KiCad PCB 편집기에서 바로 열립니다. 부품 배치와 배선이 들어 있습니다.</li>
        <li><b>.net</b> — 이 넷리스트는 부품마다 풋프린트가 비어 있습니다. PCB 편집기에서 가져와도 풋프린트를 지정하기 전에는 기판에 부품이 놓이지 않습니다.</li>
        <li><b>회로도</b> — KiCad 회로도 편집기는 넷리스트로 회로도를 만들지 못합니다. 이 앱은 회로도 파일(.kicad_sch)을 만들지 않습니다.</li>
      </ul>
    </details>
  )
}
