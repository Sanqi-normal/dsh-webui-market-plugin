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
if (mod.inject.join(',') !== 'slots') { console.error('FAIL: inject=' + mod.inject); process.exit(1) }

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
if (matchFailures > 0) process.exit(1)
