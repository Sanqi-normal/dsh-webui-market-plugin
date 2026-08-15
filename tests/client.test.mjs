// Client smoke: load lib/client.js through a fake __ModuleLoader__ + react stub,
// verify the module shape (id must equal the package.json name) and that
// apply() registers the market tab. Run: node --test tests/client.test.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require0 = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const React = {
  createElement: (...a) => ({ tag: 'el', args: a }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
}
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (handoff) => { loaded = handoff } } }
globalThis.document = {
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ remove: () => {} }),
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const require = (spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
}
const factory = new Function('require', src + '\n;return typeof module !== "undefined" ? module.exports : undefined')
factory(require)

if (!loaded) { console.error('FAIL: __ModuleLoader__.load never called'); process.exit(1) }
if (loaded.id !== pkg.name) { console.error('FAIL: bundle id ' + loaded.id + ' != package name ' + pkg.name); process.exit(1) }

const mod = loaded.factory(require)
if (!mod || !Array.isArray(mod.inject) || typeof mod.apply !== 'function') {
  console.error('FAIL: bad module shape'); process.exit(1)
}
if (mod.inject.join(',') !== 'slots,sessions,workspaces') { console.error('FAIL: inject=' + mod.inject); process.exit(1) }

let reg = null
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject(key, cb) {
          if (key === 'settings.plugins.tab') reg = cb()
        },
        register(opts, Component) { return { opts, Component } },
      }
    }
    return undefined
  },
  effect(fn) { return fn() },
}
mod.apply(ctx)
if (!reg) { console.error('FAIL: tab not registered'); process.exit(1) }
if (reg.opts.id !== 'market' || reg.opts.order !== 5) { console.error('FAIL: bad tab opts ' + JSON.stringify(reg.opts)); process.exit(1) }
if (typeof reg.Component !== 'function') { console.error('FAIL: Component not a function'); process.exit(1) }
console.log('PASS client module shape + apply registers market tab (id=market, order=5)')

// Render smoke: execute MarketPanel once with the stub hooks. This catches
// ReferenceErrors in the new queue/local/batch-render code paths without a
// real React runtime.
try {
  const tree = reg.Component()
  if (!tree || tree.tag !== 'el') throw new Error('unexpected tree ' + JSON.stringify(tree))
  console.log('PASS client MarketPanel renders a loading tree without runtime errors')
} catch (e) {
  console.error('FAIL client MarketPanel render smoke: ' + String((e && e.stack) || e))
  process.exit(1)
}

// Ready-state render smoke: re-evaluate the exact client source with a stub
// whose useState hands out a prepared ready catalog (installed + disabled +
// update-available cards), then render MarketPanel. This walks the card
// actions, disabled badge, update chip and batch-render branches.
{
  const initialStates = [
    { // data
      phase: 'ready',
      plugins: [
        {
          cat: 'ui', name: 'dsh-tianshu-tui', url: 'https://github.com/huiliyi37/dsh-tianshu-tui',
          by: 'huiliyi37', desc: 'TUI', profile: 'web', source: 'github:huiliyi37/dsh-tianshu-tui',
          stars: 12, added: '2026-08-13', cmd: 'dsh plugin --profile web add github:huiliyi37/dsh-tianshu-tui',
        },
        {
          cat: 'ui', name: 'DSH-better-sidebar', url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
          by: 'omdsh-dev', desc: 'Sidebar', profile: 'web', source: 'github:omdsh-dev/DSH-better-sidebar',
          stars: null, added: null, cmd: 'dsh plugin --profile web add github:omdsh-dev/DSH-better-sidebar',
        },
      ],
      cats: [{ id: 'all', count: 2 }, { id: 'ui', label: 'UI', count: 2 }],
      installed: {
        web: {
          dependencies: { 'dsh-tianshu-tui': 'github:huiliyi37/dsh-tianshu-tui', 'dsh-better-sidebar': '^1.0.0' },
          bundles: ['dsh-tianshu-tui'], disabled: ['dsh-better-sidebar'],
        },
      },
      updates: { web: { 'dsh-tianshu-tui': { kind: 'github', version: '1.0.0', current: 'aaa', latest: 'bbb', updateAvailable: true } } },
      error: null,
    },
    { dshHome: '/tmp/dsh', dshBin: 'bin', node: 'node' }, // envInfo
    '', // binPath
    '', // query
    'all', // cat
    false, // showInstalled
    'default', // sortBy
    null, // open
    null, // op confirm
    [], // ops queue
    true, // queueOpen
    null, // notice
    null, // local
    false, // localOpen
    60, // visibleCount
  ]
  let hookIndex = 0
  const ReactReady = {
    createElement: (...a) => ({ tag: 'el', args: a }),
    useState: () => [initialStates[hookIndex++], () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  let loadedReady = null
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { loadedReady = handoff } } }
  new Function('require', src + '\n;return typeof module !== "undefined" ? module.exports : undefined')((spec) => {
    if (spec === 'react') return ReactReady
    throw new Error('unexpected require: ' + spec)
  })
  const modReady = loadedReady.factory((spec) => {
    if (spec === 'react') return ReactReady
    throw new Error('unexpected require: ' + spec)
  })
  let regReady = null
  modReady.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(key, cb) { if (key === 'settings.plugins.tab') regReady = cb() },
          register(opts, Component) { return { opts, Component } },
        }
      }
      return undefined
    },
    effect(fn) { return fn() },
  })
  if (!regReady || typeof regReady.Component !== 'function') { console.error('FAIL: ready-state tab not registered'); process.exit(1) }
  try {
    hookIndex = 0
    const tree = regReady.Component()
    if (!tree || tree.tag !== 'el') throw new Error('unexpected tree ' + JSON.stringify(tree))
    console.log('PASS client MarketPanel renders ready catalog + disabled/update cards without runtime errors')
  } catch (e) {
    console.error('FAIL client ready-state render smoke: ' + String((e && e.stack) || e))
    process.exit(1)
  }
}

