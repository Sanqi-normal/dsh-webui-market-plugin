
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const HOME = 'C:/Users/28171/dsh-market-plugin/.scratch/home'
const PROFILE = join(HOME, 'profiles/web')
const HARNESS = 'D:/Apps/dsh/deepseek-harness'

const env = { ...process.env, DSH_HOME: HOME, CI: 'true' }

function run(label, cmd) {
  const res = spawnSync(cmd.file, cmd.args, { cwd: cmd.cwd || PROFILE, env, encoding: 'utf8', shell: process.platform === 'win32' })
  console.log('\n######## ' + label + ' ########')
  console.log('exit:', res.status, 'signal:', res.signal)
  const out = String(res.stdout || '').trim().split('\n').slice(-15).join('\n')
  const err = String(res.stderr || '').trim().split('\n').slice(-15).join('\n')
  if (out) console.log('stdout tail:\n' + out)
  if (err) console.log('stderr tail:\n' + err)
  return res.status
}

// 1) install the old versions (like a previously-installed plugin)
run('pnpm install (0.12.1 / 3.17.0)', { file: 'pnpm', args: ['install'], cwd: PROFILE })

// 2) run checkUpdates like the market host does
const check = await import('file:///C:/Users/28171/dsh-market-plugin/lib/host.js').then(m => m.checkUpdates)
const before = await check('web')
console.log('\n===== checkUpdates BEFORE update =====')
for (const [k, v] of Object.entries(before)) console.log(k, JSON.stringify(v))

// 3) the exact market update command (dsh plugin --profile web add <name>@latest)
const cli = { file: process.execPath, args: ['--import', 'tsx', join(HARNESS, 'apps/cli/src/bin.ts'), 'plugin', '--profile', 'web', 'add', 'dsh-better-sidebar@latest'], cwd: HARNESS }
const st = run('market update: dsh plugin --profile web add dsh-better-sidebar@latest', cli)

// 4) re-check
const after = await check('web')
console.log('\n===== checkUpdates AFTER update =====')
for (const [k, v] of Object.entries(after)) console.log(k, JSON.stringify(v))

// 5) show resulting manifest + installed version
const fs = await import('node:fs')
console.log('\n===== package.json after =====')
console.log(fs.readFileSync(join(PROFILE, 'package.json'), 'utf8'))
try {
  const m = JSON.parse(fs.readFileSync(join(PROFILE, 'node_modules/dsh-better-sidebar/package.json'), 'utf8'))
  console.log('installed dsh-better-sidebar version:', m.version)
} catch (e) { console.log('read installed manifest failed:', e.message) }
