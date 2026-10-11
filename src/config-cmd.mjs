/**
 * config-cmd.mjs —— aas config get / set / init 的实现（设计见 docs/design.md「配置分层」）。
 *
 * 交互设计：
 *   get   非交互 = 打印全部字段（带中文解释）；交互 = 打印后进入「选字段 → 就地改」循环
 *   set   <键> [值]：给值直接写；不给值且交互 → 目录走文件夹选择器、编辑器走单选列表
 *   init  按 repoRoot → editor 顺序逐个设置；已设置的显示当前值并问是否要改
 *
 * 交互控件：@inquirer/prompts（select / confirm / input）+ Windows 文件夹选择器（PowerShell
 * FolderBrowserDialog，仅 win32 + 交互终端；其余情况退回 input 粘贴 / 报错指路显式传值）。
 * get 与 init 的「交互设置字段」共用 setFieldInteractive，三处命令不会各自漂移。
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  loadUserConfig, userConfigPath,
  USER_FIELDS, USER_CONFIG_SCHEMA_VERSION, getFieldDef, setUserValue,
} from './user-config.mjs'
import { expandHome, resolveConfig, loadConfig, DEFAULT_CONFIG_PATH } from './config.mjs'

// ─────────────────────────────────────────────
// 字段展示（get / init 共用）
// ─────────────────────────────────────────────

/** 当前用户配置的字段行（带中文解释 + 当前值）。user 可传入已读好的对象，避免重复读文件 */
export function describeUserConfig({ home = homedir(), user = null } = {}) {
  const u = user ?? loadUserConfig({ home })
  return USER_FIELDS.map((f) => {
    const v = f.kind === 'ro' ? (u[f.key] ?? USER_CONFIG_SCHEMA_VERSION) : (u[f.key] ?? '（未设置）')
    return `  ${f.key.padEnd(14)} ${String(v).padEnd(24)} ${f.desc}`
  })
}

// ─────────────────────────────────────────────
// 目录校验与文件夹选择器
// ─────────────────────────────────────────────

/**
 * 期望的源仓库子目录名——与骨架 sync.config.json 的 linkTargets[].srcDir 契约一致
 * （相对 srcDir 就是靠 repoRoot + 这些名字解析）。改动这里等于改动骨架契约，两边要一起改。
 */
const EXPECTED_SUBDIRS = ['rules', 'skills']

/**
 * 校验 repoRoot：目录必须存在；没看到期望的子目录时给 warning（不拦）。
 * 返回 { path, warning }。
 */
export function validateRepoRoot(raw, { home = homedir() } = {}) {
  // expandHome 对非字符串原样返回，直接 resolve 会裸抛 ERR_INVALID_ARG_TYPE——先显式守卫
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`目录路径应为非空字符串：${String(raw)}`)
  const p = resolve(expandHome(raw, home))
  // 单次 statSync 判存在+目录（分开 existsSync/statSync 存在 TOCTOU 窗口，路径消失时 statSync 会裸抛 ENOENT）
  let st = null
  try {
    st = statSync(p)
  } catch (e) {
    // 只有 ENOENT 才是「目录不存在」；EACCES/EPERM/ELOOP 等是「存在但访问不了」——别让用户去找一个其实存在的目录
    if (e.code !== 'ENOENT') throw new Error(`目录无法访问：${p}\n${e.message}`)
  }
  if (!st) throw new Error(`目录不存在：${p}`)
  if (!st.isDirectory()) throw new Error(`不是目录：${p}`)
  // 文案与检查一致：repoRoot 要同时喂 rules 和 skills 两个 linkTarget，缺任一就提示；子目录名不带反斜杠（跨平台）
  const missing = EXPECTED_SUBDIRS.filter((d) => !existsSync(join(p, d)))
  const warning = missing.length === 0 ? null : `这个目录下没看到 ${missing.join('、')}，确认是源仓库根吗？（应包含 ${EXPECTED_SUBDIRS.join('/ 与 ')}/ 两个子目录）`
  return { path: p, warning }
}