// Local-list + queue "清空" render smoke: with localOpen true and a finished
// op in the queue, the panel must render every dependency-managed plugin
// (including non-bundle/out-of-catalog ones) and the clear-all button.
{
  const initialStates = [
    { // data
      phase: 'ready',
      plugins: [
        {
          cat: 'ui', name: 'dsh-tianshu-tui', url: 'https://github.com/huiliyi37/dsh-tianshu-tui',
          by: 'huiliyi37', desc: 'TUI', profile: 'web', source: 'github:huiliyi37/dsh-tianshu-tui',
          stars: 12, added: '2026-08-13', cmd: 'dsh plugin --profile web add github:huiliyi37/dsh-tianshu-tui',
        },
      ],
      cats: [{ id: 'all', count: 1 }],
      installed: { web: { dependencies: { 'dsh-tianshu-tui': 'github:huiliyi37/dsh-tianshu-tui' }, bundles: ['dsh-tianshu-tui'], disabled: [] } },
      updates: { web: {} },
      error: null,
    },
    { dshHome: '/tmp/dsh', dshBin: 'bin', node: 'node' }, // envInfo
    '', // binPath
    '', // query
    'all', // cat
    false, // showInstalled
    'default', // sortBy
    null, // open
    null, // op confirm
    [{ id: 'op-1', kind: 'install', profile: 'web', target: 'x', label: 'x', status: 'done', output: '', exitCode: 0, hot: false, elapsedMs: 0, timeoutMs: 120000, startedAt: Date.now() }], // ops
    true, // queueOpen
    null, // notice
    { plugins: [
      { name: 'bundle-plugin', spec: 'github:a/b', repo: 'a/b', version: '1.0.0', kind: 'github', isBundle: true, inBundles: true, disabled: false, inCatalog: true },
      { name: 'external-dep', spec: 'github:c/d', repo: 'c/d', version: null, kind: 'github', isBundle: false, inBundles: false, disabled: false, inCatalog: false },
    ], builtin: [] }, // local
    true, // localOpen
    60, // visibleCount
  ]
  let hookIndex = 0
  const ReactLocal = {
    createElement: (...a) => ({ tag: 'el', args: a }),
    useState: () => [initialStates[hookIndex++], () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  let loadedLocal = null
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { loadedLocal = handoff } } }
  new Function('require', src + '\n;return typeof module !== "undefined" ? module.exports : undefined')((spec) => {
    if (spec === 'react') return ReactLocal
    throw new Error('unexpected require: ' + spec)
  })
  const modLocal = loadedLocal.factory((spec) => {
    if (spec === 'react') return ReactLocal
    throw new Error('unexpected require: ' + spec)
  })
  let regLocal = null
  modLocal.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(key, cb) { if (key === 'settings.plugins.tab') regLocal = cb() },
          register(opts, Component) { return { opts, Component } },
        }
      }
      return undefined
    },
    effect(fn) { return fn() },
  })
  if (!regLocal || typeof regLocal.Component !== 'function') { console.error('FAIL: local-state tab not registered'); process.exit(1) }
  try {
    hookIndex = 0
    const tree = regLocal.Component()
    const hasExternal = JSON.stringify(tree).includes('external-dep')
    const hasClearAll = JSON.stringify(tree).includes('清空')
    if (!tree || tree.tag !== 'el') throw new Error('unexpected tree ' + JSON.stringify(tree))
    if (!hasExternal || !hasClearAll) throw new Error('local/external or clear-all not rendered: external=' + hasExternal + ' clearAll=' + hasClearAll)
    console.log('PASS client MarketPanel renders all local plugins + queue clear-all button')
  } catch (e) {
    console.error('FAIL client local/queue render smoke: ' + String((e && e.stack) || e))
    process.exit(1)
  }
}

