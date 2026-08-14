// Local harness for lib/host.js: mounts the plugin against a fake webServer and
// exercises the API surface + op pipeline with a fake CLI bin (no real profile
// or network install is touched). Run: node --test tests/host.test.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// --- read-only API surface ---
// dshBin auto-detection keys off the web server's cwd (the harness checkout);
// under the test runner the cwd is this repo, so pin the DSH_BIN fallback.
process.env.DSH_BIN = process.execPath
const probe = await call({ method: 'probe' })
check('probe env', probe.ok && probe.dshHome && probe.node && probe.dshBin, probe)

const inst = await call({ method: 'installed' })
check('installed shape', inst.ok && Array.isArray(inst.bundles) && typeof inst.dependencies === 'object', inst)

const emptyOp = await call({ method: 'op' })
check('op empty -> null', emptyOp.ok && emptyOp.op === null, emptyOp)

const list = await call({ method: 'list', lang: 'zh' })
if (!list.ok) skip('list zh (real site)')
else check('list zh (real site)', Array.isArray(list.plugins) && list.plugins.length >= 90, JSON.stringify(list).slice(0, 160))

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
// A fake bin in "boot mode" (invoked with --port, no plugin subcommand) prints
// the dsh web: readiness line; otherwise it behaves like the CLI install.
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

// A fake bin whose install step succeeds but whose boot step fails without
// printing the readiness line → boot verdict fails with the boot error.
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

// A fake bin that fails at the install step → install stage verdict.
writeFileSync(probeBin, `process.stdout.write('pnpm: network unreachable\\n')\nprocess.exit(1)\n`)
const probeInstallFail = await mod.runProbe(probeBin, 'fake:neterr')
check('probe fails on install error', probeInstallFail.ok === false && probeInstallFail.stage === 'install' && /pnpm/.test(probeInstallFail.output || ''), probeInstallFail)

// --- same-origin gate on write operations ---
const crossOrigin = await call({ method: 'install', source: 'fake:any', profile: 'web', binPath: process.execPath }, { origin: 'http://evil.example' })
check('install rejected cross-origin', crossOrigin.ok === false && /untrusted/.test(crossOrigin.error || ''), crossOrigin)

const crossKill = await call({ method: 'kill' }, { origin: 'http://evil.example' })
check('kill rejected cross-origin', crossKill.ok === false && /untrusted/.test(crossKill.error || ''), crossKill)

// --- source whitelist (curated catalog only) ---
const notListed = await call({ method: 'install', source: 'github:somebody/not-in-catalog', profile: 'web', binPath: process.execPath })
check('install rejected when not in curated catalog', notListed.ok === false && notListed.refused === true && /精选目录/.test(notListed.output || ''), notListed)

// A github: source that IS in the catalog passes the whitelist (then the probe
// path would run; skipCheck bypasses to keep this fast and offline-safe).
const wlBin = join(tmpdir(), 'mkts-wl-bin-' + process.pid + '.mjs')
writeFileSync(wlBin, `process.exit(0)\n`)
const listedOk = await call({ method: 'install', source: 'github:huiliyi37/dsh-tianshu-tui', profile: 'web', binPath: wlBin, skipCheck: true })
check('catalog-listed github source passes whitelist', listedOk.ok === true && listedOk.opId, listedOk)
await call({ method: 'kill' }) // cancel the started op

// whitelistSource unit-level: registry/link specs are not gated.
const wl = await mod.whitelistSource('@some/pkg', [{ source: 'github:a/b' }])
check('whitelist ignores registry spec', wl.allowed === true, wl)

// --- catalog snapshot fallback (bundled data/catalog-snapshot.json) ---
const snap = JSON.parse(readFileSync(join(dirname(fileURLToPath(new URL('../lib/host.js', import.meta.url))), '..', 'data', 'catalog-snapshot.json'), 'utf8'))
check('snapshot exists and non-empty', Array.isArray(snap.plugins) && snap.plugins.length > 0 && Array.isArray(snap.cats), snap.updated)

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

const updNotInstalled = await call({ method: 'update', name: 'not-installed-pkg', profile: 'web', binPath: process.execPath })
check('update rejects not-installed', updNotInstalled.ok === false && /未安装/.test(updNotInstalled.output || ''), updNotInstalled)

// checkUpdates degrades gracefully with no real profile / lockfile.
const cu = await mod.checkUpdates('__no_such_profile__')
check('checkUpdates degrades on missing profile', typeof cu === 'object' && Object.keys(cu).length === 0, cu)

// --- op pipeline with a fake CLI bin (never touches the real profile) ---
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
// args: node <bin> plugin --profile <p> add <t>  -> fake bin receives all args.
const opCall = await call({ method: 'install', source: 'fake:test', profile: 'web', binPath: fakeBin, label: 'fake plugin' })
check('install starts op', opCall.ok && opCall.opId, opCall)

await new Promise((r) => setTimeout(r, 900))
const opState = await call({ method: 'op' })
check('op settles done with output', opState.ok && opState.op && opState.op.status === 'done' && /fake-bin running/.test(opState.op.output), opState.op && opState.op)

const opId = opState.op.id
const opById = await call({ method: 'op', opId })
check('op by id matches', opById.ok && opById.op && opById.op.id === opId, opById)

// kill path: start a long-running fake bin, then kill.
// skipCheck: true skips the trial-boot probe so the op starts immediately.
writeFileSync(fakeBin, `setTimeout(() => {}, 60000)\n`)
const op2 = await call({ method: 'install', source: 'fake:slow', profile: 'web', binPath: fakeBin, label: 'slow', skipCheck: true })
check('second install starts (first settled)', op2.ok && op2.opId, op2)
await new Promise((r) => setTimeout(r, 300))
const k = await call({ method: 'kill' })
check('kill requested', k.ok, k)
await new Promise((r) => setTimeout(r, 600))
const opAfterKill = await call({ method: 'op', opId: op2.opId })
check('op status killed', opAfterKill.ok && opAfterKill.op && opAfterKill.op.status === 'killed', opAfterKill)

// busy refusal while an op is still live
writeFileSync(fakeBin, `setTimeout(() => {}, 60000)\n`)
const op3 = await call({ method: 'install', source: 'fake:slow2', profile: 'web', binPath: fakeBin, label: 'slow2', skipCheck: true })
check('third op starts', op3.ok && op3.opId, op3)
await new Promise((r) => setTimeout(r, 200))
const busy = await call({ method: 'install', source: 'github:x/y', profile: 'web', binPath: fakeBin, label: 'dup' })
check('busy while op live', busy.ok === false && busy.busy === true, busy)
await call({ method: 'kill' })

const tail = skipped > 0 ? ' (' + skipped + ' skipped)' : ''
console.log(failures === 0 ? 'ALL PASS' + tail : failures + ' FAILURES' + tail)
process.exit(failures === 0 ? 0 : 1)
