// What the result drawer's tabs give and say once the circuit on screen is no longer the one generated (an AI edit,
// a code run), kept out of ResultPanel so scripts/check_fixes.ts runs it.

/**
 * The .net of the board built from the AI-edited circuit on screen, for the Netlist tab and the top bar's .net button.
 * The server wrote it from that circuit under the board's own name (server/index.ts /generate_pcb_stream), so the two
 * files downloaded together are one circuit: the generated .net beside an edited .kicad_pcb were two (2026-11-03 tour
 * takes 1 and 3, S17). null: the generated .net (no AI edit, no finished board, or a board of another circuit; a board
 * built in the other style is still this circuit).
 */
export function boardNetlist(aiEdited: boolean, pcbStatus: string | null, pcbStale: 'circuit' | 'style' | null,
  pcbFilename: string | null): string | null {
  return aiEdited && pcbStatus === 'done' && pcbStale !== 'circuit' && pcbFilename
    ? pcbFilename.replace(/\.kicad_pcb$/, '.net') : null
}

/** the Netlist tab's one line over the file: whose circuit it is, when that is not the one generated */
export function netlistNote(aiEdited: boolean, boardNet: string | null): string | null {
  return boardNet ? 'PCB를 만든 AI 편집 회로의 넷리스트입니다. .kicad_pcb와 같은 회로입니다.'
    : aiEdited ? 'AI 편집 내용은 이 넷리스트 파일에 없습니다. PCB를 생성하면 편집한 회로로 넷리스트를 새로 만듭니다.' : null
}
