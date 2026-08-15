// Local harness for lib/host.js: mounts the plugin against a fake webServer and
// exercises the API surface + op pipeline with a fake CLI bin. DSH_HOME points
// at a throwaway directory, so no real profile or network install is touched.
// Run: node --test tests/host.test.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-mkts-home-'))
mkdirSync(join(TEST_HOME, 'profiles', 'web'), { recursive: true })
writeFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'fake-installed': '^1.0.0', 'github-dep': 'github:Jesse-njx/dsh-memory' },
  dsh: { profile: { bundles: ['fake-installed', 'builtin-bundle'] } },
}, null, 2) + '\n')
process.env.DSH_HOME = TEST_HOME

const mod = await import('../lib/host.js')

let handler = null
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) { handler = route.handler },
      }
    }
    return undefined
  },
}
mod.apply(ctx)
if (!handler) { console.error('FAIL: route not registered'); process.exit(1) }

async function call(body, headers = {}) {
  const raw = JSON.stringify(body)
  const req = {
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', ...headers },
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(raw))
      if (ev === 'end') setTimeout(cb, 0)
    },
  }
  const res = {
    writeHead() {},
    end(payload) { res.body = JSON.parse(payload) },
  }
  await handler(req, res)
  return res.body
}

let failures = 0
let skipped = 0
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name)
  else { console.error('FAIL ' + name + ': ' + String(detail)); failures++ }
}
function skip(name) {
  console.log('SKIP ' + name + ' (network unavailable)')
  skipped++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForOps(predicate, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const snap = await call({ method: 'op' })
    if (predicate(snap)) return snap
    await sleep(120)
  }
  return null
}

// --- read-only API surface ---
// dshBin auto-detection keys off the web server's cwd (the harness checkout);
// under the test runner the cwd is this repo, so pin the DSH_BIN fallback.
process.env.DSH_BIN = process.execPath
const probe = await call({ method: 'probe' })
check('probe env', probe.ok && probe.dshHome === TEST_HOME && probe.node && probe.dshBin, probe)

const inst = await call({ method: 'installed' })
check('installed shape', inst.ok && Array.isArray(inst.bundles) && typeof inst.dependencies === 'object' && Array.isArray(inst.disabled), inst)
check('installed returns repos identity map', inst.ok && inst.repos
  && inst.repos['github-dep'] === 'jesse-njx/dsh-memory'
  && inst.repos['fake-installed'] === null, inst)

const all = await call({ method: 'installedAll' })
check('installedAll lists dep + builtin', all.ok
  && Array.isArray(all.plugins) && all.plugins.some((p) => p.name === 'fake-installed')
  && Array.isArray(all.builtin) && all.builtin.includes('builtin-bundle'), all)
check('installedAll rows carry resolved repo identity', all.ok
  && all.plugins.some((p) => p.name === 'github-dep' && p.repo === 'jesse-njx/dsh-memory'), all.plugins)

const emptyOp = await call({ method: 'op' })
check('op empty -> null queue/history', emptyOp.ok && emptyOp.op === null
  && Array.isArray(emptyOp.queue) && emptyOp.queue.length === 0
  && Array.isArray(emptyOp.history) && emptyOp.history.length === 0, emptyOp)

const list = await call({ method: 'list', lang: 'zh' })
if (!list.ok) skip('list zh (real site)')
else {
  check('list zh (real site)', Array.isArray(list.plugins) && list.plugins.length >= 90, JSON.stringify(list).slice(0, 160))
  const starCount = list.plugins.filter((p) => typeof p.stars === 'number').length
  check('list zh includes star counts', starCount > 0, 'plugins=' + list.plugins.length + ' withStars=' + starCount)
}

// --- classify (read-only GitHub manifest fetches; skipped when offline) ---
const tianshu = await mod.classifyPlugin('github:huiliyi37/dsh-tianshu-tui')
if (tianshu.fetchFailed) skip('classify tianshu-tui webClient false')
else check('classify tianshu-tui webClient false', tianshu.known && tianshu.webClient === false, tianshu)

const whale = await mod.classifyPlugin('github:vlln/whale-girl')
if (whale.fetchFailed) skip('classify whale-girl webClient true')
else check('classify whale-girl webClient true', whale.known && whale.webClient === true, whale)

const registrySpec = await mod.classifyPlugin('@some/pkg')
check('classify registry spec unknown', registrySpec.known === false && registrySpec.webClient === false, registrySpec)

// --- probe (fake bin emulates install + boot) ---
const probeBin = join(tmpdir(), 'mkts-probe-bin-' + process.pid + '.mjs')
writeFileSync(probeBin, `
const isBoot = !process.argv.includes('plugin') && process.argv.includes('--port')
if (isBoot) {
  process.stdout.write('dsh web: http://127.0.0.1:0\\n')
} else {
  process.stdout.write('fake-bin installing\\n')
}
process.exit(0)
`)
const probeOk = await mod.runProbe(probeBin, 'fake:ok')
check('probe passes on readiness line', probeOk.ok === true, probeOk)