// --- installedPkgName: case-insensitive repo/key matching (issue #1) ---
// installedPkgName is a closure inside the bundle factory, so extract its
// exact source text (together with the two helpers it calls) and evaluate it
// standalone. This tests the production code, not a re-implementation.
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name)
  if (start < 0) throw new Error('function not found in client.js: ' + name)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces while extracting ' + name)
}
const installedPkgName = new Function(
  extractFunction(src, 'repoNameOf') + '\n' +
  extractFunction(src, 'repoOfValue') + '\n' +
  extractFunction(src, 'repoPathOf') + '\n' +
  extractFunction(src, 'installedPkgName') + '\n; return installedPkgName',
)()

let matchFailures = 0
function checkMatch(name, ok, detail) {
  if (ok) console.log('PASS ' + name)
  else { console.error('FAIL ' + name + ': ' + String(detail)); matchFailures++ }
}

// Repro from issue #1: npm dep key is lowercase, catalog repo is mixed case.
const mixedRepo = { url: 'https://github.com/omdsh-dev/DSH-better-sidebar' }
checkMatch('installedPkgName deps key ignores case (issue #1 repro)',
  installedPkgName(mixedRepo, { dependencies: { 'dsh-better-sidebar': '^1.0.0' } }) === 'dsh-better-sidebar',
  installedPkgName(mixedRepo, { dependencies: { 'dsh-better-sidebar': '^1.0.0' } }))
checkMatch('installedPkgName scoped deps key ignores case',
  installedPkgName({ url: 'https://github.com/Anionex/dsh-vision-toolkit' }, { dependencies: { '@anionex/DSH-VISION-TOOLKIT': '^1.0.0' } }) === '@anionex/DSH-VISION-TOOLKIT',
  installedPkgName({ url: 'https://github.com/Anionex/dsh-vision-toolkit' }, { dependencies: { '@anionex/DSH-VISION-TOOLKIT': '^1.0.0' } }))
checkMatch('installedPkgName github: deps key ignores case',
  installedPkgName(mixedRepo, { dependencies: { 'github:dsh-better-sidebar': 'github:omdsh-dev/DSH-better-sidebar' } }) === 'github:dsh-better-sidebar',
  installedPkgName(mixedRepo, { dependencies: { 'github:dsh-better-sidebar': 'github:omdsh-dev/DSH-better-sidebar' } }))
checkMatch('installedPkgName deps value repo ignores case',
  installedPkgName(mixedRepo, { dependencies: { alias: 'github:omdsh-dev/dsh-better-sidebar' } }) === 'alias',
  installedPkgName(mixedRepo, { dependencies: { alias: 'github:omdsh-dev/dsh-better-sidebar' } }))
checkMatch('installedPkgName bundle entry ignores case',
  installedPkgName(mixedRepo, { bundles: ['dsh-better-sidebar'] }) === 'dsh-better-sidebar',
  installedPkgName(mixedRepo, { bundles: ['dsh-better-sidebar'] }))
checkMatch('installedPkgName still rejects unrelated package',
  installedPkgName(mixedRepo, { dependencies: { 'other-plugin': '^1.0.0' }, bundles: [] }) === null,
  installedPkgName(mixedRepo, { dependencies: { 'other-plugin': '^1.0.0' }, bundles: [] }))

// --- author-aware matching: same repo basename, different owners (the bug) ---
// The catalog actually carries both Jesse-njx/dsh-memory and flymysql/dsh-memory;
// installing one must not mark the other author's card as installed.
const jesse = { url: 'https://github.com/Jesse-njx/dsh-memory' }
const flymysql = { url: 'https://github.com/flymysql/dsh-memory' }
const colliding = { dependencies: { 'dsh-memory': 'github:Jesse-njx/dsh-memory' }, bundles: ['dsh-memory'] }
checkMatch('collision: author-identical card reports installed',
  installedPkgName(jesse, colliding) === 'dsh-memory', installedPkgName(jesse, colliding))
checkMatch('collision: other-author card is NOT installed (regression)',
  installedPkgName(flymysql, colliding) === null, installedPkgName(flymysql, colliding))

// Host-resolved identity (repos map) disambiguates npm-keyed installs: the
// dependency key is the short name but the manifest resolves the real owner.
checkMatch('collision: host repos identity marks the installed author',
  installedPkgName(flymysql, { dependencies: { 'dsh-memory': '^1.0.0' }, repos: { 'dsh-memory': 'flymysql/dsh-memory' } }) === 'dsh-memory',
  installedPkgName(flymysql, { dependencies: { 'dsh-memory': '^1.0.0' }, repos: { 'dsh-memory': 'flymysql/dsh-memory' } }))
