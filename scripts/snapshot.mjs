// One-off generator: refresh data/catalog-snapshot.json directly from the
// site's JSON API — no cache, no fallback chain, so an unreachable site can
// never self-copy stale data into the snapshot. Mirrors dsh-market's
// `npm run snapshot` (curl plugins.json).
// Run: node scripts/snapshot.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchLiveCatalog } from '../lib/host.js'

const { plugins, cats } = await fetchLiveCatalog('zh')
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog-snapshot.json')
mkdirSync(dirname(out), { recursive: true })
const snapshot = {
  updated: new Date().toISOString().slice(0, 10),
  source: 'live',
  plugins,
  cats,
}
writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')
console.log(`snapshot: ${plugins.length} plugins (live) -> ${out}`)