writeFileSync(probeBin, `
const isBoot = !process.argv.includes('plugin') && process.argv.includes('--port')
if (isBoot) {
  process.stdout.write('BOOT ERROR: duplicate service api-gateway\\n')
  process.exit(1)
}
process.stdout.write('fake-bin installing\\n')
process.exit(0)
`)
const probeFail = await mod.runProbe(probeBin, 'fake:bad')
check('probe fails on boot error', probeFail.ok === false && probeFail.stage === 'boot' && /BOOT ERROR/.test(probeFail.output || ''), probeFail)

writeFileSync(probeBin, `process.stdout.write('pnpm: network unreachable\\n')\nprocess.exit(1)\n`)
const probeInstallFail = await mod.runProbe(probeBin, 'fake:neterr')
check('probe fails on install error', probeInstallFail.ok === false && probeInstallFail.stage === 'install' && /pnpm/.test(probeInstallFail.output || ''), probeInstallFail)

// --- same-origin gate on write operations ---
const crossOrigin = await call({ method: 'install', source: 'fake:any', profile: 'web', binPath: process.execPath }, { origin: 'http://evil.example' })
check('install rejected cross-origin', crossOrigin.ok === false && /untrusted/.test(crossOrigin.error || ''), crossOrigin)

const crossKill = await call({ method: 'kill' }, { origin: 'http://evil.example' })
check('kill rejected cross-origin', crossKill.ok === false && /untrusted/.test(crossKill.error || ''), crossKill)

const crossToggle = await call({ method: 'disable', name: 'fake-installed', profile: 'web' }, { origin: 'http://evil.example' })
check('disable rejected cross-origin', crossToggle.ok === false && /untrusted/.test(crossToggle.error || ''), crossToggle)

// --- source whitelist (curated catalog only) ---
const notListed = await call({ method: 'install', source: 'github:somebody/not-in-catalog', profile: 'web', binPath: process.execPath })
check('install enqueued (whitelist now checked at queue head)', notListed.ok === true && notListed.opId, notListed)
const notListedDone = await waitForOps((s) => (s.op === null) && s.history.some((o) => o.id === notListed.opId && o.status === 'refused'))
check('whitelist refusal settles in op history', !!notListedDone && /精选目录/.test((notListedDone.history.find((o) => o.id === notListed.opId) || {}).output || ''), notListedDone)

const wlBin = join(tmpdir(), 'mkts-wl-bin-' + process.pid + '.mjs')
writeFileSync(wlBin, `process.exit(0)\n`)
const listedOk = await call({ method: 'install', source: 'github:huiliyi37/dsh-tianshu-tui', profile: 'web', binPath: wlBin, skipCheck: true })
check('catalog-listed github source enqueues', listedOk.ok === true && listedOk.opId, listedOk)
await call({ method: 'kill' })

const wl = await mod.whitelistSource('@some/pkg', [{ source: 'github:a/b' }])
check('whitelist ignores registry spec', wl.allowed === true, wl)

// --- catalog snapshot fallback (bundled data/catalog-snapshot.json) ---
const snap = JSON.parse(readFileSync(join(dirname(fileURLToPath(new URL('../lib/host.js', import.meta.url))), '..', 'data', 'catalog-snapshot.json'), 'utf8'))
check('snapshot exists and non-empty', Array.isArray(snap.plugins) && snap.plugins.length > 0 && Array.isArray(snap.cats), snap.updated)

// --- registryToCatalog: plugins.json → card shape (pure, no network) ---
const registryDoc = {
  plugins: [
    { name: 'dsh-tianshu-tui', owner: 'huiliyi37', url: 'https://github.com/huiliyi37/dsh-tianshu-tui',
      category: 'ui', description: { en: 'TUI client', zh: '终端 UI' }, stars: 1234, added: '2026-08-13',
      install: 'dsh plugin --profile web add github:huiliyi37/dsh-tianshu-tui' },
    { name: 'dsh-plugin-hub', owner: 'Noob-stupid', url: 'https://github.com/Noob-stupid/dsh-plugin-hub',
      category: 'ui', description: '单语言描述', install: 'dsh plugin --profile web add github:Noob-stupid/dsh-plugin-hub' },
  ],
  categories: { ui: { en: 'UI Enhancements', zh: 'UI 增强' } },
}
const zhCatalog = mod.registryToCatalog(registryDoc, 'zh')
check('registryToCatalog zh picks zh desc + splits install', zhCatalog.plugins.length === 2
  && zhCatalog.plugins[0].desc === '终端 UI' && zhCatalog.plugins[0].source === 'github:huiliyi37/dsh-tianshu-tui'
  && zhCatalog.plugins[0].profile === 'web' && zhCatalog.plugins[0].stars === 1234
  && zhCatalog.plugins[0].by === 'huiliyi37', zhCatalog.plugins[0])