checkMatch('collision: host repos identity rejects the other author',
  installedPkgName(jesse, { dependencies: { 'dsh-memory': '^1.0.0' }, repos: { 'dsh-memory': 'flymysql/dsh-memory' } }) === null,
  installedPkgName(jesse, { dependencies: { 'dsh-memory': '^1.0.0' }, repos: { 'dsh-memory': 'flymysql/dsh-memory' } }))

// github: spec with #fragment and mixed case still resolves to identity.
checkMatch('collision: github: value with #fragment matches by identity',
  installedPkgName(jesse, { dependencies: { 'dsh-memory': 'github:Jesse-njx/dsh-memory#abc123' } }) === 'dsh-memory',
  installedPkgName(jesse, { dependencies: { 'dsh-memory': 'github:Jesse-njx/dsh-memory#abc123' } }))

// repoPathOf unit checks: monorepo sub-paths, .git, scoped npm, versions.
const repoPathOf = new Function(
  extractFunction(src, 'repoPathOf') + '\n; return repoPathOf',
)()
checkMatch('repoPathOf strips host + tree subpath',
  repoPathOf('https://github.com/PC2005-cloud/dsh-pet/tree/main/dsh-pet') === 'pc2005-cloud/dsh-pet', repoPathOf('https://github.com/PC2005-cloud/dsh-pet/tree/main/dsh-pet'))
checkMatch('repoPathOf strips .git and case',
  repoPathOf('https://github.com/omdsh-dev/DSH-better-sidebar.git') === 'omdsh-dev/dsh-better-sidebar', repoPathOf('https://github.com/omdsh-dev/DSH-better-sidebar.git'))
checkMatch('repoPathOf accepts github: spec',
  repoPathOf('github:huiliyi37/dsh-tianshu-tui') === 'huiliyi37/dsh-tianshu-tui', repoPathOf('github:huiliyi37/dsh-tianshu-tui'))
checkMatch('repoPathOf null for scoped npm name (scope != owner)',
  repoPathOf('@anionex/dsh-vision-toolkit') === null, repoPathOf('@anionex/dsh-vision-toolkit'))
checkMatch('repoPathOf null for version range',
  repoPathOf('^1.0.0') === null, repoPathOf('^1.0.0'))
checkMatch('repoPathOf null for relative path',
  repoPathOf('../foo/bar') === null, repoPathOf('../foo/bar'))

// localFromInstalled: the fallback for old hosts without `installedAll` must
// still list every dependency-managed plugin, including non-bundle external
// deps, and mark catalog membership using the same identity rules.
const localFromInstalled = new Function(
  extractFunction(src, 'repoNameOf') + '\n' +
  extractFunction(src, 'repoOfValue') + '\n' +
  extractFunction(src, 'repoPathOf') + '\n' +
  extractFunction(src, 'installedPkgName') + '\n' +
  extractFunction(src, 'localFromInstalled') + '\n; return localFromInstalled',
)()
const fallbackLocal = localFromInstalled({
  dependencies: {
    'github-dep': 'github:Jesse-njx/dsh-memory',
    'fake-installed': '^1.0.0',
    'other-dep': 'github:someone/else',
  },
  bundles: ['fake-installed', 'builtin-bundle'],
  disabled: ['fake-installed'],
  repos: { 'github-dep': 'jesse-njx/dsh-memory', 'fake-installed': null, 'other-dep': 'someone/else' },
}, [
  { url: 'https://github.com/Jesse-njx/dsh-memory' },
  { url: 'https://github.com/other/dsh-memory' },
])
checkMatch('localFromInstalled lists non-bundle external dep',
  fallbackLocal.plugins.some((p) => p.name === 'github-dep' && p.inBundles === false && p.inCatalog === true),
  fallbackLocal.plugins)
checkMatch('localFromInstalled keeps bundle deps and disabled state',
  fallbackLocal.plugins.some((p) => p.name === 'fake-installed' && p.inBundles === true && p.disabled === true),
  fallbackLocal.plugins)
checkMatch('localFromInstalled builtin from bundles without deps',
  Array.isArray(fallbackLocal.builtin) && fallbackLocal.builtin.includes('builtin-bundle'),
  fallbackLocal.builtin)
checkMatch('localFromInstalled marks non-catalog dep external',
  fallbackLocal.plugins.some((p) => p.name === 'other-dep' && p.inCatalog === false),
  fallbackLocal.plugins)
if (matchFailures > 0) process.exit(1)
