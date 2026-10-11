/**
 * config.mjs —— 配置规范化 + 分层合并 + repoRoot 推导（阶段 2 底座）。
 *
 * sync.config.json 有两种形态：
 *   旧格式：{ targets: [...] }                              —— 仅链接形态
 *   新格式：{ schemaVersion, editors, sources, linkTargets } —— 编辑器适配器 + 源登记 + 链接形态
 *
 * 载入器必须两种都认（设计稿 §3「配置文件的演进纪律」）：
 * normalizeConfig 把两种都归一成 { schemaVersion, editors, sources, targets, skills, repoRoot, editor }，
 * 其中 targets 永远是链接形态的原始条目数组（直接喂给 sync.mjs 的 buildTargets）。
 *
 * 分层（2026-10-10 起，见 docs/design.md「配置分层」）：
 *   骨架 sync.config.json（随包发布，零个人路径） + 用户配置 ~/.aas/config.json（repoRoot / editor）。
 *   resolveConfig = mergeConfigs（用户覆盖骨架） → derivePaths（按 repoRoot 推导） → normalizeConfig。
 *   推导规则：linkTargets 的 srcDir 为相对路径时解析为 <repoRoot>/<srcDir>；
 *            skills 缺 localPath 时默认 localPath = repoRoot（换机只改 repoRoot 一个值）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_SCHEMA_VERSION = 1

/** 默认配置文件：本项目根下的 sync.config.json（src/ 的上一级）。从 sync.mjs 迁来——放叶子避免 config↔sync 循环 */
export const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sync.config.json')