check('registryToCatalog en falls back to en desc; string desc treated as absent', mod.registryToCatalog(registryDoc, 'en').plugins[0].desc === 'TUI client'
  && zhCatalog.plugins[1].desc === '' && zhCatalog.plugins[1].source === 'github:Noob-stupid/dsh-plugin-hub', zhCatalog.plugins[1])
check('registryToCatalog cats counts', zhCatalog.cats.length === 2 && zhCatalog.cats[0].id === 'all' && zhCatalog.cats[0].count === 2
  && zhCatalog.cats[1].id === 'ui' && zhCatalog.cats[1].count === 2 && zhCatalog.cats[1].label === 'UI 增强', zhCatalog.cats)
check('registryToCatalog tolerates empty/missing registry', mod.registryToCatalog({ plugins: [], categories: {} }, 'zh').plugins.length === 0
  && mod.registryToCatalog({}, 'zh').cats.length === 1 && mod.registryToCatalog({}, 'zh').cats[0].count === 0, 'empty input tolerated')

// --- fetchLiveCatalog: direct plugins.json fetch (skipped when offline) ---
const liveCatalog = await mod.fetchLiveCatalog('zh').then((c) => ({ ok: true, c })).catch((e) => ({ ok: false, e: String((e && e.message) || e) }))
if (!liveCatalog.ok) skip('fetchLiveCatalog (real site)')
else check('fetchLiveCatalog (real site)', Array.isArray(liveCatalog.c.plugins) && liveCatalog.c.plugins.length > 0
  && liveCatalog.c.plugins.some((p) => typeof p.stars === 'number') && Array.isArray(liveCatalog.c.cats), liveCatalog.c.plugins.length)

// --- author-aware identity matching (same repo basename, different owners) ---
check('githubIdentity from url', mod.githubIdentity('https://github.com/Jesse-njx/dsh-memory') === 'jesse-njx/dsh-memory',
  mod.githubIdentity('https://github.com/Jesse-njx/dsh-memory'))
check('githubIdentity from repository object + git+ scheme',
  mod.githubIdentity({ type: 'git', url: 'git+https://github.com/flymysql/dsh-memory.git' }) === 'flymysql/dsh-memory',
  mod.githubIdentity({ type: 'git', url: 'git+https://github.com/flymysql/dsh-memory.git' }))
check('githubIdentity null for scoped npm name (scope != owner)',
  mod.githubIdentity('@anionex/dsh-vision-toolkit') === null, mod.githubIdentity('@anionex/dsh-vision-toolkit'))
check('githubIdentity null for version range',
  mod.githubIdentity('^1.0.0') === null, mod.githubIdentity('^1.0.0'))

const jesseCard = { url: 'https://github.com/Jesse-njx/dsh-memory' }
const flyCard = { url: 'https://github.com/flymysql/dsh-memory' }
check('matchesCatalog identity match', mod.matchesCatalog('dsh-memory', 'github:Jesse-njx/dsh-memory', jesseCard) === true,
  mod.matchesCatalog('dsh-memory', 'github:Jesse-njx/dsh-memory', jesseCard))
check('matchesCatalog rejects different author (regression)', mod.matchesCatalog('dsh-memory', 'github:Jesse-njx/dsh-memory', flyCard) === false,
  mod.matchesCatalog('dsh-memory', 'github:Jesse-njx/dsh-memory', flyCard))
check('matchesCatalog knownIdentity resolves npm spec', mod.matchesCatalog('dsh-memory', '^1.0.0', flyCard, 'flymysql/dsh-memory') === true,
  mod.matchesCatalog('dsh-memory', '^1.0.0', flyCard, 'flymysql/dsh-memory'))
check('matchesCatalog knownIdentity rejects other author', mod.matchesCatalog('dsh-memory', '^1.0.0', jesseCard, 'flymysql/dsh-memory') === false,
  mod.matchesCatalog('dsh-memory', '^1.0.0', jesseCard, 'flymysql/dsh-memory'))
