/**
 * user-config.mjs —— 用户配置 ~/.aas/config.json 的读写与分层入口。
 *
 * 分层（2026-10-10 起，见 docs/design.md「配置分层」）：
 *   骨架 sync.config.json 随包发布（零个人路径）；机器相关的值只有 repoRoot / editor，
 *   放在 ~/.aas/config.json（与账本 installed.json、缓存 repos/ 同处 ~/.aas 用户态目录）。
 *
 * 写入纪律：与账本一致 —— .bak 滚动 + 临时文件原子改名；读取容错：剥 BOM + schema 校验。
 * loadEffectiveConfig 是各命令的统一配置入口：合并 → 推导 → 归一。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  loadConfig, DEFAULT_CONFIG_PATH, resolveConfig, expandHome, parseJsonWithBom, validateOverrideSections,
} from './config.mjs'

export const USER_CONFIG_SCHEMA_VERSION = 1

/** 配置字段元数据（中文解释给 get / init 共用；kind: dir=目录选择器, select=单选列表, ro=只读） */
export const USER_FIELDS = [
  {
    key: 'repoRoot',
    kind: 'dir',
    desc: '源仓库根目录——你的规则存在它的 rules\\ 下、技能存在 skills\\ 下；换机器只需改这一个值',
  },
  {
    key: 'editor',
    kind: 'select',
    desc: '编辑器预设——aas 把规则/技能装进哪个编辑器的运行时目录（可选名见 aas editors）',
  },
  { key: 'schemaVersion', kind: 'ro', desc: '配置文件格式版本（正常不用动）' },
]

export function getFieldDef(key) {
  return USER_FIELDS.find((f) => f.key === key)
}

/** 用户配置路径。home 用选项对象（与本模块其它导出一致）：写成 userConfigPath({home}) 时静默拿到 <cwd>/.aas/config.json 是易踩的坑 */
export function userConfigPath({ home = homedir() } = {}) {
  return join(expandHome('~', home), '.aas', 'config.json')
}

/** 用户配置允许出现的键：schemaVersion/repoRoot/editor 之外，sources/skills/editors/linkTargets 是「预留扩展」的覆盖位 */
const ALLOWED_USER_KEYS = new Set(['schemaVersion', 'repoRoot', 'editor', 'sources', 'skills', 'editors', 'linkTargets'])

/** 读用户配置原始 JSON（剥 BOM + 解析 + 损坏报错指路 .bak）；文件不存在 → undefined（区别于解析出的 null）。load 与 set 共用 */
function readUserConfigFile(p) {
  if (!existsSync(p)) return undefined
  // 读与解析分开 try：I/O 失败（EACCES/EISDIR 等）不该被说成「损坏」并指向 .bak（与 loadConfig 同款）
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(`用户配置读取失败：${p}\n${e.message}`)
  }
  try {
    return parseJsonWithBom(text)
  } catch (e) {
    // .bak 只在「曾成功写过」时才有；手写/半截文件可能压根没有 .bak——给出第二条路
    throw new Error(`用户配置损坏：${p}\n${e.message}\n下一步：从备份恢复——复制 ${p}.bak 回去后重试；若没有 .bak，删除该文件后重跑 aas config set`)
  }
}

/** 形状校验：不合 → 抛错（含原因）。未知键拒绝——否则手改加的键会经 mergeConfigs 静默覆盖骨架 */
export function validateUserConfigShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('用户配置内容不是对象')
  for (const k of Object.keys(data)) {
    if (!ALLOWED_USER_KEYS.has(k)) throw new Error(`用户配置里有未知键：${k}（允许：${[...ALLOWED_USER_KEYS].join('、')}）`)
  }
  if (data.schemaVersion !== undefined && data.schemaVersion !== USER_CONFIG_SCHEMA_VERSION) {
    throw new Error(`用户配置 schemaVersion=${data.schemaVersion} 不受支持（支持 ${USER_CONFIG_SCHEMA_VERSION}）`)
  }
  for (const k of ['repoRoot', 'editor']) {
    // 空白串也算无效：下游 normalizeConfig/derivePaths 都按 trim() !== '' 判「未设置」，这里放行空白会静默失效
    if (data[k] !== undefined && (typeof data[k] !== 'string' || data[k].trim() === '')) {
      throw new Error(`用户配置字段 ${k} 应为非空字符串`)
    }
  }
  // 预留覆盖位与 normalizeConfig 共用同一份结构规则：只查「是对象」不够——
  // {"sources":{"x":123}} / {"skills":{"a":{}}} 能过这里却会被 normalizeConfig 拒绝，
  // 结果所有命令报错、而 config set 又清不掉它（违背「config set 就是修复路径」）
  try {
    validateOverrideSections(data)
  } catch (e) {
    throw new Error(`用户配置字段 ${e.message}`)
  }
}

