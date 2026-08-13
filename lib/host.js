// Host half of the persistent plugin market. Registers one HTTP route
// (/api/dsh-market) that the browser UI calls to list, inspect, install, and
// uninstall community plugins. Runs as an ordinary Cordis plugin, so the full
// Node environment (process, fs, global fetch) is available.
//
// Install/uninstall run as background operations: the route returns an op id
// immediately, the browser polls it, and a hard timeout kills the child so a
// dead network cannot hang the request forever. Before installing into the web
// profile, the plugin manifest is fetched from GitHub and classified — a
// full-app bundle for another profile (TUI client, headless agent, ...) is
// refused because mounting it under the web profile duplicates the built-in
// api-gateway and breaks boot.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'dsh-market-plugin'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

const DEFAULT_TIMEOUT = 120000

/** Peer/dependency names only a full agent-profile app carries. */
const APP_CORE_DEPS = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-workflow',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-permission-presets',
]

/** The single live background op (one at a time keeps the CLI's pnpm serial). */
let activeOp = null
let opCounter = 0

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function parseCmd(cmd) {
  if (!cmd) return null
  const m = /^dsh plugin --profile (\S+) (\w+)(?:\s+(\S+))?/.exec(String(cmd).trim())
  if (!m) return null
  return { profile: m[1], action: m[2], source: m[3] || '' }
}

function parseSite(html) {
  const plugins = []
  const cats = []
  const itemRe = /<li class="item"[^>]*data-cat="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g
  let m
  while ((m = itemRe.exec(html)) !== null) {
    const cat = m[1]
    const body = m[2]
    const a = /<a href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(body)
    const by = /<span class="by"[^>]*>([^<]+)<\/span>/.exec(body)
    const p = /<p>([\s\S]*?)<\/p>/.exec(body)
    const cmd = /data-cmd="([^"]+)"/.exec(body)
    if (!a) continue
    const cc = cmd ? parseCmd(cmd[1]) : null
    plugins.push({
      cat,
      name: a[2].trim(),
      url: a[1],
      by: by ? by[1].trim() : '',
      desc: p ? decodeEntities(p[1]).replace(/<[^>]+>/g, '').trim() : '',
      cmd: cmd ? cmd[1] : null,
      profile: cc ? cc.profile : 'web',
      source: cc ? cc.source : null,
    })
  }
  const catRe = /data-cat="([^"]+)">([^<]+)<small>(\d+)<\/small>/g
  while ((m = catRe.exec(html)) !== null) {
    cats.push({ id: m[1], label: m[2].trim(), count: Number(m[3]) })
  }
  return { plugins, cats }
}

function dshHome() {
  return process.env.DSH_HOME || (homedir() + '/.dsh')
}

function dshBin() {
  const cand = process.cwd().replace(/[\\/]+$/, '') + '/apps/cli/lib/bin.js'
  try {
    if (existsSync(cand)) return cand
  } catch {}
  return process.env.DSH_BIN || null
}