check('matchesCatalog legacy basename fallback preserved', mod.matchesCatalog('dsh-better-sidebar', '^1.0.0', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar' }) === true,
  mod.matchesCatalog('dsh-better-sidebar', '^1.0.0', { url: 'https://github.com/omdsh-dev/DSH-better-sidebar' }))
check('resolveDepIdentityFrom reads github spec', mod.resolveDepIdentityFrom('dsh-memory', 'github:Jesse-njx/dsh-memory') === 'jesse-njx/dsh-memory',
  mod.resolveDepIdentityFrom('dsh-memory', 'github:Jesse-njx/dsh-memory'))

// --- registryToCatalog: plugins.json -> card shape (stars/added/owner) ---
const regFixture = {
  categories: {
    ui: { en: 'UI Enhancements', zh: 'UI 增强' },
    theme: { en: 'Themes', zh: '主题' },
  },
  plugins: [
    {
      name: 'dsh-tianshu-tui', owner: 'huiliyi37', url: 'https://github.com/huiliyi37/dsh-tianshu-tui',
      category: 'ui', description: { en: 'TUI', zh: '终端 UI' }, stars: 110, added: '2026-08-13',
      install: 'dsh plugin --profile web add github:huiliyi37/dsh-tianshu-tui',
    },
    {
      name: 'dsh-whale', owner: 'vlln', url: 'https://github.com/vlln/whale-girl',
      category: 'theme', description: { en: 'Whale', zh: '鲸鱼' }, stars: null, added: '2026-08-14',
      install: 'dsh plugin --profile web add @scope/pkg',
    },
  ],
}
const mapped = mod.registryToCatalog(regFixture, 'zh')
check('registryToCatalog maps stars/added/owner', mapped.plugins.length === 2
  && mapped.plugins[0].stars === 110 && mapped.plugins[0].added === '2026-08-13'
  && mapped.plugins[0].by === 'huiliyi37' && mapped.plugins[0].desc === '终端 UI', mapped.plugins[0])
check('registryToCatalog keeps null stars + registry source', mapped.plugins[1].stars === null
  && mapped.plugins[1].source === '@scope/pkg' && mapped.plugins[1].profile === 'web', mapped.plugins[1])
check('registryToCatalog cats (all + per category)', mapped.cats.length === 3
  && mapped.cats[0].id === 'all' && mapped.cats[0].count === 2
  && mapped.cats[1].label === 'UI 增强' && mapped.cats[1].count === 1, mapped.cats)
const mappedEn = mod.registryToCatalog(regFixture, 'en')
check('registryToCatalog localizes desc/labels', mappedEn.plugins[0].desc === 'TUI'
  && mappedEn.cats[0].label === 'All' && mappedEn.cats[1].label === 'UI Enhancements', mappedEn.cats[1])

// --- supply-chain release-age auto-heal (pnpm >=11 default 24h policy) ---
const violationOut = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n'
  + '  dsh-model-picker@1.0.2 was published at 2026-08-15T07:16:34.846Z, within the minimumReleaseAge cutoff (2026-08-14T07:37:30.187Z)\n'
const healYaml = join(TEST_HOME, 'profiles', 'web', 'pnpm-workspace.yaml')
writeFileSync(healYaml, 'packages:\n  - .\n\nnodeLinker: hoisted\n\nminimumReleaseAgeExclude:\n'
  + "  - '@deepseek-ai/dsh-credentials@0.1.0-rc.6'\n  - dsh-model-picker@1.0.1\n  - dsh-model-picker@1.0.2\n")
const healed = mod.healReleaseAgeExclude('web', violationOut)
const healedYaml = readFileSync(healYaml, 'utf8')
check('heal merges same-name versions into one union rule',
  healed.includes('dsh-model-picker@1.0.2') && /dsh-model-picker@1\.0\.1\|\|1\.0\.2/.test(healedYaml)
  && !healedYaml.includes('- dsh-model-picker@1.0.1\n') && !healedYaml.includes('- dsh-model-picker@1.0.2\n'),
  healedYaml)
check('heal preserves unrelated yaml keys', /packages:\n/.test(healedYaml)
  && /nodeLinker: hoisted/.test(healedYaml)
  && /'@deepseek-ai\/dsh-credentials@0\.1\.0-rc\.6'/.test(healedYaml), healedYaml)
check('heal no-ops without the violation marker',
  mod.healReleaseAgeExclude('web', 'pnpm: network unreachable\n').length === 0
  && readFileSync(healYaml, 'utf8') === healedYaml, readFileSync(healYaml, 'utf8'))
writeFileSync(healYaml, 'packages:\n  - .\n')
const appended = mod.healReleaseAgeExclude('web', violationOut)
const appendedYaml = readFileSync(healYaml, 'utf8')
check('heal appends the exclude block when missing', appended.length === 1
  && /minimumReleaseAgeExclude:\n  - dsh-model-picker@1\.0\.2/.test(appendedYaml), appendedYaml)

// --- parseSimplePatch: hot-mountable patch shape detection ---
const simplePatch = mod.parseSimplePatch('- insert:\n    - id: tool-csv\n      name: \'@deepseek-ai/dsh-tool-csv\'\n')
check('parseSimplePatch accepts plain id/name rows', simplePatch !== null && simplePatch.length === 1 && simplePatch[0].id === 'tool-csv', simplePatch)
const complexPatch = mod.parseSimplePatch('- insert:\n    - id: x\n      name: y\n- id: system-prompt\n  config: {}\n')
check('parseSimplePatch rejects config rows', complexPatch === null, complexPatch)

// --- updates / update routes ---
const updates = await call({ method: 'updates', profile: 'web' })
check('updates route ok', updates.ok === true && typeof updates.updates === 'object', updates)

const updCross = await call({ method: 'update', name: 'fake:pkg', profile: 'web' }, { origin: 'http://evil.example' })
check('update rejected cross-origin', updCross.ok === false && /untrusted/.test(updCross.error || ''), updCross)

const updAllCross = await call({ method: 'updateAll', profile: 'web' }, { origin: 'http://evil.example' })
check('updateAll rejected cross-origin', updAllCross.ok === false && /untrusted/.test(updAllCross.error || ''), updAllCross)
const updAll = await call({ method: 'updateAll', profile: 'web' })
check('updateAll returns ok + opId list', updAll.ok === true && typeof updAll.count === 'number' && Array.isArray(updAll.opIds), updAll)

const updNotInstalled = await call({ method: 'update', name: 'not-installed-pkg', profile: 'web', binPath: process.execPath })
check('update rejects not-installed', updNotInstalled.ok === false && /未安装/.test(updNotInstalled.output || ''), updNotInstalled)

const cu = await mod.checkUpdates('__no_such_profile__')
check('checkUpdates degrades on missing profile', typeof cu === 'object' && Object.keys(cu).length === 0, cu)

// --- update target construction: pin github updates to the detected commit SHA ---
check('github update target pins detected SHA',
  mod.updateTargetFor('github:vlln/dsh-navbar#old', 'x', '6e23640bd60c0157043ae5c29a6d80034287b41b')
    === 'github:vlln/dsh-navbar#6e23640bd60c0157043ae5c29a6d80034287b41b',
  mod.updateTargetFor('github:vlln/dsh-navbar#old', 'x', '6e23640bd60c0157043ae5c29a6d80034287b41b'))
check('github update target falls back to unpinned when SHA unknown',
  mod.updateTargetFor('github:vlln/dsh-navbar', 'x', null) === 'github:vlln/dsh-navbar',
  mod.updateTargetFor('github:vlln/dsh-navbar', 'x', null))
check('github update target strips .git before pinning',
  mod.updateTargetFor('github:vlln/dsh-navbar.git', 'x', '6e23640bd60c0157043ae5c29a6d80034287b41b')
    === 'github:vlln/dsh-navbar#6e23640bd60c0157043ae5c29a6d80034287b41b',
  mod.updateTargetFor('github:vlln/dsh-navbar.git', 'x', '6e23640bd60c0157043ae5c29a6d80034287b41b'))
check('npm update target uses name@latest', mod.updateTargetFor('^1.0.0', 'fake-installed', '1.2.0') === 'fake-installed@latest',
  mod.updateTargetFor('^1.0.0', 'fake-installed', '1.2.0'))

// --- queue pipeline with a fake CLI bin (never touches the real profile) ---
const fakeBin = join(tmpdir(), 'mkts-fake-bin-' + process.pid + '.mjs')
writeFileSync(fakeBin, `
const isBoot = !process.argv.includes('plugin') && process.argv.includes('--port')
if (isBoot) {
  process.stdout.write('dsh web: http://127.0.0.1:0\\n')
  process.exit(0)
}
process.stdout.write('fake-bin running\\n')
process.stderr.write('fake-bin stderr line\\n')
setTimeout(() => { process.exit(0) }, 400)
`)
const opCall = await call({ method: 'install', source: 'fake:test', profile: 'web', binPath: fakeBin, label: 'fake plugin' })
check('install enqueues and starts op', opCall.ok && opCall.opId, opCall)

const firstSnap = await call({ method: 'op' })
check('first op is live (running/checking)', firstSnap.ok && firstSnap.op && (firstSnap.op.status === 'running' || firstSnap.op.status === 'checking'), firstSnap)

// Queueing: a second different op is accepted while the first is still live.
const op2Call = await call({ method: 'install', source: 'fake:test2', profile: 'web', binPath: fakeBin, label: 'second fake', skipCheck: true })
check('second install is queued behind the first', op2Call.ok && op2Call.opId, op2Call)
const queuedSnap = await call({ method: 'op' })
check('queue reports the pending op', queuedSnap.ok && queuedSnap.op && queuedSnap.queue.some((o) => o.id === op2Call.opId && o.status === 'pending'), queuedSnap)

// Duplicate live/pending target is refused (no self-race).
const dupCall = await call({ method: 'install', source: 'fake:test2', profile: 'web', binPath: fakeBin, label: 'dup', skipCheck: true })
check('duplicate target refused while queued', dupCall.ok === false && dupCall.busy === true, dupCall)

const bothDone = await waitForOps((s) => s.op === null && s.history.filter((o) => o.id === opCall.opId || o.id === op2Call.opId).length === 2)
check('both queued ops settle done in FIFO order', !!bothDone, bothDone)
if (bothDone) {
  const order = bothDone.history.filter((o) => o.id === opCall.opId || o.id === op2Call.opId)
  // history is newest-first, so FIFO completion shows as [second, first].
  check('FIFO order: first op settled before second', order.length === 2 && order[0].id === op2Call.opId && order[1].id === opCall.opId, order.map((o) => o.id + ':' + o.status))
  const opById = await call({ method: 'op', opId: opCall.opId })
  check('op by id matches after settle', opById.ok && opById.op && opById.op.id === opCall.opId && opById.op.status === 'done', opById)

  // Clear persists host-side: dismissed finished ops disappear from history
  // and are no longer returned by id, so refresh/reopen cannot resurrect them.
  const clearCross = await call({ method: 'clear', opId: opCall.opId }, { origin: 'http://evil.example' })
  check('clear rejected cross-origin', clearCross.ok === false && /untrusted/.test(clearCross.error || ''), clearCross)
  const cleared = await call({ method: 'clear', opId: opCall.opId })
  check('clear finished op ok', cleared.ok === true, cleared)
  const clearedById = await call({ method: 'op', opId: opCall.opId })
  check('cleared op no longer returned by id', clearedById.ok && clearedById.op === null, clearedById)
  const clearedSnap = await call({ method: 'op' })
  check('cleared op removed from history snapshot', !clearedSnap.history.some((o) => o.id === opCall.opId), clearedSnap.history)
}

// kill path: cancel a queued op and kill the live one.
writeFileSync(fakeBin, `setTimeout(() => {}, 60000)\n`)
const slow1 = await call({ method: 'install', source: 'fake:slow1', profile: 'web', binPath: fakeBin, label: 'slow1', skipCheck: true })
check('slow op 1 starts', slow1.ok && slow1.opId, slow1)
const slow2 = await call({ method: 'install', source: 'fake:slow2', profile: 'web', binPath: fakeBin, label: 'slow2', skipCheck: true })
check('slow op 2 queues', slow2.ok && slow2.opId, slow2)
await sleep(200)
const toggleBusy = await call({ method: 'disable', name: 'fake-installed', profile: 'web' })
check('disable refused while queue busy', toggleBusy.ok === false && toggleBusy.busy === true, toggleBusy)
const cancelQueued = await call({ method: 'kill', opId: slow2.opId })
check('queued op cancelled by id', cancelQueued.ok === true, cancelQueued)
const queuedKilled = await call({ method: 'op', opId: slow2.opId })
check('cancelled op status killed', queuedKilled.ok && queuedKilled.op && queuedKilled.op.status === 'killed', queuedKilled)

const killLive = await call({ method: 'kill' })
check('live op killed', killLive.ok, killLive)
const liveKilled = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === slow1.opId && o.status === 'killed'))
check('live op settles killed', !!liveKilled, liveKilled)