/** 读配置文件；顺手剥掉 BOM（PowerShell 写文件容易带，会让 JSON.parse 报错）。从 sync.mjs 迁来 */
export function loadConfig(configPath) {
  const p = resolve(configPath)
  if (!existsSync(p)) throw new Error(`配置文件不存在：${p}`)
  // 读与解析分开 try：I/O 失败（EACCES/EISDIR）不该被当成「不是合法 JSON」
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(`配置文件读取失败：${p}\n${e.message}`)
  }
  try {
    return parseJsonWithBom(text)
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${p}\n${e.message}`)
  }
}

/** 解析 JSON 文本（剥 BOM）：loadConfig / user-config 共用，BOM/解析行为一处维护，防两份漂移 */
export function parseJsonWithBom(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** 展开开头的 ~（兼容 ~/ 与 ~\）。从 sync.mjs 迁来，config↔sync 循环依赖下放这里最安全 */
export function expandHome(p, home = homedir()) {
  if (typeof p !== 'string') return p
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/**
 * 校验「预留覆盖位」（用户配置可覆盖骨架的同名段）的结构。
 * normalizeConfig 与 user-config 的 validateUserConfigShape 共用这一份规则——
 * 两处规则曾不一致（用户配置只查「是对象」，normalizeConfig 还查 sources 的值 / skills 的 source），
 * 导致坏值能通过用户配置校验、原样写回，然后被 normalizeConfig 拒绝，config set 也清不掉它。
 * 不合 → 抛错。
 */
export function validateOverrideSections(raw) {
  for (const k of ['sources', 'skills', 'editors']) {
    if (raw[k] === undefined) continue
    if (!raw[k] || typeof raw[k] !== 'object' || Array.isArray(raw[k])) {
      throw new Error(`${k} 应为对象`)
    }
  }
  if (raw.linkTargets !== undefined && !Array.isArray(raw.linkTargets)) {
    throw new Error('linkTargets 应为数组')
  }
  for (const [name, url] of Object.entries(raw.sources ?? {})) {
    if (typeof url !== 'string' || url.trim() === '') throw new Error(`sources 条目应为非空字符串：${name}`)
  }
  for (const [name, entry] of Object.entries(raw.skills ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`skills 条目应为对象：${name}`)
    if (typeof entry.source !== 'string' || entry.source.trim() === '') {
      throw new Error(`skills 条目缺 source：${name}`)
    }
    // localPath 类型与 derivePaths 一致（undefined/null 由 derivePaths 补 repoRoot；非字符串是手改笔误，拦在写回前）
    if (entry.localPath !== undefined && entry.localPath !== null && typeof entry.localPath !== 'string') {
      throw new Error(`skills 条目 localPath 应为字符串：${name}`)
    }
  }
}

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置文件内容不是对象')
  }
  const schemaVersion = raw.schemaVersion ?? 1
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`配置 schemaVersion=${schemaVersion} 不受支持（支持 ${SUPPORTED_SCHEMA_VERSION}）`)
  }
  const editors = raw.editors ?? {}
  const sources = raw.sources ?? {}
  const skills = raw.skills ?? {}
  if (typeof editors !== 'object' || Array.isArray(editors)) throw new Error('配置的 editors 应为对象')
  if (typeof sources !== 'object' || Array.isArray(sources)) throw new Error('配置的 sources 应为对象')
  // sources / skills / editors / linkTargets 的结构校验（与用户配置共用一份规则）
  validateOverrideSections(raw)

  // 用户配置字段（~/.aas/config.json 的 repoRoot / editor）：透传 + 类型校验。
  // repoRoot = 源仓库根（推导 srcDir/localPath 的唯一机器相关值）；editor = 用户钦定的编辑器预设
  if (raw.repoRoot !== undefined && typeof raw.repoRoot !== 'string') throw new Error('配置 repoRoot 应为字符串')
  if (raw.editor !== undefined && typeof raw.editor !== 'string') throw new Error('配置 editor 应为字符串')
  const repoRoot = typeof raw.repoRoot === 'string' && raw.repoRoot.trim() !== '' ? raw.repoRoot : null
  const editor = typeof raw.editor === 'string' && raw.editor.trim() !== '' ? raw.editor : null

  let targets
  if (Array.isArray(raw.linkTargets)) targets = raw.linkTargets
  else if (Array.isArray(raw.targets)) targets = raw.targets // 旧格式
  else throw new Error('配置里没有 targets/linkTargets（应为数组）')

  return { schemaVersion, editors, sources, targets, skills, repoRoot, editor }
}

/** 是不是纯对象（null/数组不算） */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 深合并：标量 / 数组用用户值替换，对象递归合并，undefined 跳过。
 * 分层语义：用户配置 ~/.aas/config.json 覆盖骨架 sync.config.json，
 * 骨架里已有的字段被替换，缺的字段补进来，互不干扰。
 */
export function mergeConfigs(base, user) {
  if (!isPlainObject(user)) return user ?? base
  if (!isPlainObject(base)) return user
  const out = { ...base }
  for (const [k, v] of Object.entries(user)) {
    if (v === undefined) continue
    // 防原型污染：JSON.parse 会把 __proto__ / constructor / prototype 解析成自有属性，
    // 直接赋值会命中 Object.prototype 的 setter 改原型——跳过这几个键
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? mergeConfigs(base[k], v) : v
  }
  return out
}

/** env 感知取字段（环境变量非空时优先）：buildTargets / add / import 共用同一优先级规则，防各自漂移 */
export function pickEnvField(raw, key, env) {
  const name = raw.env?.[key]
  return typeof name === 'string' && typeof env?.[name] === 'string' && env[name].trim() !== '' ? env[name] : raw[key]
}

/**
 * 按 repoRoot 推导路径（换机只改 repoRoot 一个值）：
 *   - linkTargets / targets 的 srcDir 若为相对路径 → <repoRoot>/<srcDir>（如 "rules" → D:/Seed/retro-skills/rules）
 *   - skills 缺 localPath → 默认 localPath = repoRoot
 * repoRoot 未设置时原样返回（buildTargets 会对残留的相对 srcDir 报错指路 config init）。
 */
export function derivePaths(config, { home = homedir() } = {}) {
  const cfg = { ...config }
  const repoRoot = typeof cfg.repoRoot === 'string' && cfg.repoRoot.trim() !== '' ? cfg.repoRoot : null
  if (!repoRoot) return cfg
  // 拒绝相对 repoRoot：否则 resolve 到 cwd，所有推导的 srcDir/localPath 都静默依赖当前工作目录
  const repoRootAbs = expandHome(repoRoot, home)
  if (!isAbsolute(repoRootAbs)) {
    throw new Error(`repoRoot 是相对路径（${repoRoot}）——需要绝对路径。\n  下一步：aas config set repoRoot <绝对路径>`)
  }
  const root = resolve(repoRootAbs)
  // 回写归一后的 repoRoot：否则下游读 config.repoRoot 拿到的仍是原始值（如 ~ 前缀、非绝对），与已推导的 srcDir 不一致
  cfg.repoRoot = root
  // normalizeConfig 只消费 linkTargets（存在时）否则 targets——只推导那个，另一个数组不产生死推导
  let arrKey = null
  if (Array.isArray(cfg.linkTargets)) arrKey = 'linkTargets'
  else if (Array.isArray(cfg.targets)) arrKey = 'targets'
  if (arrKey) {
    cfg[arrKey] = cfg[arrKey].map((t) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) return t
      if (typeof t.srcDir !== 'string' || t.srcDir.trim() === '') return t
      // 先展开 ~ 再判绝对：~/x 本身是绝对路径（requireAbsoluteSrcDir / buildTargets 都认），
      // 只有真相对路径才拼到 repoRoot 下——否则 ~/rules 会被拼成 <repoRoot>/~/rules 埋在路径中间
      const expanded = expandHome(t.srcDir, home)
      return { ...t, srcDir: isAbsolute(expanded) ? expanded : join(root, expanded) }
    })
  }
  if (isPlainObject(cfg.skills)) {
    cfg.skills = Object.fromEntries(
      Object.entries(cfg.skills).map(([n, e]) => {
        if (!isPlainObject(e)) return [n, e]
        // 只对「缺省/空」补 repoRoot；非字符串类型（手改笔误）抛错，别静默重定向到仓库根
        if (e.localPath === undefined || e.localPath === null || (typeof e.localPath === 'string' && e.localPath.trim() === '')) {
          return [n, { ...e, localPath: root }]
        }
        if (typeof e.localPath !== 'string') throw new Error(`skills.${n}.localPath 应为字符串`)
        // 与 srcDir 同规则：相对 localPath 也解析到 repoRoot 下（否则下游 catalog 会 resolve 到 cwd）
        const lp = expandHome(e.localPath, home)
        return [n, { ...e, localPath: isAbsolute(lp) ? lp : join(root, lp) }]
      }),
    )
  }
  return cfg
}

/**
 * 校验每个 target 的「最终生效 srcDir」已是绝对路径（骨架的相对 srcDir 只有 repoRoot 配了才会被
 * derivePaths 解析；但环境变量 srcDir 优先级更高、可能单独提供绝对路径）。共享给 buildTargets /
 * add 的 linkWantNames / import——三处都消费 srcDir，缺 repoRoot 且无 env 时若各自 resolve 到 cwd
 * 会静默指向错误目录（add 会绕过链接形态撞名守卫、import 会把条目写进 <cwd>/rules）。
 * env 感知：env.srcDir 非空时按「环境变量 > 配置」校验（与各消费点的 pick 同规则），别误杀 env-only 用法。
 * filter：可选谓词，只校验满足条件的 target（调用方传「真正会消费 srcDir」的判定）——必须传原始
 * config.targets 数组，这样报错里的 targets[i] 索引才是真实位置。
 * 只在「真正要用 srcDir」的命令里调，`aas editors` 不看 srcDir，不受影响。
 */
export function requireAbsoluteSrcDir(targets, { home = homedir(), env = {}, filter = null } = {}) {
  for (const [i, t] of (targets ?? []).entries()) {
    if (!t || typeof t !== 'object') continue
    if (filter && !filter(t)) continue
    const effective = pickEnvField(t, 'srcDir', env)
    if (typeof effective !== 'string' || effective.trim() === '') continue
    if (!isAbsolute(expandHome(effective, home))) {
      throw new Error(`targets[${i}]（${t.label ?? '无标签'}）的 srcDir 是相对路径（${effective}）——需要 repoRoot（或环境变量）才能解析。\n  下一步：aas config init 或 aas config set repoRoot <路径>`)
    }
  }
}

/** env 感知取出 target 的 dst/srcDir；非对象 / 缺 dstName {name} / 空白 srcDir → null（守卫过滤与消费循环共用同一前缀，防各自漂移） */
export function targetSrcFields(raw, env) {
  if (!raw || typeof raw !== 'object') return null
  const dst = pickEnvField(raw, 'dstDir', env)
  const srcDir = pickEnvField(raw, 'srcDir', env)
  if (!dst || typeof srcDir !== 'string' || srcDir.trim() === '' || typeof raw.dstName !== 'string' || !raw.dstName.includes('{name}')) return null
  return { dst, srcDir }
}

/** 分层解析一体：合并 → 推导 → 归一。所有命令的统一配置入口 */
export function resolveConfig({ base, user = {}, home = homedir() } = {}) {
  // user 可能被外部调用方传非对象：容忍（与 mergeConfigs 的 user ?? base 一致），别裸抛 TypeError
  const { schemaVersion: _userSchema, ...userRest } = isPlainObject(user) ? user : {}
  // 用户配置的 schemaVersion 属「用户配置文件自身的版本」（validateUserConfigShape 已单独校验），
  // 与骨架的 schemaVersion 是两个命名空间——合并时剥掉，避免用户版本号覆盖骨架版本号后被
  // normalizeConfig 误判成「整个配置版本不支持」（实测隐患：user 升到 2、骨架仍是 1 会全盘拒绝）
  return normalizeConfig(derivePaths(mergeConfigs(base, userRest), { home }))
}