function profileDir(profile) {
  return dshHome().replace(/[\\/]+$/, '') + '/profiles/' + profile
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

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function validProfile(p) {
  return typeof p === 'string' && /^[A-Za-z0-9_-]+$/.test(p)
}

function opSnapshot() {
  if (!activeOp) return null
  const { id, kind, profile, target, label, startedAt, status, output, exitCode, bin } = activeOp
  return {
    id, kind, profile, target, label, startedAt,
    status, output: String(output || '').slice(-20000), exitCode,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: DEFAULT_TIMEOUT,
    bin: bin || null,
  }
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

/** Settle an op to a terminal status and drop its pending timeout timer. */
function settleOp(op, status, exitCode) {
  clearTimeout(op.timer)
  op.status = status
  if (exitCode !== undefined) op.exitCode = exitCode
}

/** Start one install/uninstall as a background op. Returns { ok, opId? } or { ok, error }. */
function startOp(kind, profile, target, label, explicitBin) {
  const bin = (explicitBin && explicitBin.trim()) || dshBin()
  if (!bin) return { ok: false, error: 'dsh CLI 未定位（可在面板填写路径）' }
  const op = {
    id: 'op-' + (++opCounter),
    kind, profile, target, label,
    startedAt: Date.now(),
    status: 'running',
    output: '',
    exitCode: null,
    bin,
  }
  const cwd = profileDir(profile)
  const child = spawn(process.execPath, [bin, 'plugin', '--profile', profile, kind === 'install' ? 'add' : 'remove', target], {
    cwd,
    env: { ...process.env },
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
  child.on('close', (code) => {
    if (op.status !== 'running') return
    settleOp(op, code === 0 ? 'done' : 'failed', code)
  })
  op.timer = setTimeout(() => {
    if (op.status !== 'running') return
    appendOutput(op, '\n\n[timeout] 操作超过 ' + Math.round(DEFAULT_TIMEOUT / 1000) + ' 秒未完成，已自动终止（可能是网络不通或 pnpm 卡住，可重试）')
    settleOp(op, 'timeout')
    killChild(child)
  }, DEFAULT_TIMEOUT)
  activeOp = op
  return { ok: true, opId: op.id }
}

/** Abort the live op (used by the panel's kill button). */
function killOp() {
  const op = activeOp
  if (!op || op.status !== 'running') return { ok: false, error: '没有正在运行的任务' }
  appendOutput(op, '\n\n[killed] 已由用户终止')
  settleOp(op, 'killed')
  killChild(op.child)
  return { ok: true }
}

/** Raw manifest mirrors, tried in order; GitHub raw is unstable behind CN networks. */
const RAW_MIRRORS = [
  'https://raw.githubusercontent.com',
  'https://raw.gitmirror.com',
]

/**
 * Classify a github: source before installing into the web profile. A bundle
 * without a web client half that also depends on agent-core packages is a
 * full application for another profile; mounting it under web duplicates the
 * built-in api-gateway and breaks boot, so it is refused.
 * @returns {Promise<{known: boolean, appLike?: boolean, fetchFailed?: boolean}>}
 */
async function classifyPlugin(source) {
  const spec = String(source || '')
  const m = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(spec)
  if (!m) return { known: false } // registry spec — not classifiable
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
  if (pkg === undefined || typeof pkg !== 'object') return { known: false, fetchFailed: true }
  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const client = dsh.client
  const isWebClient = client !== undefined && client.platform === 'web'
  if (dsh.bundle && !isWebClient) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
    const hits = APP_CORE_DEPS.filter((k) => deps[k] !== undefined)
    if (hits.length > 0) return { known: true, appLike: true, hits }
  }
  return { known: true, appLike: false }
}

export { classifyPlugin } // test hook; cordis only reads name/inject/apply

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-market] webServer service unavailable at apply; route not registered')
    return
  }
  webServer.register({
    kind: 'exact',
    path: '/api/dsh-market',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'list') {
          const lang = String(body.lang || '') === 'zh' ? 'zh' : 'en'
          const url = lang === 'zh' ? 'https://awesome-dsh-plugin.com/zh/' : 'https://awesome-dsh-plugin.com/'
          const r = await fetch(url, { redirect: 'follow' })
          if (!r.ok) return sendJson(res, 502, { ok: false, error: 'site fetch HTTP ' + r.status })
          const parsed = parseSite(await r.text())
          return sendJson(res, 200, { ok: true, ...parsed })
        }
        if (method === 'probe') {
          // Validate a hand-filled CLI path instead of silently ignoring it.
          const explicit = String(body.binPath || '').trim()
          let binValid = null
          if (explicit) {
            try { binValid = existsSync(explicit) } catch { binValid = false }
          }
          return sendJson(res, 200, {
            ok: true,
            dshHome: dshHome(),
            node: process.execPath || null,
            cwd: process.cwd(),
            dshBin: dshBin(),
            binProvided: explicit || null,
            binValid,
          })
        }
        if (method === 'installed') {
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const p = profileDir(profile) + '/package.json'
          if (!existsSync(p)) return sendJson(res, 200, { ok: true, profile, bundles: [], dependencies: {} })
          const json = JSON.parse(readFileSync(p, 'utf8'))
          return sendJson(res, 200, {
            ok: true,
            profile,
            bundles: Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles) ? json.dsh.profile.bundles : [],
            dependencies: json.dependencies || {},
          })
        }
        if (method === 'op') {
          const wanted = String(body.opId || '')
          const op = opSnapshot()
          if (op === null) return sendJson(res, 200, { ok: true, op: null })
          if (wanted && op.id !== wanted) return sendJson(res, 200, { ok: true, op: null })
          return sendJson(res, 200, { ok: true, op })
        }
        if (method === 'kill') {
          return sendJson(res, 200, killOp())
        }
        if (method === 'install' || method === 'uninstall') {
          const profile = validProfile(body.profile) ? body.profile : 'web'
          const target = String(method === 'install' ? (body.source || '') : (body.pkg || '')).trim()
          if (!target) return sendJson(res, 400, { ok: false, output: '缺少参数' })
          if (activeOp && activeOp.status === 'running') {
            return sendJson(res, 200, { ok: false, busy: true, output: '已有任务进行中：' + activeOp.label })
          }
          if (method === 'install' && profile === 'web' && !body.skipCheck) {
            const cls = await classifyPlugin(target)
            if (cls.fetchFailed) {
              return sendJson(res, 200, {
                ok: false,
                refused: true,
                output: '无法访问 GitHub 验证插件类型（网络问题），已中止以防破坏 web 启动。请检查网络后重试，'
                  + '或勾选"跳过类型检查"继续安装（风险自负）。',
              })
            }
            if (cls.appLike) {
              return sendJson(res, 200, {
                ok: false,
                refused: true,
                output: '该插件是面向其他 profile 的完整应用（非 web 插件），装进 web profile 会与内置应用冲突导致启动失败'
                  + '（重复 api-gateway）。如需使用请安装到对应 profile，例如：dsh plugin --profile tui add ' + target
                  + '（以插件仓库 README 为准）。',
              })
            }
          }
          const label = String(body.label || target)
          const started = startOp(method, profile, target, label, String(body.binPath || '').trim())
          if (!started.ok) return sendJson(res, 200, started)
          return sendJson(res, 200, { ok: true, opId: started.opId, timeoutMs: DEFAULT_TIMEOUT })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method ' + method })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })
}