// After the queue drains a new op starts normally again.
writeFileSync(fakeBin, `setTimeout(() => { process.exit(0) }, 300)\n`)
const afterQueue = await call({ method: 'install', source: 'fake:again', profile: 'web', binPath: fakeBin, label: 'again', skipCheck: true })
check('new op starts after queue drained', afterQueue.ok && afterQueue.opId, afterQueue)
const afterDone = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === afterQueue.opId && o.status === 'done'))
check('post-queue op settles done', !!afterDone, afterDone)

// --- PATH `dsh` fallback: PATH scan decides, bare `dsh` spawns via shell on Windows ---
{
  const savedPath = process.env.PATH
  const savedBin = process.env.DSH_BIN
  const pathDir = mkdtempSync(join(tmpdir(), 'mkts-pathbin-'))
  writeFileSync(join(pathDir, 'mkts-path-bin.mjs'), 'setTimeout(() => { process.exit(0) }, 300)\n')
  writeFileSync(join(pathDir, 'dsh.cmd'), '@echo off\r\nnode "%~dp0mkts-path-bin.mjs" %*\r\n')
  writeFileSync(join(pathDir, 'dsh'), '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 300)\n')
  delete process.env.DSH_BIN
  process.env.PATH = pathDir + delimiter + (savedPath || '')
  try {
    const pathProbe = await call({ method: 'probe' })
    check('PATH fallback detected (dshBin reports bare dsh)', pathProbe.ok && pathProbe.dshBin === 'dsh', pathProbe)
    const pathOp = await call({ method: 'install', source: 'fake:path', profile: 'web', label: 'path-bin', skipCheck: true })
    check('PATH fallback enqueues without explicit bin', pathOp.ok && pathOp.opId, pathOp)
    const pathDone = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === pathOp.opId && o.status === 'done'))
    check('PATH fallback op spawns through shell and settles done', !!pathDone, pathDone)
    // cmd-injection guard: shell-mediated spawns refuse unsafe argv.
    const unsafeOp = await call({ method: 'install', source: 'fake & calc', profile: 'web', label: 'unsafe', skipCheck: true })
    check('unsafe op enqueued (guard fires at queue head)', unsafeOp.ok && unsafeOp.opId, unsafeOp)
    const unsafeRefused = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === unsafeOp.opId && o.status === 'refused'))
    check('shell path refuses unsafe target', !!unsafeRefused && /unsafe/.test((unsafeRefused.history.find((o) => o.id === unsafeOp.opId) || {}).output || ''), unsafeRefused)
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedBin === undefined) delete process.env.DSH_BIN
    else process.env.DSH_BIN = savedBin
  }
}

