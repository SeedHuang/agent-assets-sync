/**
 * cli-version.mjs —— CLI 依赖的版本检查与更新（spec §5.3 / R6 / B2 / O1）。
 * 外部副作用（跑 --version / npm view / npm install -g）全部经注入的 exec，便于单测。
 */
import { execFileSync } from 'node:child_process'

/** 正在运行的 aas 自身的识别名（B2：不自动更新自己） */
export const SELF_NAMES = ['aas', 'agent-assets-sync']

export function isSelfCli(name) {
  return SELF_NAMES.includes(name)
}

/** 从 --version 输出剥出第一个 semver（容忍 "v1.2.3"、"aas 1.2.3 (c)"） */
export function parseVersion(output) {
  const m = String(output ?? '').match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)
  return m ? m[0] : null
}

/** semver 数值比较：a>b→1 / a<b→-1 / 相等→0；任一无法解析 → null */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa || !pb) return null
  const na = pa.split(/[-+]/)[0].split('.').map(Number)
  const nb = pb.split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (na[i] > nb[i]) return 1
    if (na[i] < nb[i]) return -1
  }
  return 0
}

function runCmd(cmd, args, { exec = execFileSync } = {}) {
  try {
    return { ok: true, out: exec(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (e) {
    const stderr = String(e.stderr || e.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, error: { cmd: [cmd, ...args].join(' '), status: e.status ?? '?', syscode: e.code, stderr } }
  }
}

export function localVersion(name, { exec = execFileSync } = {}) {
  return runCmd(name, ['--version'], { exec })
}

export function remoteVersion(name, { exec = execFileSync } = {}) {
  return runCmd('npm', ['view', name, 'version'], { exec })
}

/** 判定是否需要更新（spec §5.3 步 3）：本地缺失 / 低于 minVersion / 远端更新 */
export function needsUpdate({ local, remote, minVersion }) {
  if (!local) return true
  if (minVersion && compareVersions(local, minVersion) === -1) return true
  if (remote && compareVersions(remote, local) === 1) return true
  return false
}

/**
 * 单个 CLI 依赖的检查与更新。返回 { name, action, detail }
 * action: 'updated' | 'installed' | 'ok' | 'error'（失败不抛，带完整错误信息）
 */
export async function ensureCli({ name, versionSource, minVersion }, { exec = execFileSync } = {}) {
  if (versionSource !== 'npm') return { name, action: 'error', detail: `不支持的 versionSource：${versionSource}` }
  if (isSelfCli(name)) {
    return { name, action: 'error', detail: `不能自动更新正在运行的 aas 自身，请手动 npm install -g ${name}@latest 后重跑` }
  }
  const lv = localVersion(name, { exec })
  if (!lv.ok && lv.error.syscode !== 'ENOENT') {
    return { name, action: 'error', detail: `无法获取本地版本：${lv.error.cmd}（退出码 ${lv.error.status}）${lv.error.stderr}` }
  }
  const rv = remoteVersion(name, { exec })
  if (!rv.ok) return { name, action: 'error', detail: `无法获取远端版本：${rv.error.cmd}（退出码 ${rv.error.status}）${rv.error.stderr}` }
  const local = lv.ok ? lv.out.trim() : null // ENOENT → 本地缺失（spec §5.3 步 3）
  const remote = rv.out.trim()
  if (!needsUpdate({ local, remote, minVersion })) return { name, action: 'ok', detail: `已满足（本地 ${local} / 远端 ${remote}）` }
  const up = runCmd('npm', ['install', '-g', `${name}@latest`], { exec })
  if (!up.ok) return { name, action: 'error', detail: `${up.error.cmd}（退出码 ${up.error.status}）${up.error.stderr}` }
  return { name, action: local ? 'updated' : 'installed', detail: `→ ${remote}` }
}
