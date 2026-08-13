// Browser half of the persistent plugin market. Loaded through the web
// plugin loader (window.__ModuleLoader__); React comes from the platform
// module table. Talks to the Host half over the /api/dsh-market HTTP route.
//
// Install/uninstall run as background ops on the Host: the panel submits, gets
// an op id, and polls. The op lives in a fixed modal overlay (never lost by
// scrolling), can be minimized to a status chip, and survives page refreshes.
window.__ModuleLoader__.load({ id: '@dsh-webui/dsh-webui-market-plugin', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  const React = require('react')
  const { useState, useEffect, useRef } = React
  const h = React.createElement

  function api(method, params) {
    return fetch('/api/dsh-market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ method }, params || {})),
    }).then((r) => r.json())
  }

  function repoNameOf(url) {
    const t = String(url || '').replace(/\/+$/, '')
    const i = t.lastIndexOf('/')
    return i >= 0 ? t.slice(i + 1) : t
  }

  function repoOfValue(v) {
    const s = String(v || '').replace(/\/+$/, '')
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'))
    return s.slice(i + 1).replace(/\.git$/, '').replace(/#.*$/, '')
  }

  // Installed state is keyed per profile (each plugin's install command may
  // target a different profile). installedPkgName matches one profile's
  // dependency keys/values against the plugin's GitHub repo basename.
  function installedPkgName(plugin, installed) {
    if (!installed) return null
    const repo = repoNameOf(plugin.url)
    const deps = installed.dependencies || {}
    for (const key of Object.keys(deps)) {
      if (key === repo || key.endsWith('/' + repo) || key === 'github:' + repo) return key
      if (repoOfValue(deps[key]) === repo) return key
    }
    for (const b of installed.bundles || []) {
      if (b === repo || b.endsWith('/' + repo) || b === 'github:' + repo) return b
    }
    return null
  }

  // installed is a { profile: state } map; a plugin is installed when the state
  // of its own target profile matches.
  function isInstalled(plugin, installedMap) {
    const state = installedMap && installedMap[plugin.profile || 'web']
    return installedPkgName(plugin, state) !== null
  }

  let LOCALE = 'en'
  try {
    const nl = String(navigator.language || navigator.userLanguage || '')
    if (nl.toLowerCase().startsWith('zh')) LOCALE = 'zh'
  } catch (e) {}

  const STR = {
    zh: {
      search: '搜索插件…', all: '全部', instFilter: '已安装', detail: '详情', collapse: '收起',
      install: '安装', uninstall: '卸载', execute: '执行', cancel: '取消', close: '关闭',
      loading: '加载插件目录…', noMatch: '没有匹配的插件',
      binPlaceholder: 'dsh CLI 路径（自动探测失败时填写，已记住上次填写）', reprobe: '重新探测',
      installOk: '安装成功，重启 Web 服务后生效', uninstallOk: '卸载成功，重启 Web 服务后生效', opFailed: '操作失败',
      running: '执行中…（pnpm 安装可能需要一段时间）',
      cmdLabel: '安装命令（来自官网，含目标 profile）:', noCmd: '（无官方安装命令）',
      hint: '安装后需重启 Web 服务生效；GitHub 源会执行包内 prepare 脚本（pnpm allowBuilds 需放行）。完整应用类插件（如 TUI 客户端）装进 web 会与内置应用冲突导致启动失败，可用 dsh plugin --profile web remove <包名> 恢复；需其他 profile 的插件以仓库 README 为准。',
      gh: 'GitHub ↗', envLine: '环境', parseFail: '解析失败', fetchFail: '抓取失败',
      submit: '提交任务…', min: '最小化到后台', kill: '终止任务', back: '返回',
      stDone: '完成', stFailed: '失败', stKilled: '已终止', stTimeout: '超时终止',
      stBusy: '已有任务进行中', stRefused: '已拒绝', liveChip: '插件任务',
      elapsed: '已耗时 {s}s（超过 {t}s 自动终止）', newOp: '新任务',
      site: '插件目录来源',
    },
    en: {
      search: 'Search plugins…', all: 'All', instFilter: 'Installed', detail: 'Details', collapse: 'Collapse',
      install: 'Install', uninstall: 'Uninstall', execute: 'Run', cancel: 'Cancel', close: 'Close',
      loading: 'Loading plugin directory…', noMatch: 'No matching plugins',
      binPlaceholder: 'dsh CLI path (fill when auto-detection fails; remembered)', reprobe: 'Re-probe',
      installOk: 'Installed — restart the web server to activate', uninstallOk: 'Uninstalled — restart the web server to activate', opFailed: 'Operation failed',
      running: 'Running… (pnpm install may take a while)',
      cmdLabel: 'Install command (from the site, incl. target profile):', noCmd: '(no official install command)',
      hint: 'Restart the web server after install. GitHub sources run the package prepare script (pnpm allowBuilds). Full-app plugins (e.g. TUI clients) conflict with the built-in web app and break boot; recover with dsh plugin --profile web remove <pkg>. For plugins needing another profile, follow the plugin README.',
      gh: 'GitHub ↗', envLine: 'Env', parseFail: 'Parse failed', fetchFail: 'Fetch failed',
      submit: 'Submitting…', min: 'Minimize to background', kill: 'Kill task', back: 'Back',
      stDone: 'Done', stFailed: 'Failed', stKilled: 'Killed', stTimeout: 'Timed out',
      stBusy: 'A task is already running', stRefused: 'Refused', liveChip: 'Plugin task',
      elapsed: '{s}s elapsed (auto-kill after {t}s)', newOp: 'New task',
      site: 'Plugin directory source',
    },
  }
  const t = (k) => { const m = STR[LOCALE]; return (m && m[k] !== undefined) ? m[k] : (STR.zh[k] !== undefined ? STR.zh[k] : k) }
  const fmt = (k, map) => String(t(k)).replace(/\{(\w+)\}/g, (_, n) => String(map[n] !== undefined ? map[n] : ''))

  const MARKET_CSS = `
.mkts{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:60rem}
.mkts-env{font-family:ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px;white-space:pre-wrap}
.mkts-env-bad{color:var(--dsw-alias-label-error)}
.mkts-bin-row{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.mkts-bin-input{flex:1;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace;font-size:12px;padding:5px 10px;caret-color:var(--dsw-alias-brand-primary)}
.mkts-bin-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mkts-finder{position:sticky;top:0;z-index:5;background:var(--dsw-alias-bg-layer-2)}
.mkts-row1{display:flex;gap:10px;align-items:center;padding-block:10px}
.mkts-search{flex:1;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;caret-color:var(--dsw-alias-brand-primary);min-width:0}
.mkts-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.mkts-count{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mkts-livechip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-static-deepseek-500);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;cursor:pointer;white-space:nowrap;background:var(--dsw-alias-bg-layer-3)}
.mkts-livechip:hover{border-color:var(--dsw-alias-label-dimmed)}
.mkts-livechip-done{color:var(--dsw-alias-state-success-primary)}
.mkts-livechip-err{color:var(--dsw-alias-label-error)}
.mkts-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mkts-chip{font-size:12px;color:var(--dsw-alias-label-secondary);background:none;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;cursor:pointer}
.mkts-chip small{color:var(--dsw-alias-label-tertiary);font-size:10px}
.mkts-chip:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}
.mkts-chip-on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mkts-chip-on small{color:inherit;opacity:.8}
.mkts-sec{padding-block:14px 8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:baseline;gap:8px}
.mkts-sec small{font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.mkts-item{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s;align-items:flex-start}
.mkts-item:hover{border-color:var(--dsw-alias-label-dimmed)}
.mkts-no{flex:none;font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);padding-top:3px;min-width:40px}
.mkts-main{flex:1;min-width:0}
.mkts-main h3{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.mkts-main h3 a{color:var(--dsw-alias-label-primary);text-decoration:none}
.mkts-main h3 a:hover{color:var(--dsw-static-deepseek-500)}
.mkts-by{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}
.mkts-gh{margin-left:8px;font-size:11px;color:var(--dsw-static-deepseek-500);text-decoration:none}
.mkts-gh:hover{text-decoration:underline}
.mkts-desc{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:52em;overflow-wrap:break-word}
.mkts-actions{flex:none;display:flex;flex-direction:column;gap:4px;align-items:flex-end}
.mkts-cmdbtn{appearance:none;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:3px 12px;cursor:pointer;white-space:nowrap}
.mkts-cmdbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.mkts-cmdbtn-primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mkts-cmdbtn-primary:hover:not(:disabled){opacity:.85;color:var(--dsw-alias-bg-layer-3)}
.mkts-cmdbtn-danger{color:var(--dsw-alias-label-error)}
.mkts-cmdbtn-danger:hover:not(:disabled){border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error)}
.mkts-cmdbtn:disabled{opacity:.4;cursor:default}
.mkts-state{font-size:11px;padding:1px 8px;border-radius:999px;line-height:17px;font-weight:500;white-space:nowrap}
.mkts-state-on{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.mkts-state-off{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mkts-log{background:#1e1e1e;color:#d4d4d4;border-radius:8px;padding:8px 10px;margin-top:6px;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:240px;overflow:auto}
.mkts-err{color:var(--dsw-alias-label-error);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-radius:8px;padding:6px 10px;margin-bottom:10px}
.mkts-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.mkts-detail{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.mkts-detail code{display:block;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;margin:6px 0;white-space:pre-wrap;word-break:break-all}
.mkts-modal-bg{position:fixed;inset:0;z-index:1000;background:color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent);display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px 24px;overflow:auto}
.mkts-modal{width:min(780px,100%);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:16px 18px;box-shadow:0 16px 48px rgba(0,0,0,.35)}
.mkts-modal h4{margin:0 0 10px;font-size:15px;font-weight:600}
.mkts-cmdrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.mkts-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-static-deepseek-500);border-radius:50%;animation:mkts-spin .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes mkts-spin{to{transform:rotate(360deg)}}
.mkts-site{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.mkts-site a{color:var(--dsw-static-deepseek-500);text-decoration:none}
.mkts-site a:hover{text-decoration:underline}
.mkts-skipcheck{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px;cursor:pointer}
`

  function MarketPanel() {
    const [data, setData] = useState({ phase: 'loading', plugins: [], cats: [], installed: null, error: null })
    const [envInfo, setEnvInfo] = useState(null)
    const [binPath, setBinPath] = useState((() => { try { return localStorage.getItem('mktsBin') || '' } catch (e) { return '' } })())
    const [query, setQuery] = useState('')
    const [cat, setCat] = useState('all')
    const [showInstalled, setShowInstalled] = useState(false)
    const [open, setOpen] = useState(null)
    const [op, setOp] = useState(null)
    const pollStop = useRef(false)
    useEffect(() => () => { pollStop.current = true }, [])

    const changeBin = (v) => { setBinPath(v); try { localStorage.setItem('mktsBin', v) } catch (e) {} }

    const probe = () => {
      api('probe', { binPath }).then((r) => setEnvInfo(r)).catch(() => setEnvInfo({ error: 'probe failed' }))
    }

    const loadInstalled = (plugins) => {
      const list = plugins || data.plugins || []
      const profiles = [...new Set(list.map((p) => p.profile || 'web').concat('web'))]
      Promise.all(profiles.map((profile) => api('installed', { profile }).then((r) => [profile, r]).catch(() => [profile, null])))
        .then((entries) => setData((d) => ({ ...d, installed: Object.fromEntries(entries) })))
        .catch(() => setData((d) => ({ ...d, installed: null })))
    }

    useEffect(() => { probe() }, [])

    useEffect(() => {
      let alive = true
      setData((d) => ({ ...d, phase: 'loading', error: null }))
      const finish = (r) => {
        if (!alive || !r || !r.ok) throw new Error((r && r.error) || 'empty')
        setData((d) => ({ ...d, phase: 'ready', plugins: r.plugins || [], cats: r.cats || [] }))
        loadInstalled(r.plugins || [])
      }
      api('list', { lang: LOCALE }).then(finish).catch((e) => {
        if (!alive) return
        setData((d) => ({ ...d, phase: 'error', error: t('fetchFail') + ': ' + String((e && e.message) || e) }))
      })
      return () => { alive = false }
    }, [])

    // Resume a background op after a page refresh / tab switch.
    useEffect(() => {
      api('op', {}).then((r) => {
        if (!r || !r.ok || !r.op || r.op.status !== 'running') return
        const o = r.op
        setOp({
          kind: o.kind, target: o.target, label: o.label, profile: o.profile,
          phase: 'running', opId: o.id, output: o.output, status: 'running', exitCode: null, minimized: false,
          elapsedMs: o.elapsedMs, timeoutMs: o.timeoutMs,
        })
        pollOp(o.id)
      }).catch(() => {})
    }, [])

    function pollOp(opId) {
      const step = () => {
        if (pollStop.current) return
        api('op', { opId }).then((r) => {
          if (pollStop.current) return
          const o = r && r.ok ? r.op : null
          if (!o) return // op gone (replaced/restarted) — stop polling
          setOp((prev) => {
            if (!prev || prev.opId !== opId) return prev
            if (o.status === 'running') {
              return { ...prev, phase: 'running', output: o.output, elapsedMs: o.elapsedMs, timeoutMs: o.timeoutMs }
            }
            return {
              ...prev, phase: 'done', output: o.output, status: o.status,
              exitCode: o.exitCode, ok: o.status === 'done',
            }
          })
          if (o.status === 'running') setTimeout(step, 2000)
          else loadInstalled() // terminal: profile deps/bundles changed — refresh badges
        }).catch(() => { if (!pollStop.current) setTimeout(step, 3000) })
      }
      step()
    }

    const runOp = (kind, target, label, profile) => {
      setOp({ kind, target, label, profile: profile || 'web', phase: 'confirm', minimized: false })
    }

    const executeOp = () => {
      if (!op) return
      setOp({ ...op, phase: 'starting', output: '' })
      const params = op.kind === 'install'
        ? { source: op.target, profile: op.profile, binPath, label: op.label, skipCheck: !!op.skipCheck }
        : { pkg: op.target, profile: op.profile, binPath, label: op.label }
      api(op.kind === 'install' ? 'install' : 'uninstall', params).then((r) => {
        if (!r || !r.ok) {
          setOp({
            ...op, phase: 'done', status: r && r.busy ? 'busy' : (r && r.refused ? 'refused' : 'failed'),
            output: String((r && (r.output || r.error)) || t('opFailed')), ok: false,
          })
          return
        }
        setOp({ ...op, phase: 'running', opId: r.opId, output: '', status: 'running', elapsedMs: 0, timeoutMs: r.timeoutMs })
        pollOp(r.opId)
      }).catch((e) => {
        setOp({ ...op, phase: 'done', status: 'failed', output: String((e && e.message) || e), ok: false })
      })
    }

    const killCurrent = () => {
      api('kill').then((r) => {
        if (r && r.ok) {
          setOp((prev) => prev ? { ...prev, phase: 'done', status: 'killed', ok: false } : prev)
          loadInstalled() // the kill may have partially applied — resync state
        } else {
          setOp((prev) => prev ? { ...prev, phase: 'done', status: 'failed', output: String((r && r.output) || t('opFailed')), ok: false } : prev)
        }
      }).catch(() => {})
    }

    const minimizeOp = () => setOp((prev) => prev ? { ...prev, minimized: true } : prev)
    const restoreOp = () => setOp((prev) => prev ? { ...prev, minimized: false } : prev)
    const closeOp = () => setOp(null)

    const filtered = (data.plugins || []).filter((p) => {
      if (cat !== 'all' && p.cat !== cat) return false
      if (showInstalled && !isInstalled(p, data.installed)) return false
      const q = query.trim().toLowerCase()
      if (q && !((p.name || '').toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q) || (p.by || '').toLowerCase().includes(q))) return false
      return true
    })

    const installedCount = (data.plugins || []).filter((p) => isInstalled(p, data.installed)).length

    let groups = []
    if (cat === 'all' && !showInstalled) {
      for (const c of data.cats || []) {
        if (c.id === 'all') continue
        const items = filtered.filter((p) => p.cat === c.id)
        if (items.length > 0) groups.push({ id: c.id, label: c.label, items })
      }
    } else {
      groups.push({ id: 'sel', label: null, items: filtered })
    }

    const binOk = envInfo && (envInfo.dshBin || (envInfo.binProvided && envInfo.binValid))
    const envReady = envInfo && binOk && envInfo.node && envInfo.dshHome

    const statusText = (s) => ({
      done: t('stDone'), failed: t('stFailed'), killed: t('stKilled'),
      timeout: t('stTimeout'), busy: t('stBusy'), refused: t('stRefused'),
    })[s] || t('opFailed')

    const opTitle = (op) => (op.kind === 'install' ? t('install') : t('uninstall')) + ' ' + op.label

    const modal = op && !op.minimized ? h('div', { className: 'mkts-modal-bg', onClick: () => { if (op.phase === 'running' || op.phase === 'starting') minimizeOp(); else closeOp() } },
      h('div', { className: 'mkts-modal', onClick: (e) => e.stopPropagation() },
        h('h4', null, opTitle(op)),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace,monospace' } },
          'dsh plugin --profile ' + op.profile + ' ' + (op.kind === 'install' ? 'add ' : 'remove ') + op.target),
        op.phase === 'confirm' ? h('div', null,
          h('div', { className: 'mkts-cmdrow' },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '✓ ' + t('cmdLabel').replace(':', '') + ''),
            h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: executeOp }, t('execute')),
            h('button', { className: 'mkts-cmdbtn', onClick: closeOp }, t('cancel')),
          ),
          op.kind === 'install' ? h('label', { className: 'mkts-skipcheck' },
            h('input', { type: 'checkbox', checked: !!op.skipCheck, onChange: (e) => setOp((prev) => prev ? { ...prev, skipCheck: e.target.checked } : prev) }),
            h('span', null, LOCALE === 'zh' ? '跳过完整应用类型检查（风险自负：可能装坏 web 启动）' : 'Skip full-app type check (risky: may break web boot)'),
          ) : null,
        ) : null,
        op.phase === 'starting' ? h('div', { className: 'mkts-cmdrow' },
          h('span', { className: 'mkts-spin' }), h('span', { style: { fontSize: 12 } }, t('submit')),
        ) : null,
        op.phase === 'running' ? h('div', null,
          h('div', { className: 'mkts-cmdrow' },
            h('span', { className: 'mkts-spin' }),
            h('span', { style: { fontSize: 12 } },
              t('running') + ' · ' + fmt('elapsed', { s: Math.round((op.elapsedMs || 0) / 1000), t: op.timeoutMs ? Math.round(op.timeoutMs / 1000) : 120 })),
            h('button', { className: 'mkts-cmdbtn', onClick: minimizeOp }, t('min')),
            h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: killCurrent }, t('kill')),
          ),
          op.output ? h('div', { className: 'mkts-log' }, op.output) : null,
        ) : null,
        op.phase === 'done' ? h('div', null,
          h('div', { style: { fontSize: 12, fontWeight: 600, color: op.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-error)' } },
            op.ok ? (op.kind === 'install' ? t('installOk') : t('uninstallOk'))
              : statusText(op.status) + (op.exitCode !== null && op.exitCode !== undefined ? ' (exit ' + op.exitCode + ')' : '')),
          op.output ? h('div', { className: 'mkts-log' }, op.output) : null,
          h('div', { className: 'mkts-cmdrow' }, h('button', { className: 'mkts-cmdbtn', onClick: closeOp }, t('close'))),
        ) : null,
      )) : null

    const liveChip = op && op.minimized ? h('button', {
      className: 'mkts-livechip' + (op.phase === 'done' ? (op.ok ? ' mkts-livechip-done' : ' mkts-livechip-err') : ''),
      onClick: restoreOp,
      title: op.label,
    },
      op.phase === 'done' ? (op.ok ? t('stDone') : statusText(op.status)) : t('liveChip'),
      ' · ' + op.label,
    ) : null

    return h('div', { className: 'mkts' },
      envInfo ? h('div', { className: 'mkts-env' + (envReady ? '' : ' mkts-env-bad') },
        t('envLine') + ': DSH_HOME ' + (envInfo.dshHome ? '✓ ' + envInfo.dshHome : '✗') + ' · node ' + (envInfo.node ? '✓' : '✗') + ' · dsh ' + (binOk ? '✓' : '✗') +
        ((!envInfo.dshBin && !(envInfo.binProvided && envInfo.binValid)) ? ' — dsh CLI 未定位' : ''),
      ) : null,
      h('div', { className: 'mkts-bin-row' },
        h('input', { className: 'mkts-bin-input', placeholder: t('binPlaceholder'), value: binPath, onChange: (e) => changeBin(e.target.value) }),
        h('button', { className: 'mkts-cmdbtn', onClick: probe }, t('reprobe')),
      ),
      h('div', { className: 'mkts-site' },
        h('span', null, t('site') + ': '),
        h('a', { href: LOCALE === 'zh' ? 'https://awesome-dsh-plugin.com/zh/' : 'https://awesome-dsh-plugin.com/', target: '_blank', rel: 'noopener noreferrer' },
          LOCALE === 'zh' ? 'https://awesome-dsh-plugin.com/zh/' : 'https://awesome-dsh-plugin.com/'),
        h('span', null, ' ↗'),
      ),
      modal,
      h('div', { className: 'mkts-finder' },
        h('div', { className: 'mkts-row1' },
          h('input', { className: 'mkts-search', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
          liveChip,
          h('span', { className: 'mkts-count' }, filtered.length + ' / ' + (data.plugins || []).length),
        ),
        h('div', { className: 'mkts-chips' },
          (data.cats || []).map((c) => h('button', {
            key: c.id,
            className: 'mkts-chip' + (cat === c.id && !showInstalled ? ' mkts-chip-on' : ''),
            onClick: () => { setCat(c.id); setShowInstalled(false) },
          }, (c.id === 'all' ? t('all') : c.label), ' ', h('small', null, c.count))),
          h('button', {
            className: 'mkts-chip' + (showInstalled ? ' mkts-chip-on' : ''),
            onClick: () => { setShowInstalled(!showInstalled); setCat('all') },
          }, t('instFilter'), ' ', h('small', null, installedCount)),
        ),
      ),
      data.phase === 'loading' ? h('div', null, t('loading')) : null,
      data.phase === 'error' ? h('div', { className: 'mkts-err' }, data.error) : null,
      data.phase === 'ready' ? groups.map((g) => h('div', { key: g.id },
        g.label ? h('div', { className: 'mkts-sec' }, g.label, h('small', null, g.items.length)) : null,
        g.items.map((p, i) => {
          const inst = isInstalled(p, data.installed)
          const isOpen = open === p.url
          return h('div', { key: p.url, className: 'mkts-item' },
            h('span', { className: 'mkts-no' }, '№ ' + String(i + 1).padStart(2, '0')),
            h('div', { className: 'mkts-main' },
              h('h3', null,
                h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.name),
                p.by ? h('span', { className: 'mkts-by' }, '@' + p.by) : null,
                h('a', { className: 'mkts-gh', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, t('gh')),
              ),
              p.desc ? h('p', { className: 'mkts-desc' }, p.desc) : null,
              isOpen ? h('div', { className: 'mkts-detail' },
                h('div', null, t('cmdLabel')),
                h('code', null, p.cmd || t('noCmd')),
                h('div', { className: 'mkts-hint' }, t('hint')),
              ) : null,
            ),
            h('div', { className: 'mkts-actions' },
              h('span', { className: 'mkts-state ' + (inst ? 'mkts-state-on' : 'mkts-state-off') }, inst ? t('instFilter') : (LOCALE === 'zh' ? '未安装' : 'Not installed')),
              h('button', { className: 'mkts-cmdbtn', onClick: () => setOpen(isOpen ? null : p.url) }, isOpen ? t('collapse') : t('detail')),
              inst
                ? h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-danger', onClick: () => runOp('uninstall', installedPkgName(p, data.installed) || p.name, p.name, p.profile) }, t('uninstall'))
                : (p.source ? h('button', { className: 'mkts-cmdbtn mkts-cmdbtn-primary', onClick: () => runOp('install', p.source, p.name, p.profile) }, t('install')) : null),
            ),
          )
        }),
      )) : null,
      data.phase === 'ready' && filtered.length === 0 ? h('div', { className: 'mkts-hint' }, t('noMatch')) : null,
    )
  }

  const inject = ['slots']

  function apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => {
      const id = 'dsh-market-style'
      if (!document.getElementById(id)) {
        const s = document.createElement('style')
        s.id = id
        s.textContent = MARKET_CSS
        document.head.appendChild(s)
      }
      return () => { const el = document.getElementById(id); if (el) el.remove() }
    }, 'market-style')
    slots.inject('settings.plugins.tab', () => slots.register(
      { name: 'settings.plugins.tab', id: 'market', order: 5, label: () => (LOCALE === 'zh' ? '插件市场' : 'Plugin Market') },
      MarketPanel,
    ))
  }

  module.exports = { inject, apply }
  return module.exports;
} })