// Supply-chain release-age auto-heal end to end: the CLI fails once with the
// pnpm minimumReleaseAge violation, the host heals the profile's exclude list
// and retries the same command, and the op settles done.
const healBin = join(tmpdir(), 'mkts-heal-bin-' + process.pid + '.mjs')
const healMarker = healBin + '.runs'
writeFileSync(healMarker, '0')
// Seed the profile yaml with an unrelated excluded entry so the heal has to
// ADD dsh-model-picker (a no-change heal would skip the retry).
writeFileSync(join(TEST_HOME, 'profiles', 'web', 'pnpm-workspace.yaml'),
  "packages:\n  - .\n\nminimumReleaseAgeExclude:\n  - '@deepseek-ai/dsh-credentials@0.1.0-rc.6'\n")
// The spawned CLI derives its marker from its own file path, so the host's
// automatic retry (same argv, same script) keeps counting on the SAME marker.
writeFileSync(healBin, `
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const marker = fileURLToPath(import.meta.url) + '.runs'
const runs = Number(readFileSync(marker, 'utf8'))
writeFileSync(marker, String(runs + 1))
if (runs === 0) {
  process.stderr.write('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\\n')
  process.stderr.write('  dsh-model-picker@1.0.2 was published at 2026-08-15T07:16:34.846Z, within the minimumReleaseAge cutoff (2026-08-14T07:37:30.187Z)\\n')
  process.exit(1)
}
process.exit(0)
`)
const healCall = await call({ method: 'install', source: 'fake:heal', profile: 'web', binPath: healBin, label: 'heal-me', skipCheck: true })
check('heal op enqueues', healCall.ok && healCall.opId, healCall)
const healDone = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === healCall.opId && o.status === 'done'))
check('heal op auto-retries and settles done', !!healDone, healDone)
if (healDone) {
  const healRow = healDone.history.find((o) => o.id === healCall.opId)
  check('heal op output shows the auto-retry note', /\[auto\]/.test(healRow.output || ''), (healRow.output || '').slice(0, 300))
  check('heal op ran the CLI twice', readFileSync(healMarker, 'utf8') === '2', readFileSync(healMarker, 'utf8'))
  const healYamlText = readFileSync(join(TEST_HOME, 'profiles', 'web', 'pnpm-workspace.yaml'), 'utf8')
  check('heal wrote the union exclude entry', /dsh-model-picker@1\.0\.2/.test(healYamlText), healYamlText)
}

