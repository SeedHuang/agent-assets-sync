/**
 * deps.mjs —— 依赖解析器（spec §5.2 / M1 / B1 / B3 / R7）。
 * 纯逻辑：文件读写只读清单，安装/刷新/CLI 副作用全部经 ensureSkill / ensureCli 注入。
 */
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const SCHEMA_VERSION = 1

/** 读并校验单个依赖清单（spec §4.2 字段规则） */
export function readManifest(manifestPath) {
  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`依赖清单解析失败：${manifestPath}（${e.message}）`)
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`依赖清单 schemaVersion=${raw.schemaVersion} 不受支持（支持 ${SCHEMA_VERSION}）：${manifestPath}`)
  }
  if (typeof raw.skill !== 'string' || raw.skill === '') throw new Error(`依赖清单缺 skill 名：${manifestPath}`)
  const fileName = basename(manifestPath).replace(/\.json$/, '')
  if (raw.skill !== fileName) {
    throw new Error(`依赖清单 skill 名 ${raw.skill} 与文件名 ${fileName} 不一致：${manifestPath}`)
  }
  const deps = raw.dependencies ?? {}
  const skills = Array.isArray(deps.skills) ? deps.skills : []
  const cli = Array.isArray(deps.cli) ? deps.cli : []
  for (const d of skills) {
    if (!d || typeof d.name !== 'string' || d.name === '') throw new Error(`依赖清单 skills 条目缺 name：${manifestPath}`)
    if (d.source !== undefined && typeof d.source !== 'string') throw new Error(`依赖清单 skills[${d.name}].source 应为字符串：${manifestPath}`)
  }
  for (const c of cli) {
    if (!c || typeof c.name !== 'string' || c.name === '') throw new Error(`依赖清单 cli 条目缺 name：${manifestPath}`)
    if (c.versionSource !== 'npm') throw new Error(`依赖清单 cli[${c.name}].versionSource 只支持 npm：${manifestPath}`)
  }
  return { schemaVersion: SCHEMA_VERSION, skill: raw.skill, skills, cli }
}

/**
 * BFS 依赖解析（spec §5.2 / R7 防环）。
 * ensureSkill(name, sourceCtx) → { ok, action?: 'installed'|'refreshed', manifestDir? } | { ok:false, error }
 *   - manifestDir：该依赖的 skilldependencies 目录（M1：与安装源一致）
 * ensureCli(cliEntry) → { action, name, detail }
 * 返回汇总（R6：失败记入 failures，不中断批次）。
 * 注入的 ensureSkill / ensureCli 可能是 async，须 await 取结果。
 */
export async function resolveSkillDeps({ skill, rootManifestDir, rootSourceCtx, ensureSkill, ensureCli }) {
  const visited = new Set()
  const failures = []
  const installed = [], refreshed = [], cliUpdated = [], cliInstalled = []
  const queue = [{ name: skill, manifestDir: rootManifestDir, sourceCtx: rootSourceCtx }]
  while (queue.length > 0) {
    const cur = queue.shift()
    const key = `${cur.name}|${cur.sourceCtx}`
    if (visited.has(key)) continue
    visited.add(key)
    let manifest
    try {
      manifest = readManifest(join(cur.manifestDir, `${cur.name}.json`))
    } catch (e) {
      failures.push({ type: 'manifest', name: cur.name, detail: e.message })
      continue
    }
    for (const d of manifest.skills) {
      const dCtx = d.source ?? cur.sourceCtx // R2：省略 source 继承当前源
      let r
      try {
        r = await ensureSkill(d.name, dCtx)
      } catch (e) {
        // I2（违 R6/O1）：注入回调抛异常（parseSource/clone 失败等）不能中断整批——记入 failures 继续
        failures.push({ type: 'skill', name: d.name, detail: e.message })
        continue
      }
      if (!r.ok) {
        failures.push({ type: 'skill', name: d.name, detail: r.error })
        continue
      }
      if (r.action === 'installed') installed.push(d.name)
      else if (r.action === 'refreshed') refreshed.push(d.name)
      queue.push({ name: d.name, manifestDir: r.manifestDir, sourceCtx: dCtx })
    }
    for (const c of manifest.cli) {
      let r
      try {
        r = await ensureCli(c)
      } catch (e) {
        failures.push({ type: 'cli', name: c.name, detail: e.message })
        continue
      }
      if (r.action === 'updated') cliUpdated.push(r)
      else if (r.action === 'installed') cliInstalled.push(r)
      else if (r.action === 'error') failures.push({ type: 'cli', name: c.name, detail: r.detail })
    }
  }
  return { installed, refreshed, cliUpdated, cliInstalled, failures, visited: [...visited] }
}