/** 读用户配置。文件不存在 → {}（首次使用不是错误）；损坏 → 抛错并指路 .bak */
export function loadUserConfig({ home = homedir() } = {}) {
  const p = userConfigPath({ home })
  const data = readUserConfigFile(p)
  if (data === undefined) return {}
  try {
    validateUserConfigShape(data)
  } catch (e) {
    throw new Error(`用户配置不合法：${p}\n${e.message}\n修复：跑 aas config set repoRoot <路径>（会清掉未知键）或从备份恢复——复制 ${p}.bak 回去后重试`)
  }
  return data
}

/** 写用户配置：先滚动 .bak，再经临时文件原子改名落盘 */
export function writeUserConfig(data, { home = homedir() } = {}) {
  validateUserConfigShape(data)
  const p = userConfigPath({ home })
  mkdirSync(dirname(p), { recursive: true })
  if (existsSync(p)) copyFileSync(p, `${p}.bak`)
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, p)
  } catch (e) {
    // 失败路径清临时文件：Windows 上目标被别的进程占用时 rename 会 EPERM，
    // 不清就会在 ~/.aas 里堆 config.json.tmp-<pid>-<date>（且永远不会被回收）
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw e
  }
}

/**
 * 读入后合并并回写一个键。宽容读：未知键（手改笔误，如 repo_root）在这里清掉而不是抛错——
 * 否则它卡死所有命令，而 config set 自己都读不了文件，就没法修复了。config set 就是修复路径。
 */
export function setUserValue(key, value, { home = homedir() } = {}) {
  // 导出函数可能被任意键调用：防 __proto__ 等命中原型 setter（与 mergeConfigs 的防护对称）
  if (!ALLOWED_USER_KEYS.has(key)) throw new Error(`未知配置键：${key}`)
  let data
  try {
    data = readUserConfigFile(userConfigPath({ home }))
  } catch {
    // 损坏配置：宽容读（config set 就是修复路径，不能自己读不了文件）
    // writeUserConfig 会把原文件滚成 .bak，原始字节不丢，新值从这里开始覆盖
    data = {}
  }
  if (data === undefined || !data || typeof data !== 'object' || Array.isArray(data)) data = {}
  for (const k of Object.keys(data)) {
    if (k === key) continue // 要被覆盖的键交给 writeUserConfig 校验
    if (!ALLOWED_USER_KEYS.has(k)) { delete data[k]; continue }
    // 形状非法的已知键也清掉（如 repoRoot:""、skills:null），否则残留坏值让 writeUserConfig 抛错，config set 就修不了
    try { validateUserConfigShape({ [k]: data[k] }) } catch { delete data[k] }
  }
  // 版本总是归一：文件里是旧/未来版本（如手改 2）时，config set 也要能修复，别留着它让 write 再抛错
  data.schemaVersion = USER_CONFIG_SCHEMA_VERSION
  data[key] = value
  writeUserConfig(data, { home })
  return data
}

/**
 * 各命令的统一配置入口：骨架（或 --config 指定文件）+ 用户配置 → 合并 → repoRoot 推导 → 归一。
 * configPath 为 null/undefined 时用随包骨架。
 */
export function loadEffectiveConfig(configPath, { home = homedir() } = {}) {
  const base = loadConfig(configPath ?? DEFAULT_CONFIG_PATH)
  const user = loadUserConfig({ home })
  return resolveConfig({ base, user, home })
}