// Network-error auto-retry: fail once with pnpm's GET/retry pattern, then succeed.
const netBin = join(tmpdir(), 'mkts-net-bin-' + process.pid + '.mjs')
const netMarker = netBin + '.runs'
writeFileSync(netMarker, '0')
writeFileSync(netBin, `
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const marker = fileURLToPath(import.meta.url) + '.runs'
const runs = Number(readFileSync(marker, 'utf8'))
writeFileSync(marker, String(runs + 1))
if (runs === 0) {
  process.stderr.write('GET https://codeload.github.com/o/r/tar.gz/abc\\n')
  process.stderr.write('error ETIMEDOUT. Retrying...\\n')
  process.exit(1)
}
process.exit(0)
`)
const netCall = await call({ method: 'install', source: 'fake:net', profile: 'web', binPath: netBin, label: 'net-retry', skipCheck: true })
check('network-error op enqueues', netCall.ok && netCall.opId, netCall)
const netDone = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === netCall.opId && o.status === 'done'))
check('network-error op auto-retries once and settles done', !!netDone, netDone)
if (netDone) {
  const netRow = netDone.history.find((o) => o.id === netCall.opId)
  check('network-error output shows auto-retry note', /\[auto\] 检测到网络错误/.test(netRow.output || ''), (netRow.output || '').slice(0, 400))
  check('network-error op ran CLI twice', readFileSync(netMarker, 'utf8') === '2', readFileSync(netMarker, 'utf8'))
}

// Persistent network failure: bounded retry (exactly two runs), then a clear hint.
const netFailBin = join(tmpdir(), 'mkts-net-fail-bin-' + process.pid + '.mjs')
const netFailMarker = netFailBin + '.runs'
writeFileSync(netFailMarker, '0')
writeFileSync(netFailBin, `
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const marker = fileURLToPath(import.meta.url) + '.runs'
const runs = Number(readFileSync(marker, 'utf8'))
writeFileSync(marker, String(runs + 1))
process.stderr.write('GET https://registry.npmjs.org/pkg error ECONNRESET. Retrying...\\n')
process.exit(1)
`)
const netFailCall = await call({ method: 'install', source: 'fake:netfail', profile: 'web', binPath: netFailBin, label: 'net-fail', skipCheck: true })
check('persistent network-error op enqueues', netFailCall.ok && netFailCall.opId, netFailCall)
const netFailDone = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === netFailCall.opId && o.status === 'failed'))
check('persistent network-error op settles failed after one bounded retry', !!netFailDone, netFailDone)
if (netFailDone) {
  const netFailRow = netFailDone.history.find((o) => o.id === netFailCall.opId)
  check('network failure shows final hint', /\[network\] 网络拉取失败/.test(netFailRow.output || ''), (netFailRow.output || '').slice(0, 500))
  check('network failure did not retry endlessly', readFileSync(netFailMarker, 'utf8') === '2', readFileSync(netFailMarker, 'utf8'))
}