/** PowerShell 单引号字符串字面量（'' 转义单引号）。不用 JSON.stringify——JSON 转义 ≠ PS 转义（反斜杠会被加倍） */
function psSingleQuote(s) {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Windows 文件夹选择器：借 PowerShell 的 FolderBrowserDialog（系统原生对话框）。
 * 非 win32 / 对话框打不开 / 用户取消 → 返回 null（调用方退回 input 或报错）。
 */
export function pickFolderDialog({ prompt = '请选择源仓库根目录' } = {}) {
  if (process.platform !== 'win32') return null
  const script = [
    '$ErrorActionPreference = "Stop"',
    // 强制 UTF-8（不带 BOM）输出：PowerShell 对管道按 OEM 码页（zh-CN 是 GBK）写，Node 按 UTF-8 读会乱码
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psSingleQuote(prompt)}`,
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
  ].join('; ')
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 120000,
    })
    if (r.status !== 0) return null
    const out = String(r.stdout || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    // 取最后一行：Write-Output 是脚本的最后一条语句，前面的杂讯（警告/横幅）不该被当成路径
    return out.length > 0 ? out[out.length - 1] : null
  } catch {
    return null
  }
}

/**
 * repoRoot 设置器：仅交互环境弹文件夹选择器（非交互弹阻塞对话框会卡 120s 超时），
 * 选完校验 → 返回 { path, warning }；非交互 → 报错指路显式传值。
 */
async function askRepoRoot({ home, isTTY }) {
  if (!isTTY) {
    throw new Error('交互环境才能弹目录选择器；非交互请直接给路径：aas config set repoRoot <路径>')
  }
  const picked = pickFolderDialog({ prompt: '请选择源仓库根目录（rules\\ 和 skills\\ 的上一级）' })
  if (picked) return validateRepoRoot(picked, { home })
  const { input } = await import('@inquirer/prompts')
  const typed = await input({ message: '源仓库根目录（可直接粘贴路径）：' })
  if (typeof typed !== 'string' || typed.trim() === '') throw new Error('没有给出路径')
  return validateRepoRoot(typed.trim(), { home })
}

// ─────────────────────────────────────────────
// 编辑器预设
// ─────────────────────────────────────────────

/**
 * 可用编辑器预设名。
 * 骨架的读取与结构校验都在 try 外 —— 骨架坏了就直接抛（回退救不了它，同一份配置再读还是同样错）。
 * 只有「用户配置读不了」才回退到只看骨架并警告（config set editor 是修复路径，不能被坏配置卡死）。
 */
export function editorChoices({ home = homedir(), baseConfigPath = null, warn = console.error } = {}) {
  const base = loadConfig(baseConfigPath ?? DEFAULT_CONFIG_PATH)
  const skeleton = resolveConfig({ base, user: {}, home }) // 骨架结构不对 → 直接抛，不进 catch
  let user = null // null = 用户配置读不了（loadUserConfig 要么返回对象、要么抛）
  try {
    user = loadUserConfig({ home })
  } catch (e) {
    warn(`⚠ 用户配置无法载入（${e.message}）；编辑器列表仅来自骨架`)
  }
  let cfg = skeleton
  try {
    cfg = resolveConfig({ base, user, home })
  } catch (e) {
    // 用户配置能读但推导不过（如 repoRoot 是相对路径）——同样降级，别把修复路径卡死
    warn(`⚠ 用户配置无法生效（${e.message}）；编辑器列表仅来自骨架`)
  }
  return Object.keys(cfg.editors ?? {})
}

function assertEditorKnown(value, { home, baseConfigPath }) {
  const choices = editorChoices({ home, baseConfigPath })
  if (!choices.includes(value)) {
    throw new Error(`编辑器预设里没有 "${value}"；可选：${choices.join('、') || '（配置里没有任何编辑器）'}`)
  }
}

/** editor 设置器：单选列表（只列可用预设） */
async function askEditor({ home, isTTY, baseConfigPath = null }) {
  if (!isTTY) throw new Error('交互环境才能弹单选列表；非交互请直接给：aas config set editor <名>')
  const choices = editorChoices({ home, baseConfigPath })
  if (choices.length === 0) throw new Error('配置里没有可用编辑器预设')
  const { select } = await import('@inquirer/prompts')
  return select({ message: '选择编辑器预设', choices: choices.map((c) => ({ name: c, value: c })) })
}

// ─────────────────────────────────────────────
// 命令实现
// ─────────────────────────────────────────────

function writableUserLine({ home = homedir() } = {}) {
  return `  已写入：${userConfigPath({ home })}`
}

/**
 * 宽容读用户配置：坏配置（未知键 / 损坏 / 形状非法）不该挡住 get/init 这个「查看与修复」入口。
 * 读失败 → 警告 + 当成空配置继续；写路径（setUserValue）另有清理逻辑兜底。
 */
function readUserConfigTolerant({ home, warn = console.error }) {
  try {
    return loadUserConfig({ home })
  } catch (e) {
    warn(`⚠ 用户配置无法载入（${e.message}）；按「未设置」显示，可用 aas config set 修复`)
    return {}
  }
}

/** 打印用户配置表（get 与 init 的非交互分支共用，改格式只改这一处） */
function printUserConfig({ home, print, warn }) {
  print(`== aas 用户配置（${userConfigPath({ home })}）==`)
  for (const line of describeUserConfig({ home, user: readUserConfigTolerant({ home, warn }) })) print(line)
}

/** 可写字段键（过滤只读）——get 选择 / set 未知键提示 / init 遍历共用，加字段只改 USER_FIELDS 一处 */
function writableKeys() {
  return USER_FIELDS.filter((f) => f.kind !== 'ro').map((f) => f.key)
}

/** 写配置并打印「· key = value」+ 已写入行（set 与 setFieldInteractive 共用，防格式漂移） */
function persistField(def, value, { home, warning = null, print }) {
  setUserValue(def.key, value, { home })
  print(`· ${def.key} = ${value}${warning ? `  （${warning}）` : ''}`)
  print(writableUserLine({ home }))
}

/**
 * 交互设置一个字段（get / init 共用）：按 def.kind 分发——目录走选择器、编辑器走单选列表；
 * 写配置并打印。三处命令不各自复制这套「prompt → set → print」，防漂移。
 */
async function setFieldInteractive(def, { home, isTTY, baseConfigPath, print }) {
  let value, warning = null
  if (def.kind === 'dir') {
    const r = await askRepoRoot({ home, isTTY })
    value = r.path
    warning = r.warning
  } else if (def.kind === 'select') {
    value = await askEditor({ home, isTTY, baseConfigPath })
  } else {
    throw new Error(`字段 ${def.key} 的 kind=${def.kind} 没有对应的交互控件`)
  }
  persistField(def, value, { home, warning, print })
}

/** aas config get：非交互打印全部字段；交互打印后进入「选字段 → 就地改」循环 */
export async function runConfigGet({ home = homedir(), isTTY = false, print = console.log, warn = console.error, baseConfigPath = null } = {}) {
  printUserConfig({ home, print, warn })
  if (!isTTY) return

  for (;;) {
    const { select } = await import('@inquirer/prompts')
    const key = await select({
      message: '要修改哪个字段？',
      // 可写字段从 writableKeys 推导，加字段不用改这里
      choices: [
        ...writableKeys().map((k) => ({ name: k, value: k })),
        { name: '完成', value: '__done' },
      ],
    })
    if (key === '__done') {
      print('→ 完成。')
      return
    }
    await setFieldInteractive(getFieldDef(key), { home, isTTY: true, baseConfigPath, print })
    // 编辑后重打配置表，让屏幕上显示的与刚写入的一致
    printUserConfig({ home, print, warn })
  }
}

/** aas config set <键> [值]：给值直接写；不给值且交互 → 目录走选择器、编辑器走单选列表 */
export async function runConfigSet({ key, value, home = homedir(), isTTY = false, print = console.log, baseConfigPath = null } = {}) {
  if (typeof key !== 'string' || key === '') {
    throw new Error(`要给键：${writableKeys().join('、')}（aas config set <键> [值]）`)
  }
  const def = getFieldDef(key)
  if (!def) throw new Error(`未知配置键：${key}；可选：${writableKeys().join('、')}`)
  if (def.kind === 'ro') throw new Error(`"${key}" 是只读的，不用改`)

  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  if (!raw) {
    // 无值 → 走交互设置器（含非交互的「请直接给」报错与未知 kind 的显式报错），不在这里复制 kind 二分
    await setFieldInteractive(def, { home, isTTY, baseConfigPath, print })
    return
  }
  if (def.kind === 'dir') {
    const { path: p, warning } = validateRepoRoot(raw, { home })
    persistField(def, p, { home, warning, print })
  } else if (def.kind === 'select') {
    assertEditorKnown(raw, { home, baseConfigPath })
    persistField(def, raw, { home, print })
  } else {
    throw new Error(`字段 ${def.key} 的 kind=${def.kind} 没有对应的写入路径`)
  }
}

/** aas config init：按 repoRoot → editor 顺序逐个设置；已设置 → 显示当前值并问是否要改 */
export async function runConfigInit({ home = homedir(), isTTY = false, print = console.log, warn = console.error, baseConfigPath = null } = {}) {
  if (!isTTY) {
    // 先抛错（退出码=2）再读配置——非交互下「什么都没做但成功」会骗过脚本；命令马上要失败，配置也不用读
    throw new Error('初始化需要交互窗口；非交互请用：aas config set <键> <值>')
  }
  const user = readUserConfigTolerant({ home, warn }) // 坏配置不该挡住 init 这个修复入口

  print('== aas config init：按顺序设置 repoRoot → editor ==')
  for (const key of writableKeys()) {
    const def = getFieldDef(key)
    const current = user[key]
    if (typeof current === 'string' && current.trim() !== '') {
      const { confirm } = await import('@inquirer/prompts')
      const change = await confirm({ message: `${key} 当前是「${current}」。要改成别的吗？`, default: false })
      if (!change) {
        print(`· ${key} 保持原值：${current}`)
        continue
      }
    }
    await setFieldInteractive(def, { home, isTTY: true, baseConfigPath, print })
  }
  print('→ 初始化完成。跑 aas 体检看效果：aas')
}
