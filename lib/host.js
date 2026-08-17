// Host half of the persistent plugin market. Registers one HTTP route
// (/api/dsh-market) that the browser UI calls to list, inspect, install, and
// uninstall community plugins. Runs as an ordinary Cordis plugin, so the full
// Node environment (process, fs, global fetch) is available.
//
// Install/uninstall run as background operations: the route returns an op id
// immediately, the browser polls it, and a hard timeout kills the child so a
// dead network cannot hang the request forever.
//
// Before installing into the web profile, a "trial boot" probe verifies the
// candidate actually boots: the same dsh CLI installs it into a throwaway
// DSH_HOME profile, boots that profile on a free OS-assigned port (--port 0),
// and waits for the `dsh web:` readiness line — which the web-app glue prints
// only after its Loader tree settles successfully. A bundle that duplicates a
// built-in service (api-gateway, webserver, ...) or otherwise breaks boot
// never reaches that line, so the probe refuses it with the real boot error,
// and the real profile has never been touched. Static manifest heuristics are
// gone: only the boot verdict decides installability.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'dsh-market-plugin'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

/** Hard per-op timeout. Users with slow/CN networks may raise it via env:
 * DSH_MARKET_OP_TIMEOUT_MS=300000. */
const DEFAULT_TIMEOUT = Number(process.env.DSH_MARKET_OP_TIMEOUT_MS) > 0 ? Number(process.env.DSH_MARKET_OP_TIMEOUT_MS) : 120000

/** Shell-mediated spawns (bare `dsh` on Windows via cmd /c) must never pass
 * unvalidated argv through the shell: metacharacters would inject. Fail closed.
 * Mirrors dsh-market's TARGET_RE (#16). */
const TARGET_RE = /^[A-Za-z0-9@:./_#+-]+$/

/** Shown when no dsh entry could be resolved at all (not even on PATH). */
const CLI_NOT_FOUND_HINT = 'dsh CLI 未定位：请在面板填写 dsh 仓库根目录下的 apps/cli/lib/bin.js（源码启动为 apps/cli/src/bin.ts），或设置 DSH_BIN 指向该文件后重启 web'

/**
 * pnpm network controls for every spawned dsh/pnpm child. The default pnpm
 * fetch timeout/retry behavior can hang for a long time on dead or unstable
 * connections ("GET ... error" + endless Retrying). We keep the retries low and
 * the per-attempt timeout bounded so a dead network fails fast inside the op's
 * hard timeout instead of burning it on pnpm's internal retry loop.
 * Users can still override each knob through DSH_MARKET_* environment vars.
 */
function pnpmNetworkEnv() {
  return {
    CI: 'true',
    npm_config_fetch_timeout: process.env.DSH_MARKET_FETCH_TIMEOUT_MS || '30000',
    npm_config_fetch_retries: process.env.DSH_MARKET_FETCH_RETRIES || '1',
    npm_config_fetch_retry_mintimeout: process.env.DSH_MARKET_FETCH_RETRY_MINTIMEOUT_MS || '1000',
    npm_config_fetch_retry_maxtimeout: process.env.DSH_MARKET_FETCH_RETRY_MAXTIMEOUT_MS || '10000',
  }
}

/** Common pnpm/fetch network failures that benefit from a bounded retry and a clear hint. */
const NETWORK_ERROR_RE = /(?:ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|ERR_SOCKET|SOCKETTIMEDOUT|getaddrinfo|tunneling socket|fetch failed|network unreachable|Retrying|GET .* error)/i

function isNetworkFailure(text) {
  return NETWORK_ERROR_RE.test(String(text || ''))
}

/** Terminal op statuses that never run again. */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'killed', 'timeout', 'refused'])
/** How many finished ops the `op` endpoint reports to the browser. */
const MAX_OP_HISTORY = 20
/** How many finished ops stay in memory before being pruned. */
const MAX_OP_MEMORY = 100

// Ops run strictly FIFO: one live child (or trial-boot check) at a time keeps
// the CLI's pnpm serial; the rest wait in `ops` with status `pending`.
// `runningOp` is the op whose check/child is live right now.
let ops = []
let runningOp = null
let pumping = false
let opCounter = 0

function parseCmd(cmd) {
  if (!cmd) return null
  const m = /^dsh plugin --profile (\S+) (\w+)(?:\s+(\S+))?/.exec(String(cmd).trim())
  if (!m) return null
  return { profile: m[1], action: m[2], source: m[3] || '' }
}

function dshHome() {
  return process.env.DSH_HOME || (homedir() + '/.dsh')
}

/**
 * Probe PATH for a runnable `dsh` (the npm-installed CLI). The win32 shim is
 * a .cmd/.bat wrapper; POSIX ships a shebang script named `dsh`. Only decides
 * whether the bare-`dsh` spawn fallback can work: the fallback spawns the bare
 * name so the shell resolves it (a quoted absolute shim path breaks cmd /c
 * argument parsing when the path contains spaces).
 * @returns {string|null} first PATH hit, or null when `dsh` is not on PATH.
 */
function dshOnPath() {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.bat', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    const base = dir.trim().replace(/^"|"$/g, '')
    if (!base) continue
    for (const name of names) {
      const cand = join(base, name)
      try { if (existsSync(cand)) return cand } catch {}
    }
  }
  return null
}

/**
 * Resolve the dsh CLI entry. Prefers the exact entry that launched THIS host
 * process (global bin, local install, or `node --import tsx/esm .../bin.ts`
 * source launch), so installs work in every launch shape; falls back to the
 * checkout's bin, $DSH_BIN, and finally a bare `dsh` on PATH (the environment
 * that hosts this plugin necessarily has a dsh somewhere).
 * @param {string} [explicit] - a hand-filled CLI path (panel), used verbatim.
 * @returns {{ file: string, args: string[], cwd?: string, shell?: boolean } | null}
 * argv prefix to re-invoke the CLI: process.execPath + (execArgv for source
 * launches) + the entry. For source launches the caller must use the returned
 * `cwd` (the entry's directory) as the spawn cwd: execArgv loaders like tsx
 * resolve from there, not from the profile directory. `shell: true` (only for
 * the bare-`dsh` PATH fallback on Windows) means the caller MUST spawn with
 * shell and MUST pass argv through the TARGET_RE allowlist first.
 */
function dshInvoke(explicit) {
  if (explicit && explicit.trim()) {
    return invokeEntry(explicit.trim())
  }
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // Absolutize: pnpm source launches pass a RELATIVE entry
    // (apps/cli/src/bin.ts); a child would re-resolve it against its own cwd
    // and die with MODULE_NOT_FOUND (mirrors dsh-market#13).
    return invokeEntry(resolve(entry))
  }
  const cand = process.cwd().replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
  try {
    if (existsSync(cand)) return { file: process.execPath, args: [cand], cwd: undefined }
  } catch {}
  if (process.env.DSH_BIN) return invokeEntry(resolve(process.env.DSH_BIN))
  // Last resort: bare `dsh` on PATH. On Windows the installed `dsh` is a .cmd
  // shim only a shell can start, so spawn callers must pass shell:true.
  if (dshOnPath()) return { file: 'dsh', args: [], cwd: undefined, shell: process.platform === 'win32' }
  return null
}

/**
 * Build the node argv for one CLI entry. A `.ts` entry needs the tsx loader:
 * execArgv loaders do NOT propagate to spawned children, so they are re-added
 * explicitly (deduplicated against what the host already runs under). For
 * source launches cwd is pinned to the entry's directory so the loader can
 * resolve from the harness's node_modules.
 * @returns {{ file: string, args: string[], cwd: string | undefined }}
 */
function invokeEntry(entry) {
  const isTs = /\.ts$/.test(entry)
  const loader = isTs && !process.execArgv.some((a) => String(a).includes('tsx'))
    ? ['--import', 'tsx']
    : []
  return {
    file: process.execPath,
    args: [...process.execArgv, ...loader, entry],
    cwd: isTs ? dirname(entry) : undefined,
  }
}

/** The resolved CLI entry path, for display/probing; null when undetectable. */
function dshBin(explicit) {
  const inv = dshInvoke(explicit)
  if (inv === null) return null
  return inv.args.length > 0 ? inv.args[inv.args.length - 1] : inv.file
}

function profileDir(profile) {
  return dshHome().replace(/[\\/]+$/, '') + '/profiles/' + profile
}

/**
 * Enumerate initialized profiles under $DSH_HOME/profiles. `node_modules` is
 * the shared flat-module fallback, not a profile; a directory without a
 * readable manifest is skipped. Powers the cross-profile surface (install
 * target selector + one-click sync to a desktop profile): the market never
 * guesses profile names — only profiles that actually exist are offered.
 * @returns {Array<{name: string, bundles: string[], depCount: number}>}
 * sorted with `web` first (the host's own profile), then by name.
 */
function listProfiles() {
  const out = []
  try {
    for (const entry of readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || !validProfile(entry.name)) continue
      const json = readProfileManifest(entry.name)
      if (!json) continue
      out.push({
        name: entry.name,
        bundles: Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles) ? json.dsh.profile.bundles : [],
        depCount: Object.keys((json.dependencies) || {}).length,
      })
    }
  } catch {}
  out.sort((a, b) => (a.name === 'web' ? -1 : b.name === 'web' ? 1 : a.name.localeCompare(b.name)))
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** Same-origin check: the browser's Origin host must equal the request Host. */
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function validProfile(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]+$/.test(p)
}

/** Public view of one op (output capped for the browser). */
function opView(op) {
  if (!op) return null
  const { id, kind, profile, target, label, startedAt, status, output, exitCode, bin, hot } = op
  return {
    id, kind, profile, target, label, startedAt,
    status, output: String(output || '').slice(-20000), exitCode,
    elapsedMs: Date.now() - (startedAt || Date.now()),
    timeoutMs: DEFAULT_TIMEOUT,
    bin: bin || null,
    hot: hot === true,
  }
}

