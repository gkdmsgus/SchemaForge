// kicad-cli's footprint library table for DRC on the development PC, as the images make it (Dockerfile, Dockerfile.jetson):
// one library per vendored server/pcb/footprints/<name>.pretty, the copies the boards are made from. Without it kicad-cli
// read the PC's own table, which takes in all of KiCad's installed libraries: about 10 s and 1.4 GB a DRC against about
// 1.5-2.3 s and 160 MB with this one, the same findings (measured 2026-11-08). Kept out of index.ts so
// check_kicad_config.ts reads the same table the server writes.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** KiCad 10's folder in a config home, as the images write it */
export const KICAD_VERSION_DIR = '10.0'

/**
 * The table's text: a library for each <name>.pretty folder in `dir`, named <name> (the Dockerfile's basename "$d" .pretty).
 * A library named with its .pretty does not match the board's footprints, and kicad-cli says nothing of it: every
 * footprint came back as lib_footprint_issues (review of 2026-11-08).
 */
export function footprintTable(dir: string): string {
  const libs = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.endsWith('.pretty')).map(d => d.name).sort()
  const lines = libs.map(n => `  (lib (name "${n.slice(0, -'.pretty'.length)}")(type "KiCad")(uri "${join(dir, n).replace(/\\/g, '/')}")(options "")(descr ""))`)
  return ['(fp_lib_table', '  (version 7)', ...lines, ')', ''].join('\n')
}

/**
 * A KICAD_CONFIG_HOME in the temp folder holding that table, one per footprint folder (each checkout its own), written
 * again at every start. kicad-cli keeps its other settings there too. Null when it could not be written: DRC then reads
 * the PC's own table as before, slower, with the same findings.
 */
export function vendoredKicadConfig(footprints: string, base = tmpdir()): string | null {
  try {
    const home = join(base, `sf_kicad_${createHash('sha1').update(footprints).digest('hex').slice(0, 10)}`)
    const table = join(home, KICAD_VERSION_DIR, 'fp-lib-table')
    const text = footprintTable(footprints)
    mkdirSync(join(home, KICAD_VERSION_DIR), { recursive: true })
    // a second server of the same checkout has written it already; a rename over a table kicad-cli is reading can fail
    if (!existsSync(table) || readFileSync(table, 'utf8') !== text) {
      const part = `${table}.${process.pid}.tmp`
      writeFileSync(part, text)
      renameSync(part, table)
    }
    return home
  } catch (e) {
    console.warn('[kicad] the footprint table for DRC was not written, so DRC reads this PC\'s own:', (e as Error).message)
    return null
  }
}
