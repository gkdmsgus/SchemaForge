// The flash on parts an edit changed (CircuitCanvas): the box fill and its edge. The schematic is drawn light whatever
// the theme, with dark names on the boxes, so the fills are light tints: the dark-theme fills (#0d2018, #241010,
// #1a1506) turned a changed part into a black box whose name could not be read (frame review of 2026-11-02).

export type DiffKind = 'added' | 'removed' | 'modified'

/** the part's name and value on its box (CircuitCanvas TEXT_LABEL, TEXT_VALUE) */
export const NAME_TEXT = '#1a1611'
export const VALUE_TEXT = '#5c5444'

export const DIFF_FILL: Record<DiffKind, string> = { added: '#dcf2e6', removed: '#fbe1de', modified: '#fbefd0' }
export const DIFF_EDGE: Record<DiffKind, string> = { added: '#34d3a0', removed: '#ff5c5c', modified: '#f59e0b' }

/** WCAG contrast ratio of two #rrggbb colours (1 to 21) */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
