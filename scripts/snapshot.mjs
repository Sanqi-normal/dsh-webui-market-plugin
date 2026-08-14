// One-off generator: refresh data/catalog-snapshot.json from the live site.
// Run: node scripts/snapshot.mjs
// Mirrors dsh-market's `npm run snapshot` (curl plugins.json) — ours parses
// the HTML catalog the same way loadCatalog does at runtime.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from '../lib/host.js'

const { plugins, cats, source } = await loadCatalog()
if (plugins.length === 0) {
  console.error('snapshot: catalog empty — aborting')
  process.exit(1)
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog-snapshot.json')
mkdirSync(dirname(out), { recursive: true })
const snapshot = {
  updated: new Date().toISOString().slice(0, 10),
  source,
  plugins,
  cats,
}
writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')
console.log(`snapshot: ${plugins.length} plugins (${source}) -> ${out}`)
