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
