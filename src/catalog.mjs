/**
 * catalog.mjs —— 源解析统一（spec §5.1 / R4 / R5 / B4）。
 * 短名 → 源上下文：目录（sync.config.json 的 skills）+ 本地路径 + 回退 npx。
 */
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { cacheKeyForSource } from './add.mjs'
import { expandHome } from './sync.mjs'

/** 目录查询：config.skills[name] */
export function lookupCatalog(name, config) {
  const entry = config.skills?.[name]
  return entry ? { found: true, entry } : { found: false }
}

/**
 * 统一"短名 → 源上下文"。
 * context.kind：
 *   'path'   → 本地源根（本地存在的路径；或 --islocal 命中 localPath / 缓存）
 *   'source' → 远程源字符串（目录默认 / URL）
 *   'npx'    → 目录未命中且非 --islocal → 回退 npx skills add
 */
export function resolveSourceForName(name, config, { home = homedir(), isLocal = false, exists = existsSync } = {}) {
  if (exists(name) || exists(resolve(name))) {
    return { ok: true, context: { kind: 'path', path: resolve(name) } }
  }
  const hit = lookupCatalog(name, config)
  if (hit.found) {
    const { entry } = hit
    if (isLocal) {
      // 相对 localPath 缺 repoRoot 时无法解析，但先走缓存回退（--islocal 离线可用），
      // 缓存也没有才报错指路——别让这条守卫把原本能用的缓存路径挡掉
      const hasLocalPath = typeof entry.localPath === 'string' && entry.localPath.trim() !== ''
      const expandedLocalPath = hasLocalPath ? expandHome(entry.localPath, home) : ''
      const relLocalPath = hasLocalPath
        && !isAbsolute(expandedLocalPath)
        && !/^[A-Za-z]:[\\/]/.test(expandedLocalPath)
      if (!relLocalPath && hasLocalPath) {
        const lp = resolve(expandedLocalPath)
        if (exists(lp)) return { ok: true, context: { kind: 'path', path: lp } }
      }
      const key = cacheKeyForSource(entry.source.replace(/\.git$/, ''), false)
      const cacheDir = join(home, '.aas', 'repos', key)
      if (exists(cacheDir)) return { ok: true, context: { kind: 'path', path: cacheDir } }
      if (relLocalPath) {
        return { ok: false, reason: `无法解析本地路径：${name}（skills.${name}.localPath 是相对路径 ${entry.localPath}，需要 repoRoot 才能解析——先跑 aas config init）` }
      }
      return { ok: false, reason: `本地未找到：${name}（localPath 不存在、缓存也没有）` }
    }
    return { ok: true, context: { kind: 'source', source: entry.source } }
  }
  if (isLocal) return { ok: false, reason: `本地未找到：${name}（目录里没有这个短名）` }
  return { ok: true, context: { kind: 'npx', name } }
}
