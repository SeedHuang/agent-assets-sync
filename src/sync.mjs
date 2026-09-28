#!/usr/bin/env node
/**
 * sync.mjs —— 把源仓库里的「全局规则」和「技能」同步到编辑器的运行时目录。
 *
 * 配置驱动（见 docs/design.md）：源目录 / 目标目录 / 命名规则全写在 sync.config.json 里，
 * **换编辑器或换机器只改配置，不碰本文件**。
 *
 * 体系公理（见 retro-skills/docs/architecture.md §4）：
 *   运行时目录只读；唯一编辑点是源仓库；更新 = 改源 → 跑本脚本。
 *
 * 用法（在本项目根下跑）：
 *   node src/sync.mjs                    只体检（默认，绝不改动任何东西）
 *   node src/sync.mjs --apply            同步：只建"缺失的链接"，不删任何东西
 *   node src/sync.mjs --apply --replace  允许把"真实副本 / 指错的链接"换成链接（会删东西）
 *   node src/sync.mjs --apply --rm-old   允许清理残留：旧名文件 + 自家失效链接（会删东西）
 *   node src/sync.mjs list               列出配置里各源有哪些条目（只读）
 *   node src/sync.mjs --config <路径>    用别的配置文件（默认 本项目根的 sync.config.json）
 *   node --test test/sync.test.mjs       跑脚本自己的测试（临时目录里，不碰真实运行时）
 *
 * 安全默认：**只有"建缺失的链接"是默认动作**，一切会删东西的动作都要显式开口。
 *
 * 退出码：0 = 一致；1 = 有差异；2 = 出错
 *
 * 已实测的平台事实（2026-09-28）：
 *   - Trae CN 全局规则目录：~/.trae-cn/user_rules/
 *   - 规则文件名必须形如 rule-<名字>.md（纯 code-style.md 不会被加载）
 *   - 技能目录：~/.trae-cn/skills/<技能名>/（普通目录名即可）
 *   - 符号链接可用（开发者模式已开），且能跨盘
 *
 * 两个 Windows 上的坑，本脚本已绕开：
 *   1. Node 的 lstat 对 junction 报 isSymbolicLink()=false（会误判成普通目录）
 *      → 一律用 readlinkSync 能否成功来判断"是不是链接"
 *   2. 删除链接时若用 rmSync({recursive:true}) 有进到目标里的风险
 *      → 统一走 removeLinkOrCopy()：链接用 rmdir/unlink 只摘链本身
 */

