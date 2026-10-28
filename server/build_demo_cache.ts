// Runs the demo circuits once and stores their netlists in demo_cache/ (see demo_cache.ts).
// The Dockerfile runs it while building the image; from server/: npx tsx build_demo_cache.ts
import { join } from 'path'
import { buildDemoCache } from './demo_cache'

buildDemoCache(join(process.cwd(), 'test_circuits'), join(process.cwd(), 'demo_cache'))
  .then(built => console.log(`demo cache: ${built.length} circuits (${built.join(', ')})`))
  .catch(e => { console.error(`demo cache failed: ${(e as Error).message}`); process.exit(1) })
