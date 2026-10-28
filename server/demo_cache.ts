// The demo circuits (checked-in skidl files) are run once when the deploy image is built and their
// netlists kept in demo_cache/. Opening a demo then copies a stored netlist instead of running Python,
// which took 7-9 s per visit on the free instance (0.1 CPU). A circuit file that no longer matches its
// stored hash is run as before, so an edited demo is never served stale.
// Build: npx tsx build_demo_cache.ts (the Dockerfile runs it). Checks: check_demo_cache.ts.
import { createHash, randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runSkidl } from './skidl_run'

/** the name in /?demo=… → the circuit file in test_circuits/ */
export const DEMOS: Record<string, string> = {
  led: 'led_basic',
  ne555: 'ne555_blink',
  relay: 'npn_relay',
  motor: 'nmos_motor',
  // the same circuits with one deliberate fault each, for the operating check
  led_bad: 'led_bad',
  ne555_bad: 'ne555_bad',
  relay_bad: 'relay_bad',
}

const sha = (code: string) => createHash('sha256').update(code).digest('hex')

/** run every demo circuit and keep <cacheDir>/<circuit>.net with <circuit>.json {sha256} of the code it came from */
export async function buildDemoCache(circuitsDir: string, cacheDir: string): Promise<string[]> {
  mkdirSync(cacheDir, { recursive: true })
  const built: string[] = []
  for (const circuit of [...new Set(Object.values(DEMOS))]) {
    const code = readFileSync(join(circuitsDir, `${circuit}.py`), 'utf8')
    const net = await runSkidl(code, cacheDir)
    renameSync(net, join(cacheDir, `${circuit}.net`))
    writeFileSync(join(cacheDir, `${circuit}.json`), JSON.stringify({ sha256: sha(code) }))
    built.push(circuit)
  }
  return built
}

/**
 * The stored netlist of a demo circuit, copied to a new file in outDir (each visitor's board files are
 * their own); null when nothing is stored or the stored one came from different code.
 */
export function cachedDemo(circuit: string, code: string, cacheDir: string, outDir: string): string | null {
  const net = join(cacheDir, `${circuit}.net`)
  const meta = join(cacheDir, `${circuit}.json`)
  if (!existsSync(net) || !existsSync(meta)) return null
  try {
    if ((JSON.parse(readFileSync(meta, 'utf8')) as { sha256?: string }).sha256 !== sha(code)) return null
  } catch {
    return null
  }
  const out = join(outDir, `${randomUUID().replace(/-/g, '')}.net`)
  copyFileSync(net, out)
  return out
}