import {
  readdirSync, lstatSync, symlinkSync, unlinkSync, rmdirSync, rmSync,
  readFileSync, existsSync, mkdirSync, readlinkSync, realpathSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './config.mjs'
import { readLedger, runtimePathsIndex, reclassifyWithLedger, defaultLedgerPath } from './ledger.mjs'

const HOME = homedir()
/** 默认配置文件：本项目根下的 sync.config.json（src/ 的上一级） */
const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sync.config.json')

/**
 * 是否"被直接执行"（而不是被 import 进来）。
 *
 * 用 realpath 归一后再比：本项目将来若以 junction / 符号链接形式被安装、并从安装目录启动，
 * "入口路径"与"模块真实路径"字符串不同 —— 直接比字符串会误判成"被 import 了"，
 * 整个 CLI 会**静默不执行**（一个字都不打印，退出码还是 0）。
 * 同款缺陷 2026-09-28 已在 managing-lessons-store 的 lessons.mjs 上真实踩过并修复
 * （两仓各留一份、互不依赖，不为此建跨仓库公共库）。
 */
export function isDirectRun(entry, moduleUrl) {
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// 配置：从 sync.config.json 读「源 → 运行时目标」映射
//
// 每条 target 的形状：
//   label    给人看的名字
//   srcDir   源目录（可写 ~）
//   dstDir   运行时目标目录（可写 ~）
//   dstName  目标文件名模板，必须含 {name}（源里的文件名会替换进去）
//            规则侧用 "rule-{name}"（已实测：这个形状才会被 Trae 加载）
//   level    "file"（对文件建符号链接）| "dir"（对目录建 junction）
//   env      可选：把「环境变量名」绑到 srcDir / dstDir 上，
//            用于「换机器 / 仓库搬家」时不必改配置，例如
//            { "srcDir": "MY_RULES_SRC", "dstDir": "TRAE_RULES_DST" }
// ─────────────────────────────────────────────────────────────

/** 展开开头的 ~（兼容 ~/ 与 ~\） */
export function expandHome(p, home = HOME) {
  if (typeof p !== 'string') return p
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/** 读配置文件；顺手剥掉 BOM（PowerShell 写文件容易带，会让 JSON.parse 报错） */
export function loadConfig(configPath) {
  const p = resolve(configPath)
  if (!existsSync(p)) throw new Error(`配置文件不存在：${p}`)
  const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${p}\n${e.message}`)
  }
}

/** 把配置 + 环境变量 变成脚本内部用的 TARGETS（dstName 函数 / dirLevel 布尔） */
export function buildTargets(config, { env = {}, home = HOME } = {}) {
  const list = config?.targets
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('配置里没有 targets（应为非空数组）')
  }
  return list.map((raw, i) => {
    const at = `targets[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} 不是对象`)
    const label = raw.label ?? at
    const envMap = raw.env ?? {}
    const pick = (key) => {
      const name = envMap[key]
      return typeof name === 'string' && typeof env[name] === 'string' && env[name].trim() !== ''
        ? env[name]
        : undefined
    }
    const srcDir = pick('srcDir') ?? raw.srcDir
    const dstDir = pick('dstDir') ?? raw.dstDir
    if (typeof srcDir !== 'string' || srcDir.trim() === '') throw new Error(`${at}（${label}）缺 srcDir`)
    if (typeof dstDir !== 'string' || dstDir.trim() === '') throw new Error(`${at}（${label}）缺 dstDir`)
    if (typeof raw.dstName !== 'string' || !raw.dstName.includes('{name}')) {
      throw new Error(`${at}（${label}）的 dstName 必须是含 {name} 的字符串`)
    }
    if (raw.level !== 'file' && raw.level !== 'dir') {
      throw new Error(`${at}（${label}）的 level 必须是 "file" 或 "dir"`)
    }
    const template = raw.dstName
    return {
      label,
      srcDir: resolve(expandHome(srcDir, home)),
      dstDir: resolve(expandHome(dstDir, home)),
      dstName: (srcName) => template.split('{name}').join(srcName),
      dirLevel: raw.level === 'dir',
    }
  })
}

// ─────────────────────────────────────────────────────────────
// CLI 参数解析（纯函数，便于直测）
// ─────────────────────────────────────────────────────────────

/**
 * 解析 argv。返回：
 *   command   'sync'（默认）| 'list'
 *   help      是否 --help / -h
 *   apply / replace / rmOld   三个会改东西的开关
 *   configPath --config 指定的配置路径（null = 用默认）
 *   error     参数本身有问题时的报错文案
 * 未知选项一律忽略（保持旧行为，不因多余参数而中断）。
 */
export function parseArgs(argv = []) {
  const out = { command: 'sync', help: false, apply: false, replace: false, rmOld: false, configPath: null, error: null }
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--apply') out.apply = true
    else if (a === '--replace') out.replace = true
    else if (a === '--rm-old') out.rmOld = true
    else if (a === '--config') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) {
        out.error = '参数 --config 后面要跟一个配置文件路径'
        return out
      }
      out.configPath = v
      i++
    } else if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length)
      if (v === '') {
        out.error = '参数 --config= 后面要跟一个配置文件路径'
        return out
      }
      out.configPath = v
    } else if (a.startsWith('-')) {
      // 未知选项：忽略
    } else {
      positionals.push(a)
    }
  }
  if (positionals[0] === 'list') out.command = 'list'
  return out
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/** 是不是链接？用 readlinkSync 能否成功判断（junction 与 symlink 都覆盖） */
function linkTarget(p) {
  try {
    return readlinkSync(p)
  } catch {
    return null
  }
}

/** 存在吗？用 lstat（这样"断链"也能被认出来，existsSync 对断链返回 false） */
function lexists(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
}

/** 目录指纹：不进链接内部遍历（避免跑到目标里去，也避免断链报错） */
function sha256Dir(dir) {
  const h = createHash('sha256')
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const lt = linkTarget(p)
      if (lt) {
        h.update(`${rel}/${name}:link:${lt}`)
      } else if (lstatSync(p).isDirectory()) {
        walk(p, join(rel, name))
      } else {
        h.update(`${rel}/${name}:`).update(readFileSync(p))
      }
    }
  }
  walk(dir, '')
  return h.digest('hex').slice(0, 12)
}

/** 统一指纹：链接用"指向"当指纹；文件/目录用内容 */
function fingerprint(p) {
  const lt = linkTarget(p)
  if (lt) return `link:${lt}`
  return lstatSync(p).isDirectory() ? `dir:${sha256Dir(p)}` : `file:${sha256File(p)}`
}

/** 只摘链接本身，绝不进目标里删东西 */
function removeLinkOrCopy(p) {
  const lt = linkTarget(p)
  if (lt) {
    try { rmdirSync(p) } catch { unlinkSync(p) } // junction → rmdir；symlink → unlink
    return
  }
  const st = lstatSync(p)
  if (st.isDirectory()) rmSync(p, { recursive: true, force: true })
  else unlinkSync(p)
}

// ─────────────────────────────────────────────────────────────
// 体检：算出「计划」与「问题」，绝不改动任何东西
// ─────────────────────────────────────────────────────────────
function inspect(t) {
  if (!existsSync(t.srcDir)) {
    throw new Error(`源目录不存在：${t.srcDir}（改 sync.config.json 里这条的 srcDir，或用环境变量覆盖）`)
  }

  const srcNames = readdirSync(t.srcDir).filter((n) => !n.startsWith('.'))
  const want = new Map() // 运行时文件名 → { srcName, srcFull, srcFp }
  for (const srcName of srcNames) {
    const srcFull = join(t.srcDir, srcName)
    want.set(t.dstName(srcName), { srcName, srcFull, srcFp: fingerprint(srcFull) })
  }

  const present = existsSync(t.dstDir)
    ? readdirSync(t.dstDir).filter((n) => !n.startsWith('.'))
    : []

  const ok = [], needLink = [], wrong = [], legacy = [], staleSelf = [], orphans = []
  const managed = new Set(want.keys())

  for (const [dstName, info] of want) {
    const dstFull = join(t.dstDir, dstName)
    if (!lexists(dstFull)) {
      needLink.push({ dstName, info, why: '缺失' })
      continue
    }
    const lt = linkTarget(dstFull)
    if (!lt) {
      const same = fingerprint(dstFull) === info.srcFp
      wrong.push({ dstName, info, why: same ? '真实副本（内容一致，其实是复制不是链接）' : '真实副本（内容已过时）' })
      continue
    }
    if (!existsSync(dstFull)) {
      needLink.push({ dstName, info, why: '链接已断（目标不存在）' })
      continue
    }
    if (resolve(lt) !== resolve(info.srcFull)) {
      wrong.push({ dstName, info, why: `链接指向别处：${lt}` })
      continue
    }
    ok.push({ dstName, info })
  }

  // 运行时里「不在计划内」的条目：只分类，绝不动手
  for (const name of present) {
    if (managed.has(name)) continue
    const full = join(t.dstDir, name)
    const lt = linkTarget(full)

    // 是不是"我们自己留下的"？—— 链接指向 srcDir 里的某个（而现在源里已无此文件的）路径
    if (lt && resolve(lt) !== resolve(t.srcDir) && dirname(resolve(lt)).startsWith(resolve(t.srcDir))) {
      staleSelf.push({ name, full, target: lt })
      continue
    }

    let fp = null
    try { fp = fingerprint(full) } catch { /* 断链等，忽略 */ }
    const matched = [...want.values()].find((v) => v.srcFp === fp && fp && !fp.startsWith('link:'))
    if (matched) legacy.push({ name, full, dstName: t.dstName(matched.srcName) })
    else orphans.push({ name, isLink: !!lt })
  }

  return { t, ok, needLink, wrong, legacy, staleSelf, orphans }
}

// ─────────────────────────────────────────────────────────────
// 执行：建链接 → （可选）替换 → （可选）清理 → 校验
//
// 安全默认：**只有"建缺失的链接"是默认动作**。
//   - 替换真实副本/指错的链接（会删东西）→ 必须 opts.replace
//   - 清理旧名残留 / 自家残留链接（也会删东西）→ 必须 opts.rmOld
// ─────────────────────────────────────────────────────────────
function applyOne(r, opts = {}) {
  const { t } = r
  if (!existsSync(t.dstDir)) mkdirSync(t.dstDir, { recursive: true })
  const log = []
  const linkType = t.dirLevel ? 'junction' : 'file'

  // 1) 缺失的链接：安全动作，默认就做
  for (const item of r.needLink) {
    const dstFull = join(t.dstDir, item.dstName)
    if (lexists(dstFull)) removeLinkOrCopy(dstFull)
    symlinkSync(item.info.srcFull, dstFull, linkType)
    log.push(`建链接  ${item.dstName}`)
  }

  // 2) 替换"真实副本 / 指错的链接"——会删东西，必须显式 --replace
  if (r.wrong.length) {
    if (!opts.replace) {
      log.push(`跳过需替换的 ${r.wrong.length} 项（会删东西，加 --replace 才做）：${r.wrong.map((x) => x.dstName).join('、')}`)
    } else {
      for (const item of r.wrong) {
        const dstFull = join(t.dstDir, item.dstName)
        if (lexists(dstFull)) removeLinkOrCopy(dstFull)
        symlinkSync(item.info.srcFull, dstFull, linkType)
        log.push(`替换    ${item.dstName}  （原内容已删）`)
      }
    }
  }

  // 3) 清理残留——也会删东西，必须显式 --rm-old
  const junk = [
    ...r.legacy.map((x) => ({ name: x.name, full: x.full, why: '旧名，内容已由新名承载' })),
    ...r.staleSelf.map((x) => ({ name: x.name, full: x.full, why: '自家残留链接（源里已无此文件）' })),
  ]
  if (junk.length) {
    if (!opts.rmOld) {
      log.push(`保留残留 ${junk.length} 项（会删东西，加 --rm-old 才清）：${junk.map((x) => x.name).join('、')}`)
    } else {
      for (const x of junk) {
        removeLinkOrCopy(x.full)
        log.push(`清理    ${x.name}  （${x.why}）`)
      }
    }
  }

  // 4) 校验刚建的链接读得到
  for (const item of [...r.needLink, ...(opts.replace ? r.wrong : [])]) {
    const dstFull = join(t.dstDir, item.dstName)
    if (!existsSync(dstFull)) throw new Error(`建完链接后仍读不到：${dstFull}`)
  }
  return log
}

// ─────────────────────────────────────────────────────────────
// 主流程（只有"直接执行"时才跑；被 import 时不跑，方便测试）
// ─────────────────────────────────────────────────────────────

const USAGE = `用法（在本项目根下跑）：
  node src/sync.mjs                    只体检（默认，绝不改动任何东西）
  node src/sync.mjs --apply            同步：只建"缺失的链接"，不删任何东西
  node src/sync.mjs --apply --replace  允许把"真实副本 / 指错的链接"换成链接（会删东西）
  node src/sync.mjs --apply --rm-old   允许清理残留：旧名文件 + 自家失效链接（会删东西）
  node src/sync.mjs list               列出配置里各源有哪些条目（只读）
  node src/sync.mjs --config <路径>    用别的配置文件（默认 本项目根的 sync.config.json）
  node --test test/sync.test.mjs       跑脚本自己的测试（临时目录里，不碰真实运行时）

配置：源 / 目标 / 命名规则见 sync.config.json；其中 env 字段可把环境变量绑到路径上
      （如 MY_RULES_SRC / RETRO_SKILLS_DIR / TRAE_RULES_DST / TRAE_SKILLS_DST），换机器时不必改配置`

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args.error) {
    console.error(args.error + '\n')
    console.log(USAGE)
    return 2
  }

  const configPath = args.configPath ?? DEFAULT_CONFIG_PATH
  let targets
  let ledgerPaths = new Set()
  let ledgerWarn = null
  try {
    const cfg = normalizeConfig(loadConfig(configPath))
    targets = cfg.targets.length > 0 ? buildTargets({ targets: cfg.targets }, { env: process.env }) : []
  } catch (e) {
    console.error(`配置载入失败：${e.message}`)
    return 2
  }
  try {
    ledgerPaths = runtimePathsIndex(readLedger(defaultLedgerPath()))
  } catch (e) {
    // 账本读不了 → aas 条目按普通分类处理（不拦截），但不能崩
    ledgerWarn = String(e.message).split('\n')[0]
  }

  if (args.command === 'list') {
    for (const t of targets) {
      console.log(`\n[${t.label}]  ${t.dstDir}`)
      console.log(`  源：${t.srcDir}`)
      if (!existsSync(t.srcDir)) { console.log('  ✗ 源目录不存在'); continue }
      for (const n of readdirSync(t.srcDir).filter((x) => !x.startsWith('.'))) {
        console.log(`  ${t.dstName(n)}`)
      }
    }
    console.log('')
    return 0
  }

  console.log(`\n${args.apply ? '== 执行同步（--apply）==' : '== 体检（只读，不改动任何东西）=='}`)
  console.log(`配置：${resolve(configPath)}\n`)
  if (ledgerWarn) console.log(`⚠ 账本不可读，aas 条目按普通分类处理：${ledgerWarn}\n`)

  let hasIssue = false
  let failed = false

  for (const t of targets) {
    let r
    try {
      r = inspect(t)
      reclassifyWithLedger(r, t, ledgerPaths) // 账本优先：aas 条目从六类中移出，防误删（设计稿 §6）
    } catch (e) {
      console.log(`── [${t.label}] 体检失败：${e.message}\n`)
      failed = true
      continue
    }

    console.log(`── [${t.label}]`)
    console.log(`   源：${t.srcDir}`)
    console.log(`   目标：${t.dstDir}`)
    console.log(
      `   已就位 ${r.ok.length} ｜ 需建链接 ${r.needLink.length} ｜ 需替换 ${r.wrong.length} ｜ 待迁移旧名 ${r.legacy.length} ｜ 自家残留 ${r.staleSelf.length} ｜ 孤儿(不动) ${r.orphans.length}`,
    )
    if (r.aasInstall?.length) console.log(`   aas 安装 ${r.aasInstall.length}`)
    for (const x of r.ok) console.log(`   ✓ ${x.dstName}`)
    for (const x of r.needLink) console.log(`   ＋ ${x.dstName}   (${x.why})`)
    for (const x of r.wrong) console.log(`   ⚠ ${x.dstName}   (${x.why})`)
    for (const x of r.legacy) console.log(`   ↻ ${x.name}  →  将由 ${x.dstName} 替代`)
    for (const x of r.staleSelf) console.log(`   ⌫ 自家残留（源里已无此文件，加 --rm-old 清理）：${x.name}`)
    for (const x of r.orphans) console.log(`   ？ 孤儿（不属于本脚本管理，不动）：${x.name}${x.isLink ? ' [链接]' : ''}`)
    for (const x of r.aasInstall ?? []) console.log(`   a ${x.name}  （aas 安装，按账本豁免${x.via ? `；原分类：${x.via}` : ''}）`)

    if (r.needLink.length || r.wrong.length || r.legacy.length || r.staleSelf.length) hasIssue = true

    if (args.apply && hasIssue) {
      try {
        for (const line of applyOne(r, args)) console.log(`   · ${line}`)
      } catch (e) {
        console.log(`   ✗ 同步失败：${e.message}`)
        failed = true
      }
    }
    console.log('')
  }

  if (failed) {
    console.log('→ 出错了，请看上面的 ✗。\n')
    return 2
  }
  if (args.apply) {
    console.log('→ 同步完成。请再跑一次体检确认：node src/sync.mjs\n')
    return 0
  }
  console.log(hasIssue ? '→ 有差异。确认无误后执行：node src/sync.mjs --apply\n' : '→ 全部一致，无需同步。\n')
  return hasIssue ? 1 : 0
}

const isMain = isDirectRun(process.argv[1], import.meta.url)
if (isMain) process.exit(main())

export {
  DEFAULT_CONFIG_PATH,
  linkTarget, lexists, sha256File, sha256Dir, fingerprint, removeLinkOrCopy,
  inspect, applyOne, main,
}