// Update uses the same queue (then killed to keep the test fast).
writeFileSync(fakeBin, `setTimeout(() => {}, 60000)\n`)
const updQueued = await call({ method: 'update', name: 'fake-installed', profile: 'web', binPath: fakeBin })
check('update enqueues via the queue', updQueued.ok && updQueued.opId, updQueued)
const updKill = await call({ method: 'kill' })
check('queued update killed', updKill.ok, updKill)

// uninstall: hot-mount dispose is a no-op when no live mount exists, and the
// remove op still starts normally (fake bin exits 0).
writeFileSync(fakeBin, `setTimeout(() => { process.exit(0) }, 300)\n`)
const uninstCall = await call({ method: 'uninstall', pkg: 'fake-installed', profile: 'web', binPath: fakeBin, label: 'fake-installed' })
check('uninstall enqueues (dispose no-op safe)', uninstCall.ok === true && uninstCall.opId, uninstCall)
const uninstOp = await waitForOps((s) => s.op === null && s.history.some((o) => o.id === uninstCall.opId && o.status === 'done'))
check('uninstall op settles done', !!uninstOp, uninstOp)

// --- disable / enable (dormant switch) ---
const disable = await call({ method: 'disable', name: 'fake-installed', profile: 'web' })
check('disable returns ok + disabled list', disable.ok === true && Array.isArray(disable.disabled) && disable.disabled.includes('fake-installed'), disable)
let manifest = JSON.parse(readFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), 'utf8'))
check('disable removes bundle but keeps dependency', manifest.dependencies['fake-installed'] !== undefined
  && !manifest.dsh.profile.bundles.includes('fake-installed'), manifest)
check('disable persists dsh.market.disabled', Array.isArray(manifest.dsh.market.disabled)
  && manifest.dsh.market.disabled.some((e) => e.name === 'fake-installed'), manifest.dsh.market)

const installedDisabled = await call({ method: 'installed' })
check('installed reports disabled names', Array.isArray(installedDisabled.disabled) && installedDisabled.disabled.includes('fake-installed'), installedDisabled)

const disabledUnit = mod.setDisabledState('web', 'not-installed-xyz', true)
check('disable unknown name rejected', disabledUnit.ok === false, disabledUnit)

const enable = await call({ method: 'enable', name: 'fake-installed', profile: 'web' })
check('enable returns ok', enable.ok === true && (!Array.isArray(enable.disabled) || !enable.disabled.includes('fake-installed')), enable)
manifest = JSON.parse(readFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), 'utf8'))
check('enable restores bundle at original index', manifest.dsh.profile.bundles[0] === 'fake-installed'
  && manifest.dsh.profile.bundles[1] === 'builtin-bundle', manifest.dsh.profile.bundles)
check('enable clears dsh.market.disabled', !Array.isArray(manifest.dsh.market.disabled) || manifest.dsh.market.disabled.length === 0, manifest.dsh.market)

const enableUnknown = mod.setDisabledState('web', 'also-not-installed', false)
check('enable unknown name rejected', enableUnknown.ok === false, enableUnknown)

// reapplyDisabledState guard: reconcile re-added a disabled bundle, reapply drops it.
manifest = JSON.parse(readFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), 'utf8'))
manifest.dsh.profile.bundles = ['fake-installed', 'builtin-bundle']
manifest.dsh.market = { disabled: [{ name: 'fake-installed', index: 0 }] }
writeFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
const reapply = await call({ method: 'install', source: 'fake:reapply', profile: 'web', binPath: fakeBin, label: 'reapply', skipCheck: true })
await waitForOps((s) => s.op === null && s.history.some((o) => o.id === reapply.opId && o.status === 'done'))
manifest = JSON.parse(readFileSync(join(TEST_HOME, 'profiles', 'web', 'package.json'), 'utf8'))
check('reapply keeps disabled bundle out after a market op', !manifest.dsh.profile.bundles.includes('fake-installed'), manifest.dsh.profile.bundles)
await call({ method: 'enable', name: 'fake-installed', profile: 'web' })

const tail = skipped > 0 ? ' (' + skipped + ' skipped)' : ''
console.log(failures === 0 ? 'ALL PASS' + tail : failures + ' FAILURES' + tail)
process.exit(failures === 0 ? 0 : 1)