/**
 * Queue snapshot for the browser: current live op, everything pending, and a
 * bounded tail of finished ops. With an explicit opId only that op is returned.
 */
function opSnapshot(opId) {
  if (opId) {
    const hit = ops.find((o) => o.id === opId)
    return hit && !hit.dismissed ? opView(hit) : null
  }
  const pending = ops.filter((o) => o.status === 'pending')
  const history = ops
    .filter((o) => TERMINAL_STATUSES.has(o.status) && !o.dismissed)
    .slice(-MAX_OP_HISTORY)
    .reverse()
  return {
    op: runningOp ? opView(runningOp) : null,
    queue: pending.map(opView),
    history: history.map(opView),
  }
}

/**
 * Mark a finished op as dismissed so it disappears from every future queue
 * snapshot (including after a page refresh/reopen) while the host lives.
 */
function clearOp(opId) {
  const op = ops.find((o) => o.id === opId)
  if (!op) return { ok: false, error: '任务不存在：' + opId }
  if (!TERMINAL_STATUSES.has(op.status)) return { ok: false, error: '只能清除已结束的任务' }
  op.dismissed = true
  return { ok: true }
}

/** Mark every finished op as dismissed so future snapshots omit them all. */
function clearAllOps() {
  let count = 0
  for (const op of ops) {
    if (TERMINAL_STATUSES.has(op.status) && !op.dismissed) {
      op.dismissed = true
      count++
    }
  }
  return { ok: true, count }
}

/** Kill a running child, killing its whole process tree on Windows. */
function killChild(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  } catch {}
}

/** Terminal output cap: pnpm logs can be large; keep the tail only. */
const MAX_OUTPUT = 200000

function appendOutput(op, text) {
  op.output = (op.output + String(text)).slice(-MAX_OUTPUT)
}

/** Settle an op to a terminal status, drop its timer, and wake its waiter. */
function settleOp(op, status, exitCode) {
  clearTimeout(op.timer)
  if (!TERMINAL_STATUSES.has(op.status)) op.status = status
  if (exitCode !== undefined) op.exitCode = exitCode
  resolveOp(op)
}

/**
 * Auto-heal pnpm's supply-chain release-age gate (pnpm >=11 enables a 24h
 * minimumReleaseAge by default): when an op fails because freshly published
 * packages fall inside that window, merge the flagged name@version entries
 * into the profile's pnpm-workspace.yaml 'minimumReleaseAgeExclude' list.
 * Same-name versions are written as ONE 'name@v1||v2' union - pnpm's policy
 * matcher only ever consults the first rule whose package name matches, so
 * separate same-name entries silently ignore every version after the first
 * (the exact bug that made this heal necessary).
 * @returns {string[]} the flagged entries ensured present; empty when nothing
 * was healed (no violation in the output, unparseable output, or write failed).
 */
function healReleaseAgeExclude(profile, output) {
  const text = String(output || '')
  if (!/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge/.test(text)) return []
  const flagged = new Set()
  for (const m of text.matchAll(/([^\s]+) was published at [^,\n]+, within the minimumReleaseAge cutoff/g)) {
    const entry = String(m[1] || '').trim()
    if (/^[@A-Za-z0-9_.-]+@[0-9]/.test(entry)) flagged.add(entry)
  }
  if (flagged.size === 0) return []
  const yamlPath = join(profileDir(profile), 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) return []
  try {
    const yaml = readFileSync(yamlPath, 'utf8')
    const blockRe = /^minimumReleaseAgeExclude:\n((?:[ \t]+- .*(?:\n|$))*)/m
    const existing = new Map() // package name -> Set(versions)
    const addEntry = (entry) => {
      const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0)
      if (at <= 0) return
      const name = entry.slice(0, at)
      if (!existing.has(name)) existing.set(name, new Set())
      for (const v of entry.slice(at + 1).split('||')) {
        const t = v.trim()
        if (t) existing.get(name).add(t)
      }
    }
    const m = blockRe.exec(yaml)
    if (m) {
      for (const line of m[1].split('\n')) {
        const mm = /^\s*-\s*(.+?)\s*$/.exec(line)
        if (mm) addEntry(mm[1].replace(/^['"]|['"]$/g, ''))
      }
    }
    for (const e of flagged) addEntry(e)
    const rows = []
    for (const [name, versions] of existing) {
      // Scoped names must stay quoted: an unquoted leading '@' is not a valid
      // YAML plain scalar (pnpm writes them quoted for the same reason).
      const label = name.startsWith('@') ? "'" + name + '@' + [...versions].sort().join('||') + "'" : name + '@' + [...versions].sort().join('||')
      rows.push('  - ' + label)
    }
    const block = 'minimumReleaseAgeExclude:\n' + rows.join('\n') + '\n'
    const next = m
      ? yaml.slice(0, m.index) + block + yaml.slice(m.index + m[0].length)
      : yaml.replace(/\n*$/, '') + '\n' + block
    if (next === yaml) return []
    writeFileSync(yamlPath, next)
    return [...flagged]
  } catch {
    return []
  }
}

/**
 * Extract package names from pnpm's ERR_PNPM_IGNORED_BUILDS diagnostic line
 * ("Ignored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, ...").
 * Scoped names keep their leading '@'; a trailing @<version> is stripped.
 * @returns {string[]} distinct package names; empty when the marker is absent.
 */
function parseIgnoredBuilds(output) {
  const text = String(output || '')
  const m = /ERR_PNPM_IGNORED_BUILDS\][^\n]*Ignored build scripts:\s*([^\n]+)/.exec(text)
  if (!m) return []
  const names = []
  for (const token of m[1].split(',')) {
    const name = token.trim().replace(/@[0-9][^\s]*$/, '')
    if (/^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?$/.test(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Merge `allowBuilds: { name: true }` entries into a pnpm-workspace.yaml
 * document, preserving every other key. Existing entries are kept (sorted
 * union with the fresh names); scoped names stay quoted because an unquoted
 * leading '@' is not a valid YAML plain scalar (pnpm writes them quoted for
 * the same reason). @returns {string|null} the next document, or null when
 * every requested name is already allowed.
 */
function mergeAllowBuilds(yaml, names) {
  const blockRe = /^allowBuilds:\n((?:[ \t]+[^\n]*(?:\n|$))*)/m
  const m = blockRe.exec(yaml)
  const existing = new Set()
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = /^\s*([^:#\s][^:]*?)\s*:\s*(?:true|false)\s*$/.exec(line)
      if (mm) existing.add(mm[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  const missing = [...new Set(names)].filter((n) => !existing.has(n)).sort()
  if (missing.length === 0) return null
  const rows = [...existing, ...missing].sort().map((n) =>
    '  ' + (n.startsWith('@') ? "'" + n + "'" : n) + ': true')
  const block = 'allowBuilds:\n' + rows.join('\n') + '\n'
  return m
    ? yaml.slice(0, m.index) + block + yaml.slice(m.index + m[0].length)
    : yaml.replace(/\n*$/, '') + '\n' + block
}

/**
 * Approve the build scripts pnpm flagged in `output` by merging them into the
 * allowBuilds map of the pnpm-workspace.yaml at `yamlPath`.
 * @returns {string[]} the approved package names; empty when the output holds
 * no IGNORED_BUILDS marker or the file is missing/unwritable.
 */
function approveBuildsIn(yamlPath, output) {
  const names = parseIgnoredBuilds(output)
  if (names.length === 0) return []
  if (!existsSync(yamlPath)) return []
  try {
    const next = mergeAllowBuilds(readFileSync(yamlPath, 'utf8'), names)
    if (next === null) return []
    writeFileSync(yamlPath, next)
    return names
  } catch {
    return []
  }
}

/**
 * Auto-heal pnpm's build-script approval gate (pnpm >=11 fails the install
 * with ERR_PNPM_IGNORED_BUILDS for every dependency whose build script is not
 * allowed): parse the flagged package names out of a failed op's output and
 * merge them into the profile's pnpm-workspace.yaml 'allowBuilds' map — the
 * same file pnpm's own `approve-builds` command edits. Approving matches the
 * user-visible intent of the install op; for the web profile the trial-boot
 * probe still gates the boot verdict.
 * @returns {string[]} the approved package names; empty when nothing was healed.
 */
function healAllowBuilds(profile, output) {
  return approveBuildsIn(join(profileDir(profile), 'pnpm-workspace.yaml'), output)
}

function resolveOp(op) {
  const resolve = op.resolve
  if (resolve) {
    op.resolve = null
    resolve()
  }
}

/** Host ctx for hot-mounting, set by apply(); null in headless/test contexts. */
let hotCtx = null

/**
 * Enqueue one install/update/uninstall op. Returns immediately with an opId;
 * safety checks and the CLI child run when the op reaches the queue head.
 * A duplicate live/pending op for the same kind+profile+target is refused so
 * one plugin cannot race itself.
 */
function enqueueOp(kind, profile, target, label, explicitBin, initialOutput, extra = {}) {
  const inv = dshInvoke(explicitBin)
  if (!inv) return { ok: false, error: CLI_NOT_FOUND_HINT }
  const bin = inv.args.length > 0 ? inv.args[inv.args.length - 1] : inv.file
  const dup = ops.find((o) => (o.status === 'pending' || o.status === 'checking' || o.status === 'running')
    && o.kind === kind && o.profile === profile && o.target === target)
  if (dup) {
    return { ok: false, busy: true, output: '该插件已有同样的任务在排队或执行中：' + String(dup.label || target) }
  }
  const op = {
    id: 'op-' + (++opCounter),
    kind, profile, target, label,
    startedAt: Date.now(), // enqueue time; reset when execution actually starts
    status: 'pending',
    output: initialOutput || '',
    exitCode: null,
    bin,
    hot: false,
    skipCheck: extra.skipCheck === true,
    // Sync provenance: set for cross-profile sync installs. The op's target
    // must be an already-installed dependency of this source profile — the
    // whitelist is then bypassed because the user already accepted the
    // package there; a local copy is not a new remote trust decision.
    syncFrom: typeof extra.syncFrom === 'string' && validProfile(extra.syncFrom) ? extra.syncFrom : '',
    beforeDeps: null,
    child: null,
    checkAbort: null,
    timer: null,
    resolve: null,
    inv,
  }
  ops.push(op)
  if (ops.length > MAX_OP_MEMORY) {
    const terminal = ops.filter((o) => TERMINAL_STATUSES.has(o.status))
    while (ops.length > MAX_OP_MEMORY && terminal.length > 0) {
      const idx = ops.indexOf(terminal.shift())
      if (idx >= 0) ops.splice(idx, 1)
    }
  }
  advanceQueue()
  return { ok: true, opId: op.id, timeoutMs: DEFAULT_TIMEOUT }
}

/** Start the next pending op; exactly one op is live at any time. */
function advanceQueue() {
  if (pumping) return
  const next = ops.find((o) => o.status === 'pending')
  if (!next) return
  pumping = true
  void (async () => {
    try {
      await runQueuedOp(next)
    } catch (e) {
      appendOutput(next, '\n[error] ' + String((e && e.message) || e))
      settleOp(next, 'failed')
    } finally {
      pumping = false
      advanceQueue()
    }
  })()
}

/**
 * Execute one queued op: pre-flight steps (uninstall dispose, install
 * whitelist + trial boot) happen here — never in the HTTP handler — so the
 * queue behind this op is never blocked by a 1-6 minute trial boot.
 */
async function runQueuedOp(op) {
  op.startedAt = Date.now()
  op.status = 'checking'
  runningOp = op
  // Any dependency-changing op invalidates update detection before it starts.
  // A stale cache must not survive an install/update/uninstall even when a
  // concurrent `updates` request repopulates it while the op is in flight.
  updatesCache = { ...updatesCache, [op.profile]: null }
  try {
    if (op.kind === 'uninstall' && op.profile === 'web') {
      // Dispose the live hot mount FIRST, then disable any loader entry under
      // the same name. `dsh plugin remove` only edits the persisted profile —
      // the running Loader would otherwise keep serving a bundle whose package
      // no longer exists. Both act on the RUNNING (web) composition only: an
      // uninstall from another profile (e.g. desktop) must not touch web's
      // live loader entries even when the package names collide.
      await disposeHotMount(op.target)
      await disableLoaderEntry(op.target)
    }
    if (op.kind === 'install' && !op.skipCheck) {
      // The source whitelist gates EVERY profile's installs (web and desktop
      // alike): only curated-catalog sources are accepted unless the user
      // explicitly opts out. skipCheck bypasses whitelist + trial boot.
      // Exception: sync installs whose target is provably already installed in
      // the source profile (op.syncFrom) — a local copy of an accepted
      // package, not a new remote trust decision.
      const synced = op.syncFrom !== '' && isInstalledIn(op.syncFrom, op.target)
      if (synced) {
        appendOutput(op, '该源已安装于 ' + op.syncFrom + ' profile（本地复制同步），跳过来源白名单…\n')
      } else {
        appendOutput(op, op.profile === 'web' ? '检查来源白名单与试装验证…\n' : '检查来源白名单…\n')
      }
      op.checkAbort = new AbortController()
      const catalog = await loadCatalog()
      if (op.status !== 'checking') return
      const gate = synced ? { allowed: true } : await whitelistSource(op.target, catalog.plugins)
      if (op.status !== 'checking') return
      if (!gate.allowed) {
        appendOutput(op, String(gate.reason || '') + '\n')
        settleOp(op, 'refused')
        return
      }
      // The trial boot proves the WEB profile composition still boots. Other
      // profiles (desktop shells) define their own composition that the market
      // cannot faithfully reproduce in a throwaway home, so non-web installs
      // are gated by whitelist + pre-install snapshot instead — still fully
      // non-destructive, just without the boot verdict.
      if (op.profile === 'web') {
        const cls = await classifyPlugin(op.target)
        if (op.status !== 'checking') return
        if (!cls.webClient) {
          const verdict = await runProbe(op.bin, op.target, op.checkAbort.signal)
          if (op.status !== 'checking') return
          if (!verdict.ok) {
            const stage = verdict.stage === 'install'
              ? '候选插件安装进试装环境失败'
              : '试装启动验证失败：该插件装进 web profile 无法正常启动'
            appendOutput(op, stage + '（真实 profile 未受影响，试装目录已清理）：\n\n' + String(verdict.output || '').slice(-8000)
              + '\n\n如需强制安装（风险自负），请勾选"跳过试装验证"。\n')
            settleOp(op, 'refused')
            return
          }
        }
      }
    }
    if (op.kind === 'install') {
      // Every profile install gets a pre-write manifest snapshot (manual
      // rollback anchor), skipCheck included: a failed add must never leave
      // the profile without a restore point.
      const snap = snapshotProfile(op.profile)
      appendOutput(op, snap ? '已备份安装前状态：' + snap + '\n' : '')
      op.beforeDeps = readProfileDeps(op.profile)
    }
    if (op.status !== 'checking') return
    op.status = 'running'
    // The promise must exist BEFORE spawnOpChild: its guard can settle the op
    // synchronously, and settleOp resolves through op.resolve — assigning it
    // after the call would deadlock the queue (op settled, promise never resolved).
    const done = new Promise((resolve) => { op.resolve = resolve })
    spawnOpChild(op)
    await done
  } finally {
    op.checkAbort = null
    if (runningOp === op) runningOp = null
  }
}

/** Spawn the CLI child for one op and wire output/timeout/close handling. */
function spawnOpChild(op) {
  // Shell-mediated spawns (bare `dsh` on Windows via cmd /c) must never pass
  // unvalidated argv through the shell: metacharacters would inject. Fail closed.
  if (op.inv.shell === true && !TARGET_RE.test(op.target)) {
    appendOutput(op, 'unsafe plugin target rejected under shell: ' + JSON.stringify(op.target))
    settleOp(op, 'refused')
    return
  }
  const child = spawn(op.inv.file, [...op.inv.args, 'plugin', '--profile', op.profile, op.kind === 'uninstall' ? 'remove' : 'add', op.target], {
    cwd: op.inv.cwd ?? profileDir(op.profile),
    // CI=true: pnpm v10 blocks forever on a silent interactive prompt without
    // a TTY (observed on re-add over a pinned git spec); CI forces fail-fast.
    // pnpmNetworkEnv() bounds fetch timeouts/retries so a dead network fails
    // fast instead of retrying until the 120s (or user-configured) op timeout.
    env: { ...process.env, ...pnpmNetworkEnv() },
    shell: op.inv.shell === true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  op.child = child
  child.stdout.on('data', (d) => { appendOutput(op, d.toString()) })
  child.stderr.on('data', (d) => { appendOutput(op, d.toString()) })
  child.on('error', (err) => {
    if (op.status !== 'running') return
    appendOutput(op, '\n[error] ' + String((err && err.message) || err))
    settleOp(op, 'failed')
  })
  child.on('close', async (code) => {
    if (op.status === 'running') {
      const ok = code === 0
      if (!ok && !op.retried) {
        // pnpm >=11 enforces a 24h minimumReleaseAge supply-chain policy by
        // default; a freshly published package in the lockfile fails every
        // op. Heal the profile's exclude list and retry the same command
        // exactly once (op.retried blocks any further loop).
        const healed = healReleaseAgeExclude(op.profile, op.output)
        if (healed.length > 0) {
          op.retried = true
          appendOutput(op, '\n[auto] 检测到 pnpm 供应链策略拦截（minimumReleaseAge），已将 '
            + healed.join(', ') + ' 加入 profile 的 minimumReleaseAgeExclude 并自动重试…\n')
          clearTimeout(op.timer)
          spawnOpChild(op)
          return
        }
        // pnpm >=11 fails unapproved build scripts (ERR_PNPM_IGNORED_BUILDS)
        // by default. Approve the flagged packages in the profile's allowBuilds
        // map (the same file pnpm's approve-builds edits) and retry once.
        const approved = healAllowBuilds(op.profile, op.output)
        if (approved.length > 0) {
          op.retried = true
          appendOutput(op, '\n[auto] 检测到 pnpm 构建脚本拦截（ERR_PNPM_IGNORED_BUILDS），已将 '
            + approved.join(', ') + ' 加入 profile 的 allowBuilds 并自动重试…\n')
          clearTimeout(op.timer)
          spawnOpChild(op)
          return
        }
        // Transient network failures ("GET ... error", ETIMEDOUT, ...) are
        // bounded: retry exactly once after a short pause. A persistent dead
        // network still fails fast with a clear hint instead of looping.
        if (isNetworkFailure(op.output)) {
          op.retried = true
          appendOutput(op, '\n[auto] 检测到网络错误（GET 链接 / retry），2 秒后自动重试一次；若仍失败请检查代理、镜像或网络连通性\n')
          clearTimeout(op.timer)
          await new Promise((r) => setTimeout(r, 2000))
          if (op.status !== 'running') return
          spawnOpChild(op)
          return
        }
      }
      if (ok && op.kind === 'install' && op.profile === 'web' && hotCtx !== null) {
        // Trial-boot already proved the bundle boots; hot-mount is the bonus
        // that skips the restart. Failure here only falls back to restart.
        // Web-only: a desktop-profile install cannot hot-mount into the
        // running web composition (the desktop shell boots its own process).
        const mounted = await tryHotMountAll(hotCtx, op.profile, op.beforeDeps)
        if (mounted) {
          op.hot = true
          appendOutput(op, '\n[hot] 已热挂载（无需重启，刷新页面即可使用）\n')
        } else {
          appendOutput(op, '\n[hot] 热挂载不可用（插件 patch 较复杂或环境不支持），重启 web 后生效\n')
        }
      }
      if (ok) {
        // pnpm reconcile re-adds every dependency-managed bundle; re-apply the
        // market's disabled set so disabled plugins stay dormant after ops.
        reapplyDisabledState(op.profile)
        // Invalidate again after the filesystem/profile actually changed. A
        // concurrent `updates` request can repopulate the cache with the old
        // dependency state while the op is running; clearing it here makes the
        // browser's post-op refresh recompute from the new installed state.
        updatesCache = { ...updatesCache, [op.profile]: null }
        if (op.kind === 'uninstall') forgetDisabledName(op.profile, op.target)
      } else if (isNetworkFailure(op.output)) {
        appendOutput(op, '\n[network] 网络拉取失败（可能是 GitHub/npm 不可达）。请检查代理/镜像后重试，或适当调大 DSH_MARKET_OP_TIMEOUT_MS / DSH_MARKET_FETCH_TIMEOUT_MS\n')
      }
      settleOp(op, ok ? 'done' : 'failed', code)
    }
    resolveOp(op)
  })
  op.timer = setTimeout(() => {
    if (op.status !== 'running') return
    appendOutput(op, '\n\n[timeout] 操作超过 ' + Math.round(DEFAULT_TIMEOUT / 1000) + ' 秒未完成，已自动终止（可能是网络不通或 pnpm 卡住，可重试）')
    settleOp(op, 'timeout')
    killChild(child)
  }, DEFAULT_TIMEOUT)
}

/**
 * Kill the running op, cancel a pending one (by opId), or both-less: kill the
 * current live op. A checking op's trial boot is aborted through its signal.
 */
function killOp(opId) {
  const wanted = opId
    ? ops.find((o) => o.id === opId)
    : (runningOp || ops.find((o) => o.status === 'checking' || o.status === 'running'))
  if (!wanted) return { ok: false, error: '没有可终止的任务' }
  if (TERMINAL_STATUSES.has(wanted.status)) return { ok: false, error: '任务已结束' }
  if (wanted.status === 'pending') {
    appendOutput(wanted, '\n\n[killed] 已由用户取消排队')
    settleOp(wanted, 'killed')
    advanceQueue()
    return { ok: true }
  }
  appendOutput(wanted, '\n\n[killed] 已由用户终止')
  if (wanted.checkAbort) wanted.checkAbort.abort()
  settleOp(wanted, 'killed')
  if (wanted.child) killChild(wanted.child)
  return { ok: true }
}

/** Raw manifest mirrors, tried in order; GitHub raw is unstable behind CN networks. */
const RAW_MIRRORS = [
  'https://raw.githubusercontent.com',
  'https://raw.gitmirror.com',
]

/**
 * Classify a github: source. The only static signal left is the fast path: a
 * manifest that declares a web client half (`dsh.client.platform === 'web'`)
 * is certainly a web-profile plugin and can install without a trial boot.
 * Everything else — including an unfetchable manifest — goes through the boot
 * probe, which decides by actually starting the composed profile.
 * @returns {Promise<{known: boolean, webClient: boolean, fetchFailed?: boolean}>}
 */
async function classifyPlugin(source) {
  const spec = String(source || '')
  const m = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(spec)
  if (!m) return { known: false, webClient: false } // registry spec — probe decides
  const [, owner, repo] = m
  let pkg
  for (const base of RAW_MIRRORS) {
    try {
      const r = await fetch(`${base}/${owner}/${repo}/HEAD/package.json`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) continue
      pkg = await r.json()
      break
    } catch { /* try next mirror */ }
  }
  if (pkg === undefined || typeof pkg !== 'object') return { known: false, webClient: false, fetchFailed: true }
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const client = dsh.client
  return { known: true, webClient: client !== undefined && client.platform === 'web' }
}

/**
 * Trial boot probe: prove the candidate boots under the web profile before
 * touching the real one. A throwaway DSH_HOME is seeded with the web profile
 * template, the same `dsh plugin --profile web add` CLI installs the candidate
 * there, then the composed profile is booted on a free OS-assigned port
 * (`--port 0`). Success = the `dsh web:` readiness line appears, which the
 * web-app glue prints only after its Loader tree settles — a failed boot
 * (duplicate services, broken rows) never reaches it and the real boot error
 * is captured instead. The temp home is deleted either way; nothing in the
 * real profile is ever written, so there is nothing to roll back.
 * @param {string} bin - path to the dsh CLI entry (node script).
 * @param {string} source - the install spec (github:, registry, link:, ...).
 * @param {AbortSignal} [signal] - aborts both probe stages early (queue kill).
 * @returns {Promise<{ok: true} | {ok: false, stage: 'install'|'boot', output: string}>}
 */
async function runProbe(explicitBin, source, signal) {
  const inv = dshInvoke(explicitBin)
  if (!inv) return { ok: false, stage: 'install', output: CLI_NOT_FOUND_HINT }
  if (inv.shell === true && !TARGET_RE.test(String(source || ''))) {
    return { ok: false, stage: 'install', output: 'unsafe plugin target rejected under shell: ' + JSON.stringify(source) }
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-mkts-probe-'))
  const realWebProfileDir = profileDir('web')
  try {
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    // Seed the trial profile with the real web profile's pnpm-workspace.yaml
    // when one exists. This inherits the user's allowBuilds decisions (true
    // = run, false = explicitly skip) and minimumReleaseAgeExclude settings,
    // so pnpm 11's ERR_PNPM_IGNORED_BUILDS behaves exactly as it will in the
    // real profile instead of failing on packages the user already rejected.
    const realYaml = join(realWebProfileDir, 'pnpm-workspace.yaml')
    const trialYaml = join(profileDir, 'pnpm-workspace.yaml')
    const fallbackYaml = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
    if (existsSync(realYaml)) {
      try { copyFileSync(realYaml, trialYaml) } catch { writeFileSync(trialYaml, fallbackYaml) }
    } else {
      writeFileSync(trialYaml, fallbackYaml)
    }
    const env = { ...process.env, ...pnpmNetworkEnv(), DSH_HOME: home }

    // Outer cwd must let execArgv loaders (tsx) resolve from the harness, not
    // from the profile: `dsh plugin` chdirs into the profile itself, and the
    // trial profile is located via DSH_HOME, so both steps run from inv.cwd.
    const runCwd = inv.cwd ?? profileDir

    // 1) Install the candidate into the trial profile through the SAME CLI path.
    let install = await spawnCapture(inv.file,
      [...inv.args, 'plugin', '--profile', 'web', 'add', source],
      { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT, signal, shell: inv.shell === true })
    if (!install.ok) {
      // pnpm >=11 fails unapproved build scripts (ERR_PNPM_IGNORED_BUILDS).
      // The trial yaml already inherits the real profile's allowBuilds when
      // that file exists. If the candidate introduces a package the real
      // profile has not decided on yet, approve the flagged packages in the
      // throwaway yaml and retry the install once; existing true/false values
      // are preserved because approveBuildsIn only adds missing names.
      // The boot stage below remains the actual safety verdict.
      const approved = approveBuildsIn(join(profileDir, 'pnpm-workspace.yaml'), install.output)
      if (approved.length > 0) {
        install = await spawnCapture(inv.file,
          [...inv.args, 'plugin', '--profile', 'web', 'add', source],
          { cwd: runCwd, env, timeoutMs: PROBE_INSTALL_TIMEOUT, signal, shell: inv.shell === true })
      }
    }
    if (!install.ok) {
      return { ok: false, stage: 'install', output: install.output }
    }

    // 2) Boot the composed trial profile; the readiness line is the verdict.
    const boot = await spawnCapture(inv.file,
      [...inv.args, '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
      { cwd: runCwd, env, timeoutMs: PROBE_BOOT_TIMEOUT, readyRe: READY_LINE_RE, signal, shell: inv.shell === true })
    if (boot.ready) return { ok: true }
    return { ok: false, stage: 'boot', output: boot.output }
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch {}
  }
}

/** Spawn one child, capture its output, optionally wait for a readiness line. */
function spawnCapture(exe, args, { cwd, env, timeoutMs, readyRe, signal, shell }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env, shell: shell === true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const onData = (d) => {
      output = (output + String(d)).slice(-MAX_OUTPUT)
      if (readyRe && readyRe.test(output)) {
        finish({ ok: true, ready: true, output })
        killChild(child)
      }
    }
    const timer = setTimeout(() => {
      finish({ ok: false, ready: false, timedOut: true, output: output + '\n[probe timeout ' + Math.round(timeoutMs / 1000) + 's]' })
      killChild(child)
    }, timeoutMs)
    const onAbort = () => {
      finish({ ok: false, ready: false, aborted: true, output: output + '\n[killed] 已由用户终止' })
      killChild(child)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => finish({ ok: false, ready: false, output: output + '\n[error] ' + String((err && err.message) || err) }))
    child.on('close', (code) => finish({ ok: code === 0, ready: false, code, output }))
  })
}

/** The web-app readiness line, printed only after the Loader tree settles. */
const READY_LINE_RE = /dsh web:\s+http:\/\//

/** Probe stage timeouts: install may hit the network; boot is local. */
const PROBE_INSTALL_TIMEOUT = 240000
const PROBE_BOOT_TIMEOUT = 120000

/**
 * Snapshot a profile's manifest before a real install, so a later failure can
 * be rolled back by restoring the file (or simply by `dsh plugin remove`).
 * @returns {string|null} the snapshot path, or null when the profile has no manifest.
 */
function snapshotProfile(profile) {
  try {
    const p = profileDir(profile) + '/package.json'
    if (!existsSync(p)) return null
    const snap = p + '.mkts-snapshot-' + Date.now() + '.json'
    writeFileSync(snap, readFileSync(p, 'utf8'))
    return snap
  } catch { return null }
}

/**
 * Source whitelist: only sources listed in the curated catalog are
 * installable, mirroring dsh-market's registry gate. `list` results (the
 * awesome-dsh-plugin.com catalog) are the whitelist. Unfetchable catalog or a
 * registry/link spec degrades to allow — the trial boot still guards boot
 * safety, and skipCheck bypasses this gate entirely.
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function whitelistSource(target, plugins) {
  const spec = String(target || '').trim()
  if (!spec || !/^github:/.test(spec)) return { allowed: true } // registry/link — not gated
  if (!Array.isArray(plugins) || plugins.length === 0) return { allowed: true } // no catalog — degrade open
  const normalized = (s) => String(s).replace(/^github:/i, '').replace(/\.git$/, '').toLowerCase()
  const needle = normalized(spec)
  const hit = plugins.some((p) => p.source && normalized(p.source) === needle)
  return hit ? { allowed: true } : {
    allowed: false,
    reason: '该插件不在精选目录（awesome-dsh-plugin.com curated registry）中。为安全起见仅允许安装目录收录的源；'
      + '如确需安装，请勾选"跳过安全检查"（风险自负）。',
  }
}

/** The site's own JSON API — the canonical target data (stars, added, owner, bilingual desc). */
const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** npm package names accepted from the curated registry's `npm` mapping. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

function pickLang(lang) {
  return lang === 'en' ? 'en' : 'zh'
}

/**
 * Map one plugins.json entry onto the catalog card shape, keeping the fields
 * the UI already understands and adding stars/added (null when unknown).
 */
function fromRegistryPlugin(p, lang) {
  const cc = parseCmd(p.install)
  const desc = (p.description && typeof p.description === 'object') ? p.description : {}
  // Prefer the curated npm mapping (official dsh-market's mirror strategy):
  // npm tarballs are CDN/mirror-friendly and avoid GitHub downloads entirely.
  // Fall back to the install command's parsed source for GitHub-only plugins.
  const npm = typeof p.npm === 'string' && NPM_NAME_RE.test(p.npm.trim()) ? p.npm.trim() : null
  const source = npm || (cc ? cc.source : null)
  return {
    cat: p.category,
    name: p.name,
    url: p.url,
    by: p.owner,
    desc: desc[lang] || desc.zh || desc.en || '',
    cmd: p.install,
    profile: cc ? cc.profile : 'web',
    source,
    npm,
    stars: typeof p.stars === 'number' ? p.stars : null,
    added: p.added || null,
  }
}

/** Derive the category chips (incl. the leading "all" chip) from the registry. */
function registryCats(data, lang) {
  const cats = []
  const labels = (data.categories && typeof data.categories === 'object') ? data.categories : {}
  cats.push({ id: 'all', label: lang === 'en' ? 'All' : '全部', count: Array.isArray(data.plugins) ? data.plugins.length : 0 })
  for (const id of Object.keys(labels)) {
    const l = labels[id]
    const label = (l && (l[lang] || l.zh || l.en)) || id
    const count = Array.isArray(data.plugins) ? data.plugins.filter((p) => p.category === id).length : 0
    cats.push({ id, label, count })
  }
  return cats
}

/** Map a parsed plugins.json document onto the catalog card shape. */
function registryToCatalog(data, lang) {
  const locale = pickLang(lang)
  return {
    plugins: Array.isArray(data.plugins) ? data.plugins.map((p) => fromRegistryPlugin(p, locale)) : [],
    cats: registryCats(data, locale),
  }
}

/**
 * Load the plugin catalog the same way dsh-market does: the site's own JSON
 * API first (it carries stars/added), then — on any failure — the last-good
 * cache, then the bundled snapshot as the offline fallback. No HTML parsing:
 * the static page markup has changed before and would silently break the
 * listing, so the registry JSON is the only live source.
 * @returns {Promise<{plugins: any[], cats: any[], source: 'live'|'cache'|'snapshot'|'none'}>}
 */
async function loadCatalog(lang) {
  const now = Date.now()
  const locale = pickLang(lang)
  if (catalogCache && catalogCache.lang === locale && now - catalogCache.at < CATALOG_TTL_MS) {
    return { ...catalogCache.data, source: 'cache' }
  }
  try {
    const parsed = await fetchLiveCatalog(locale)
    catalogCache = { at: now, lang: locale, data: parsed }
    return { ...parsed, source: 'live' }
  } catch {
    // Mirrors dsh-market: prefer the stale cache over the snapshot so a
    // transient outage never degrades the listing.
    if (catalogCache && catalogCache.lang === locale) return { ...catalogCache.data, source: 'cache' }
    try {
      const snap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog-snapshot.json'), 'utf8'))
      if (Array.isArray(snap.plugins) && snap.plugins.length > 0) return { ...snap, source: 'snapshot' }
    } catch {}
    return { plugins: [], cats: [], source: 'none' }
  }
}

/**
 * Fetch the curated registry (plugins.json) directly — no cache, no fallback.
 * Shared by loadCatalog and the snapshot generator, so the snapshot script can
 * never self-copy stale data through the fallback chain.
 * @param {string} [lang] - 'zh' or 'en'; defaults to zh.
 * @returns {Promise<{plugins: any[], cats: any[]}>}
 */
export async function fetchLiveCatalog(lang) {
  const locale = pickLang(lang)
  const r = await fetch(REGISTRY_URL, { redirect: 'follow', signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const data = await r.json()
  const parsed = registryToCatalog(data, locale)
  if (parsed.plugins.length === 0) throw new Error('empty registry')
  return parsed
}

/** Catalog cache: 1 hour (dsh-market's TTL); the snapshot is the offline fallback. */
let catalogCache = null
const CATALOG_TTL_MS = 60 * 60 * 1000
/** plugins.json fetch timeout: 4s, matching dsh-market's registry probe. */
const CATALOG_FETCH_TIMEOUT_MS = 4000

// ── hot mount (restart-free activation) ─────────────────────────────────────
// Mirrors dsh-market's approach: after a successful install, if the new
// package's patch is just plain id/name insert rows, mount it into the running
// composition through a market-owned Include subtree. Durable state stays in
// the profile's dsh.profile.bundles; the subtree exists only for this process
// and its inputs live under <profile>/.dsh-market/, wiped on every boot.

/** Parse a bundle patch that is ONLY plain `- id:`/`name:` insert rows. */
function parseSimplePatch(patchText) {
  const rows = []
  let pending = null
  for (const raw of String(patchText || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** The loader's Include class, built once; null when unavailable (older harness). */
let hotTreeClass = undefined

async function loadHotTreeClass() {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    const mod = await import('@deepseek-ai/cordis-plugin-include')
    const Include = mod.Include
    if (Include === undefined) throw new Error('no Include export')
    class MarketHotTree extends Include {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      write() {}
    }
    hotTreeClass = MarketHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

/** Wipe leftover hot-mount inputs; call when the market host starts. */
function cleanHotDir(profile) {
  try { rmSync(profileDir(profile) + '/.dsh-market', { force: true, recursive: true, maxRetries: 3 }) } catch {}
}

let hotSequence = 0

/** Live hot-mount handles keyed by package name, so uninstall can dispose them. */
const hotHandles = new Map()

/**
 * Mount a just-installed package into the running composition.
 * @returns {Promise<boolean>} true when live without restart; false → restart needed.
 */
async function hotMount(ctx, profile, packageName) {
  try {
    const HotTree = await loadHotTreeClass()
    if (HotTree === null) return false
    const patchText = readFileSync(join(profileDir(profile), 'node_modules', packageName, 'cordis.patch.yml'), 'utf8')
    const rows = parseSimplePatch(patchText)
    if (rows === null) return false
    const dir = join(profileDir(profile), '.dsh-market')
    mkdirSync(dir, { recursive: true })
    hotSequence += 1
    const file = join(dir, 'hot-' + String(hotSequence) + '.yml')
    const yml = rows.map((row) => `- id: mkt-${row.id}\n  name: '${row.name}'\n`).join('')
    writeFileSync(file, yml)
    // Include resolves config.path as a URL against ctx.baseUrl — pass the
    // file:// href, not a bare Windows path (a drive-letter `C:` would parse
    // as a URL scheme and fileURLToPath would reject it).
    const handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href })
    await handle.await()
    hotHandles.set(packageName, handle)
    return true
  } catch (e) {
    console.warn('[dsh-market] hot mount of ' + packageName + ' failed, restart required: ' + String((e && e.message) || e))
    return false
  }
}

/**
 * Dispose a live hot mount. Uninstall removes the package from node_modules
 * but the mounted Include subtree would otherwise stay in the running
 * composition — client-modules would keep serving a bundle that no longer
 * exists and the next page reload would fail to import it.
 */
async function disposeHotMount(packageName) {
  const handle = hotHandles.get(packageName)
  if (!handle) return
  hotHandles.delete(packageName)
  try {
    await handle.dispose()
  } catch (e) {
    console.warn('[dsh-market] dispose of hot mount ' + packageName + ' failed: ' + String((e && e.message) || e))
  }
}

/**
 * Toggle every live loader entry whose name matches the package. Covers both
 * hot-mounted Include subtrees AND entries loaded as regular profile bundle
 * rows. Mirrors the Loader's own handling of `disabled=true`; enable restarts
 * the fiber through `entry.update({ disabled: false })`.
 */
async function setLoaderEntryDisabled(packageName, disabled = true) {
  const loader = hotCtx && hotCtx.get('loader')
  if (!loader) return false
  let changed = false
  for (const entry of loader.entries()) {
    if (entry.options && entry.options.name === packageName && entry.disabled !== disabled) {
      try {
        await entry.update({ disabled })
        changed = true
      } catch (e) {
        console.warn('[dsh-market] set loader entry ' + packageName + ' disabled=' + String(disabled) + ' failed: ' + String((e && e.message) || e))
      }
    }
  }
  if (changed) console.log('[dsh-market] loader entry ' + packageName + ' disabled=' + String(disabled))
  return changed
}

/** Uninstall helper: the persisted entry is going away entirely. */
async function disableLoaderEntry(packageName) {
  return setLoaderEntryDisabled(packageName, true)
}

/** After a successful install op, try to hot-mount every newly added package. */
async function tryHotMountAll(ctx, profile, beforeDeps) {
  try {
    const after = readProfileDeps(profile)
    const added = Object.keys(after).filter((n) => beforeDeps[n] === undefined)
    if (added.length === 0) return false
    const results = await Promise.all(added.map((n) => hotMount(ctx, profile, n)))
    return results.every(Boolean)
  } catch { return false }
}

function readProfileDeps(profile) {
  try {
    const json = JSON.parse(readFileSync(profileDir(profile) + '/package.json', 'utf8'))
    return (json && json.dependencies) || {}
  } catch { return {} }
}

/**
 * Sync provenance check: is `target` (an install source: github: spec or npm
 * name) exactly one of `from`'s dependency-managed installs? Sync installs
 * only replicate what the source profile already has — the user already made
 * the trust decision there, so the curated-catalog whitelist (a gate for NEW
 * remote sources) does not apply. Anything not provably installed in `from`
 * falls back to the normal whitelist path.
 */
function isInstalledIn(from, target) {
  if (!validProfile(from)) return false
  for (const [name, spec] of Object.entries(readProfileDeps(from))) {
    if (spec === target || name === target) return true
  }
  return false
}

// ── disable/enable (dormant install instead of delete) ───────────────────────
// Persisted under the profile manifest's `dsh.market.disabled`: a list of
// `{ name, index }` where index restores the bundle to its original layer
// order on enable. Disabling removes the name from `dsh.profile.bundles` but
// KEEPS the dependency installed; enabling inserts it back. `dsh plugin`
// reconcile would re-add a disabled bundle on its next run, so every market
// op re-applies this set afterwards (and host startup re-applies it too).

function readProfileManifest(profile) {
  try {
    return JSON.parse(readFileSync(profileDir(profile) + '/package.json', 'utf8'))
  } catch { return null }
}

function disabledListOf(json) {
  const market = json && json.dsh && typeof json.dsh.market === 'object' ? json.dsh.market : null
  return market && Array.isArray(market.disabled) ? market.disabled : []
}

function disabledNamesOf(json) {
  return disabledListOf(json)
    .filter((e) => e && typeof e === 'object')
    .map((e) => String(e.name))
}

/** Persist the dormant/active switch for one installed plugin. */
function setDisabledState(profile, name, disabled) {
  const file = profileDir(profile) + '/package.json'
  const json = readProfileManifest(profile)
  if (!json) return { ok: false, output: 'profile manifest 不可读：' + file }
  const deps = json.dependencies || {}
  const bundles = Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles)
    ? [...json.dsh.profile.bundles]
    : []
  const market = (json.dsh && typeof json.dsh.market === 'object') ? json.dsh.market : {}
  const list = Array.isArray(market.disabled) ? market.disabled.map((e) => ({ ...e })) : []
  const found = list.find((e) => String(e.name) === name)
  if (disabled) {
    if (!deps[name] && !bundles.includes(name)) return { ok: false, output: '该插件未安装（不在依赖或 bundle 列表中）：' + name }
    if (!found) {
      const idx = bundles.indexOf(name)
      list.push({ name, index: idx >= 0 ? idx : bundles.length })
    }
    if (bundles.includes(name)) bundles.splice(bundles.indexOf(name), 1)
  } else {
    if (!deps[name]) return { ok: false, output: '依赖已不存在，无法启用：' + name + '（请重新安装）' }
    if (found) list.splice(list.indexOf(found), 1)
    if (!bundles.includes(name)) {
      const at = Math.min(Math.max(found ? Number(found.index) : bundles.length, 0), bundles.length)
      bundles.splice(at, 0, name)
    }
  }
  json.dsh = { ...json.dsh, profile: { ...json.dsh.profile, bundles }, market: { ...market, disabled: list } }
  try {
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  } catch (e) {
    return { ok: false, output: '写入 profile manifest 失败：' + String((e && e.message) || e) }
  }
  updatesCache = { ...updatesCache, [profile]: null }
  return { ok: true, disabled: list.map((e) => String(e.name)) }
}

/** Ensure every disabled name stays out of the bundle list (reconcile guard). */
function reapplyDisabledState(profile) {
  try {
    const file = profileDir(profile) + '/package.json'
    const json = readProfileManifest(profile)
    const list = disabledListOf(json)
    if (!json || list.length === 0) return
    const bundles = Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles)
      ? [...json.dsh.profile.bundles]
      : []
    let changed = false
    for (const entry of list) {
      const name = String(entry && entry.name)
      const idx = bundles.indexOf(name)
      if (idx >= 0) { bundles.splice(idx, 1); changed = true }
    }
    if (changed) {
      json.dsh = { ...json.dsh, profile: { ...json.dsh.profile, bundles } }
      writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
    }
  } catch {}
}

/** Drop the disabled record once the plugin itself is uninstalled. */
function forgetDisabledName(profile, name) {
  try {
    const file = profileDir(profile) + '/package.json'
    const json = readProfileManifest(profile)
    const list = disabledListOf(json)
    if (!json || list.length === 0) return
    const next = list.filter((e) => String(e && e.name) !== name)
    if (next.length === list.length) return
    const market = (json.dsh && typeof json.dsh.market === 'object') ? json.dsh.market : {}
    json.dsh = { ...json.dsh, market: { ...market, disabled: next } }
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  } catch {}
}

// ── external (out-of-catalog) installed plugin inventory ─────────────────────

function repoNameOfHost(url) {
  const t = String(url || '').replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) : t
}

function repoOfValueHost(v) {
  const s = String(v || '').replace(/\/+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'))
  return s.slice(i + 1).replace(/\.git$/, '').replace(/#.*$/, '')
}

/**
 * Full GitHub identity "owner/repo" (lowercased) from a url, github: spec,
 * dependency value or manifest repository/homepage/bugs field (object form
 * included). Strips scheme/host, .git, #fragment and monorepo sub-paths.
 * Scoped npm names (@scope/name), version ranges and relative paths return
 * null — an npm scope is not the same as a GitHub owner, so a null identity
 * must never be treated as a mismatch (basename fallback may still apply).
 */
function githubIdentity(v) {
  const raw = (v && typeof v === 'object') ? (v.url || v.repository || '') : v
  const s = String(raw || '').trim()
  if (!s) return null
  let t = s.replace(/^git\+/, '').replace(/^github:/i, '').replace(/#.*$/, '')
  t = t.replace(/^https?:\/\/[^/]+\//i, '')
  t = t.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = t.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const id = parts[0] + '/' + parts[1]
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) return null
  return id.toLowerCase()
}

/** Identity from an installed dependency's name/spec alone (no manifest I/O). */
function resolveDepIdentityFrom(name, spec) {
  return githubIdentity(spec) || githubIdentity(name)
}

/** Identity of an installed dependency, falling back to its installed manifest. */
function resolveDepIdentity(profile, name, spec) {
  const fromSpec = resolveDepIdentityFrom(name, spec)
  if (fromSpec) return fromSpec
  const manifest = readInstalledManifest(profile, name)
  if (manifest) {
    for (const f of [manifest.repository, manifest.homepage, manifest.bugs && manifest.bugs.url, manifest.dsh && manifest.dsh.repo]) {
      const id = githubIdentity(f)
      if (id) return id
    }
  }
  return null
}

/**
 * Same matching rule as the client's installedPkgName, host-side: identity
 * ("owner/repo") first, basename fallback only when the identity is not
 * resolvable on at least one side. With same-named plugins from different
 * authors in the catalog, a known different identity must never match.
 * @param {string|null} [knownIdentity] pre-resolved dep identity (installedAll passes it to avoid re-reading the manifest).
 */
function matchesCatalog(name, spec, plugin, knownIdentity) {
  const di = knownIdentity || resolveDepIdentityFrom(name, spec)
  const pi = githubIdentity(plugin.url) || githubIdentity(plugin.source)
  if (pi && di) return di === pi
  const repo = repoNameOfHost(plugin.url).toLowerCase()
  const n = String(name).toLowerCase()
  if (n === repo || n.endsWith('/' + repo) || n === 'github:' + repo) return true
  return repoOfValueHost(spec).toLowerCase() === repo
}

/** Catalog cards for matching, preferring the warm cache and falling back to the bundled snapshot. */
function catalogPluginsForMatch() {
  if (catalogCache && Array.isArray(catalogCache.data && catalogCache.data.plugins)) return catalogCache.data.plugins
  try {
    const snap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog-snapshot.json'), 'utf8'))
    if (Array.isArray(snap.plugins)) return snap.plugins
  } catch {}
  return []
}

function readInstalledManifest(profile, name) {
  try {
    return JSON.parse(readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'))
  } catch { return null }
}

/** Dependency-managed plugin inventory, including plugins installed outside the market. */
function installedAll(profile) {
  const json = readProfileManifest(profile)
  const deps = (json && json.dependencies) || {}
  const bundles = Array.isArray(json && json.dsh && json.dsh.profile && json.dsh.profile.bundles)
    ? json.dsh.profile.bundles
    : []
  const disabled = new Set(disabledNamesOf(json))
  const catalog = catalogPluginsForMatch()
  const plugins = Object.keys(deps).map((name) => {
    const spec = String(deps[name] || '')
    const manifest = readInstalledManifest(profile, name)
    const isBundle = manifest !== null && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch !== undefined
    const kind = spec.startsWith('github:') ? 'github' : spec.startsWith('link:') ? 'link' : spec.startsWith('file:') ? 'file' : 'npm'
    // Resolved "owner/repo" identity: keeps same-named plugins from different
    // authors distinct in the local inventory and in the in-catalog badge.
    const repo = resolveDepIdentity(profile, name, spec)
    return {
      name,
      spec,
      repo,
      version: manifest && manifest.version ? manifest.version : null,
      kind,
      isBundle,
      inBundles: bundles.includes(name),
      disabled: disabled.has(name),
      inCatalog: catalog.some((p) => matchesCatalog(name, spec, p, repo)),
    }
  })
  const builtin = bundles.filter((name) => deps[name] === undefined)
  return { plugins, builtin }
}

/**
 * Read-only diff of dependency-managed plugins between two profiles: the
 * packages installed in `from` but missing in `to`, with the install target
 * each needs (`dsh plugin --profile <to> add <source>`). Local link/file dev
 * specs are excluded — they point at checkout paths, not distributable
 * packages, and copying them across profiles is almost never intended.
 * Additive by construction: sync never plans removals or downgrades, so an
 * existing desktop installation can never be damaged by a sync. A plan is
 * only computed when the TARGET profile already exists (its manifest is
 * readable): syncing into a typo'd or not-yet-created profile would silently
 * initialize a stray profile instead of reaching a real desktop shell.
 * @returns {{from: string, to: string, missing: Array<{name: string, spec: string, source: string}>}}
 */
function syncPlan(from, to) {
  const missing = []
  if (from !== to && validProfile(from) && validProfile(to) && readProfileManifest(to) !== null) {
    const fromAll = installedAll(from)
    const toNames = new Set(installedAll(to).plugins.map((p) => p.name))
    for (const p of fromAll.plugins) {
      if (toNames.has(p.name)) continue
      if (p.spec.startsWith('link:') || p.spec.startsWith('file:')) continue
      // github: specs install as-is (pinned SHA preserved); npm/registry deps
      // install by bare name so pnpm resolves the profile's own registry.
      missing.push({ name: p.name, spec: p.spec, source: /^github:/.test(p.spec) ? p.spec : p.name })
    }
  }
  return { from, to, missing }
}

// ── update detection (mirrors dsh-market's checkUpdates) ─────────────────────

/**
 * Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs.
 * The full-lock scan is only a fallback: a repo can appear more than once when
 * an older commit remains as a transitive dependency, and the last occurrence in
 * the `packages` section may not be the profile's direct install. We therefore
 * parse the importer's resolved `version:` lines last so the direct dependency's
 * actual commit wins.
 */
function readLockCommits(profile) {
  const commits = new Map()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
    const importer = /importers:[\s\S]*?(?=\npackages:|\n$)/.exec(lock)
    if (importer) {
      const depRe = /^\s{6}(['"][^'"]+['"]|[A-Za-z0-9][A-Za-z0-9._-]*):\s*\n\s{8}specifier:.*\n\s{8}version:\s*(\S+)/gm
      for (const m of importer[0].matchAll(depRe)) {
        const t = /codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/.exec(m[2])
        if (t) commits.set(t[1].toLowerCase(), t[2])
      }
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

function readInstalledVersion(profile, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'))
    return manifest.version ?? null
  } catch {
    return null
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** Resolve the npm registry used by pnpm for this profile.
 * Prefers the same source pnpm will actually install from: an explicit
 * npm_config_registry env var, then the profile's .npmrc, then the user
 * .npmrc. Falls back to the official npm registry. Using the same registry
 * for update detection prevents a mirror-lag false positive where the market
 * says "update available" right after installing the mirror's latest because
 * the hardcoded official registry still has a newer version.
 */
function npmRegistryFor(profile) {
  const fromEnv = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
  if (fromEnv) return String(fromEnv).trim().replace(/\/+$/, '') + '/'
  for (const file of [join(profileDir(profile), '.npmrc'), join(homedir(), '.npmrc')]) {
    try {
      if (!existsSync(file)) continue
      const m = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))
      if (m) return m[1].trim().replace(/\/+$/, '') + '/'
    } catch {}
  }
  return 'https://registry.npmjs.org/'
}

/** Parse a pnpm-style minimum-release-age duration (e.g. '24h', '1d', '90m',
 * a bare number = hours) into milliseconds. Returns null when unparseable.
 */
function parseReleaseAgeMs(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw]|ms)?\s*$/i.exec(String(value || ''))
  if (!m) return null
  const n = Number(m[1])
  const unit = String(m[2] || '').toLowerCase()
  if (unit === 'ms') return Math.round(n)
  if (unit === 'm') return Math.round(n * 60 * 1000)
  if (unit === 'h' || unit === '') return Math.round(n * 60 * 60 * 1000)
  if (unit === 'd') return Math.round(n * 24 * 60 * 60 * 1000)
  if (unit === 'w') return Math.round(n * 7 * 24 * 60 * 60 * 1000)
  if (unit === 's') return Math.round(n * 1000)
  return null
}

/** The effective pnpm minimumReleaseAge for a profile, in milliseconds.
 * pnpm >=11 enforces a 24h supply-chain policy by default; the market must
 * mirror the same cutoff so update detection never claims "update available"
 * for a version pnpm will refuse to install. Same source order as the
 * registry: env var, profile .npmrc, user .npmrc. Falls back to 24h.
 */
function minimumReleaseAgeFor(profile) {
  const fromEnv = process.env.npm_config_minimum_release_age || process.env.NPM_CONFIG_MINIMUM_RELEASE_AGE
  if (fromEnv) {
    const ms = parseReleaseAgeMs(fromEnv)
    if (ms !== null) return ms
  }
  for (const file of [join(profileDir(profile), '.npmrc'), join(homedir(), '.npmrc')]) {
    try {
      if (!existsSync(file)) continue
      const m = /^\s*minimum-release-age\s*=\s*(\S+)\s*$/im.exec(readFileSync(file, 'utf8'))
      if (m) {
        const ms = parseReleaseAgeMs(m[1])
        if (ms !== null) return ms
      }
    } catch {}
  }
  return 24 * 60 * 60 * 1000
}

/** Per-plugin update status; a failed check reports no update rather than failing the listing. */
async function checkUpdates(profile) {
  const cached = updatesCache && updatesCache[profile]
  if (cached && Date.now() - cached.at < UPDATES_TTL_MS) return cached.data
  const installed = readProfileDeps(profile)
  const lockCommits = readLockCommits(profile)
  const result = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        // Full packument: `dist-tags.latest` plus the publish time of that
        // version. pnpm >=11's 24h minimumReleaseAge silently resolves
        // `name@latest` to the newest age-eligible version, so a registry
        // dist-tag newer than the installed one may be UNINSTALLABLE right
        // now; reporting it as an update would loop forever (update
        // "succeeds" onto the previous version, the check still differs).
        const pack = await fetchJson(`${npmRegistryFor(profile)}${encodeURIComponent(name)}`)
        const latest = typeof pack['dist-tags'] === 'object' && pack['dist-tags'] && typeof pack['dist-tags'].latest === 'string'
          ? pack['dist-tags'].latest
          : null
        const publishedAt = latest !== null && pack.time && typeof pack.time[latest] === 'string'
          ? Date.parse(pack.time[latest])
          : NaN
        const ageBlocked = latest !== null && Number.isFinite(publishedAt)
          && Date.now() - publishedAt < minimumReleaseAgeFor(profile)
        result[name] = {
          kind: 'npm', version, current: version, latest,
          ageBlocked: ageBlocked || undefined,
          // Missing publish time degrades to the plain version comparison.
          updateAvailable: version !== null && latest !== null && version !== latest && !ageBlocked,
        }
      }
    } catch {
      result[name] = {
        kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null,
        updateAvailable: false,
      }
    }
  }))
  updatesCache = { ...updatesCache, [profile]: { at: Date.now(), data: result } }
  return result
}

/**
 * Build the target for a github: update. We pin the resolved commit SHA from
 * update detection (`latest`) instead of passing a bare `github:owner/repo`.
 * A bare spec makes pnpm run `git ls-remote` to resolve HEAD; on machines
 * whose git rewrites GitHub URLs to SSH (or that lack an SSH key) that fails
 * with "Permission denied (publickey)". A pinned 40-hex SHA is fetched through
 * the codeload HTTPS tarball path already recorded in the lockfile.
 */
function githubBase(spec) {
  return String(spec || '').replace(/^github:/i, '').replace(/#.*$/, '').replace(/\.git$/i, '')
}

function updateTargetFor(spec, name, latest) {
  if (!String(spec || '').startsWith('github:')) {
    // Pin the detected version instead of the bare dist-tag: pnpm >=11's 24h
    // minimumReleaseAge silently resolves `name@latest` to the newest
    // age-eligible version, so the update would "succeed" onto the previous
    // version while the registry tag still differs (perpetual "update
    // available"). An exact version cannot fall back: pnpm either installs it
    // or fails with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION, which
    // healReleaseAgeExclude resolves by excluding the version and retrying.
    const v = String(latest || '')
    if (/^[0-9][0-9A-Za-z.+-]*$/.test(v)) return `${name}@${v}`
    return `${name}@latest`
  }
  const base = githubBase(spec)
  if (latest && /^[0-9a-f]{40}$/i.test(String(latest))) return `github:${base}#${latest}`
  // No known SHA (update check failed): fall back to the old unpinned behavior.
  return `github:${base}`
}

const UPDATES_TTL_MS = 10 * 60 * 1000
let updatesCache = {}

export { classifyPlugin, runProbe, whitelistSource, loadCatalog, parseSimplePatch, checkUpdates, registryToCatalog, setDisabledState, installedAll, githubIdentity, matchesCatalog, resolveDepIdentityFrom, resolveDepIdentity, healReleaseAgeExclude, healAllowBuilds, parseIgnoredBuilds, mergeAllowBuilds, approveBuildsIn, npmRegistryFor, minimumReleaseAgeFor, readLockCommits, syncPlan, listProfiles, isInstalledIn, githubBase, updateTargetFor } // test hooks; cordis only reads name/inject/apply

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-market] webServer service unavailable at apply; route not registered')
    return
  }
  // Allow install ops to hot-mount into this composition; wipe stale hot-mount
  // inputs so a crash can never collide with the bundle layer on next boot.
  hotCtx = ctx
  cleanHotDir('web')
  // Re-apply the persisted dormant set: `dsh plugin` reconcile may have
  // re-added a disabled bundle after an out-of-band CLI operation, and the
  // running Loader must have those entries disabled for this session too.
  reapplyDisabledState('web')
  const startupTimer = setTimeout(async () => {
    try {
      for (const name of disabledNamesOf(readProfileManifest('web'))) await disableLoaderEntry(name)
    } catch {}
  }, 1000)
  if (typeof startupTimer.unref === 'function') startupTimer.unref()
  webServer.register({
    kind: 'exact',
    path: '/api/dsh-market',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'list') {
          // Site JSON API (plugins.json) with static-page + snapshot fallbacks.
          const catalog = await loadCatalog(String(body.lang || ''))
          if (catalog.source === 'none') {
            return sendJson(res, 502, { ok: false, error: 'catalog unavailable (site fetch failed and no snapshot)' })
          }
          return sendJson(res, 200, { ok: true, plugins: catalog.plugins, cats: catalog.cats, source: catalog.source })
        }
        if (method === 'probe') {
          // Validate a hand-filled CLI path instead of silently ignoring it.
          const explicit = String(body.binPath || '').trim()
          let binValid = null
          if (explicit) {
            try { binValid = existsSync(explicit) } catch { binValid = false }
          }
          // Absolute candidate for the panel prefill: the checkout's compiled CLI
          // relative to the host cwd, when it actually exists. The client uses it
          // when no entry could be auto-detected (cwd-based fallback hit).
          let cwdBin = null
          try {
            const cand = process.cwd().replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
            if (existsSync(cand)) cwdBin = cand
          } catch {}
          return sendJson(res, 200, {
            ok: true,
            dshHome: dshHome(),
            node: process.execPath || null,
            cwd: process.cwd(),
            dshBin: dshBin(),
            cwdBin,
            binProvided: explicit || null,
            binValid,
            // Initialized profiles (web first): lets the panel offer other
            // profiles as install targets / sync destinations (desktop shells
            // boot their own profile, so market installs into web never reach
            // them on their own).
            profiles: listProfiles(),
          })
        }
        if (method === 'installed') {
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const p = profileDir(profile) + '/package.json'
          if (!existsSync(p)) return sendJson(res, 200, { ok: true, profile, bundles: [], dependencies: {}, repos: {}, disabled: [] })
          const json = JSON.parse(readFileSync(p, 'utf8'))
          const deps = json.dependencies || {}
          // Resolved "owner/repo" identity per dependency (spec or installed
          // manifest), so the browser can tell same-named plugins from
          // different authors apart when marking cards installed.
          const repos = {}
          for (const n of Object.keys(deps)) repos[n] = resolveDepIdentity(profile, n, String(deps[n] || ''))
          return sendJson(res, 200, {
            ok: true,
            profile,
            bundles: Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles) ? json.dsh.profile.bundles : [],
            dependencies: deps,
            repos,
            disabled: disabledNamesOf(json),
          })
        }
        if (method === 'installedAll') {
          // Dependency-managed inventory incl. plugins installed outside the
          // market; `builtin` are template bundles the market never touches.
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const all = installedAll(profile)
          return sendJson(res, 200, { ok: true, profile, ...all })
        }
        if (method === 'syncPlan') {
          // Read-only cross-profile diff (no write op, no same-origin gate):
          // which web-installed plugins are missing in another profile, e.g. a
          // desktop shell's own profile. The browser enqueues the installs
          // itself, so every actual write still goes through the gated op
          // pipeline (whitelist + snapshot + FIFO queue).
          const from = validProfile(body.from) ? body.from : 'web'
          const to = validProfile(body.to) ? body.to : ''
          return sendJson(res, 200, { ok: true, ...syncPlan(from, to) })
        }
        if (method === 'updates') {
          // Read-only update detection for installed plugins (no write op).
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const updates = await checkUpdates(profile)
          return sendJson(res, 200, { ok: true, profile, updates })
        }
        if (method === 'updateAll') {
          // One-click: enqueue updates for every installed updatable plugin.
          // The FIFO queue keeps pnpm serial, so this is safe even with many rows.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const updates = await checkUpdates(profile)
          updatesCache = { ...updatesCache, [profile]: null } // force re-check after batch
          const deps = readProfileDeps(profile)
          const opIds = []
          for (const [name, up] of Object.entries(updates)) {
            if (!up || up.updateAvailable !== true || up.kind === 'linked') continue
            const spec = deps[name]
            if (!spec || spec.startsWith('link:') || spec.startsWith('file:')) continue
            const target = updateTargetFor(spec, name, up.latest)
            const started = enqueueOp('update', profile, target, name, '', '更新 ' + name + ' → ' + target + '\n')
            if (started.ok) opIds.push(started.opId)
          }
          return sendJson(res, 200, { ok: true, count: opIds.length, opIds })
        }
        if (method === 'update') {
          // Re-resolve the installed spec to its latest and re-add as an op.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const name = String(body.name || '').trim()
          if (!name) return sendJson(res, 400, { ok: false, output: '缺少插件名' })
          const deps = readProfileDeps(profile)
          const spec = deps[name]
          if (spec === undefined) return sendJson(res, 200, { ok: false, output: '插件未安装：' + name })
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            return sendJson(res, 200, { ok: false, output: '本地链接插件从 checkout 更新，无需通过市场更新' })
          }
          // Re-running add re-resolves the source: pin github specs to the
          // commit SHA already fetched by update detection so pnpm uses the
          // codeload HTTPS tarball instead of `git ls-remote` over SSH; npm
          // specs re-resolve the dist-tag latest.
          const updates = await checkUpdates(profile)
          const latest = updates[name] && updates[name].latest
          const target = updateTargetFor(spec, name, latest)
          const label = String(body.label || name)
          updatesCache = { ...updatesCache, [profile]: null } // force re-check after update
          const started = enqueueOp('update', profile, target, label, String(body.binPath || '').trim(),
            '更新 ' + name + ' → ' + target + '\n')
          if (!started.ok) return sendJson(res, 200, started)
          return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
        }
        if (method === 'op') {
          const wanted = String(body.opId || '')
          if (wanted) {
            const one = opSnapshot(wanted)
            return sendJson(res, 200, { ok: true, op: one, queue: [], history: [] })
          }
          return sendJson(res, 200, { ok: true, ...opSnapshot() })
        }
        if (method === 'kill') {
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          return sendJson(res, 200, killOp(body.opId ? String(body.opId) : undefined))
        }
        if (method === 'clear') {
          // Dismiss a finished op from all future snapshots (survives refresh).
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const opId = String(body.opId || '').trim()
          if (!opId) return sendJson(res, 400, { ok: false, output: '缺少 opId' })
          return sendJson(res, 200, clearOp(opId))
        }
        if (method === 'clearAll') {
          // Dismiss every finished op at once (queue panel "清空" button).
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          return sendJson(res, 200, clearAllOps())
        }
        if (method === 'install' || method === 'uninstall') {
          // Write operations require a same-origin browser POST.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const target = String(method === 'install' ? (body.source || '') : (body.pkg || '')).trim()
          if (!target) return sendJson(res, 400, { ok: false, output: '缺少参数' })
          const label = String(body.label || target)
          // Safety checks (whitelist + trial boot) and uninstall dispose run
          // when the op reaches the queue head, so the queue never blocks.
          // syncFrom (sync provenance) is forwarded to the op: sync installs
          // whose target is installed in that source profile skip the whitelist.
          const started = enqueueOp(method, profile, target, label, String(body.binPath || '').trim(), '',
            method === 'install' ? { skipCheck: body.skipCheck === true, syncFrom: String(body.syncFrom || '').trim() } : {})
          if (!started.ok) return sendJson(res, 200, started)
          return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
        }
        if (method === 'disable' || method === 'enable') {
          // Dormant switch: keep the dependency installed, just take it out of
          // (or put it back into) the active bundle layer, plus a live Loader
          // toggle for the current session.
          if (!sameOrigin(req)) {
            return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          }
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const name = String(body.name || '').trim()
          if (!name) return sendJson(res, 400, { ok: false, output: '缺少插件名' })
          // pnpm edits the same profile manifest while an op runs; don't race it.
          if (runningOp || ops.some((o) => o.status === 'pending' || o.status === 'checking' || o.status === 'running')) {
            return sendJson(res, 200, { ok: false, busy: true, output: '有插件任务在执行或排队，请等任务完成后再停用/启用' })
          }
          const disable = method === 'disable'
          const changed = setDisabledState(profile, name, disable)
          if (!changed.ok) return sendJson(res, 200, { ok: false, output: changed.output })
          await setLoaderEntryDisabled(name, disable)
          return sendJson(res, 200, { ok: true, disabled: changed.disabled })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method ' + method })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })
}
