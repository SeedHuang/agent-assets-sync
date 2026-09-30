/**
 * add.mjs —— aas add 的实现（设计稿 §5 add 行 / §4 账本）。
 *
 * 流程：解析源 → clone/copy 进缓存 → 列资产 → 挑选（TTY 多选标注已装；非 TTY 必须给名）
 *      → 逐条撞名检查 → 先记账(installing) → 写运行时(链接/复制) → 改记账(installed)。
 *
 * 交互总闸（设计稿 §7）：一切问询前先判 isTTY；非 TTY 缺必需输入 → 报错；
 * 非 TTY 撞已存在条目 → 默认跳过（覆盖必须显式 --yes）；链接形态撞名 → 一律拒绝。
 */
import {
  existsSync, readdirSync, mkdirSync, rmSync, copyFileSync,
  symlinkSync, cpSync, statSync, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { loadConfig, expandHome, removeLinkOrCopy, lexists, DEFAULT_CONFIG_PATH } from './sync.mjs'
import { normalizeConfig } from './config.mjs'
import { readLedger, writeLedger, findEntry, defaultLedgerPath } from './ledger.mjs'
import { pickEditor, resolveRuntimeName, resolveEditorDir, editorLevel } from './editors.mjs'

// ─────────────────────────────────────────────
// 源解析与缓存
// ─────────────────────────────────────────────

/** 解析 <源>：URL / GitHub 短写(owner/repo) / sources 短名 / 本地路径（支持 仓库#分支、剥 .git 后缀） */
export function parseSource(spec, config, { exists = existsSync } = {}) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('源不能为空')
  let s = spec.trim()
  if (!s.includes('://') && !/^[A-Za-z]:[\\/]/.test(s) && config.sources?.[s]) {
    s = config.sources[s]
  }
  let ref = null
  const hash = s.lastIndexOf('#')
  if (hash !== -1 && !exists?.(s)) { ref = s.slice(hash + 1); s = s.slice(0, hash) }
  if (s.endsWith('.git') && !exists?.(s)) s = s.slice(0, -4)
  // GitHub 短写：owner/repo（无协议、非盘符路径、本地不存在）→ https://github.com/owner/repo
  if (!s.includes('://') && !/^[A-Za-z]:[\\/]/.test(s) && !exists?.(s) && /^[\w.-]+\/[\w.-]+$/.test(s)) {
    s = `https://github.com/${s}`
  }
  // 非 URL 一律当本地路径（相对 / POSIX / UNC / 盘符都认），存在性在这里统一判定——
  // 报错话术说「不是存在的本地路径」，就必须真的检查过存在性，而不是只认盘符开头
  if (!s.includes('://') && !exists?.(s)) {
    throw new Error(`无法识别源：${spec}（不是 URL、不在配置 sources 里、也不是存在的本地路径）`)
  }
  const isLocal = exists?.(s) === true
  return { url: s, ref, isLocal }
}

/** 缓存根目录（~/.aas/repos）。remove --purge / update 反查缓存必须用同一个函数，别再各自硬编码 */
export function reposDirFor(home = homedir()) {
  return join(expandHome('~', home), '.aas', 'repos')
}

/**
 * 缓存键：同一「来源+分支」稳定（remove --purge / update 也用它反查，三处必须一致）。
 *   本地源：绝对路径 + 短哈希 —— 不同目录的同名文件夹不能共用缓存（会装错资产）
 *   远端源：带 ref —— 同仓不同分支共用一份缓存，add 会装错分支、update 分组间会互相覆盖
 */
export function cacheKeyForSource(url, isLocal, ref = null) {
  if (isLocal) {
    const abs = resolve(url)
    const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8)
    return `local-${basename(abs).replace(/[^\w.-]+/g, '_')}-${hash}`
  }
  const u = new URL(url)
  const segs = u.pathname.split('/').filter(Boolean).map((x) => x.replace(/[^\w.-]+/g, '_'))
  const base = [u.hostname.replace(/[^\w.-]+/g, '_'), ...segs].filter(Boolean).join('/')
  if (!ref || ref === 'HEAD') return base
  return `${base}@${ref.replace(/[^\w.-]+/g, '_')}`
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const tail = String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(' | ')
    throw new Error(`git 失败（${args.join(' ')}）：${tail}\n下一步：检查 URL 是否正确、网络是否可达、私有仓库凭证是否已配`)
  }
}

/**
 * 拉进缓存：git 仓库 → clone --depth 1（temp/ 完成后原子改名进 repos/，杜绝半截仓库）；
 * 普通目录 → 递归拷贝。已存在 → 直接复用。返回 { cacheDir, commit }。
 */
export function cloneToCache({ url, ref, isLocal }, { home = homedir(), aasDir = null, exec = runGit } = {}) {
  const root = aasDir ?? expandHome('~', home)
  const key = cacheKeyForSource(url, isLocal, ref ?? null)
  const cacheDir = join(root, 'repos', key)
  if (existsSync(cacheDir)) {
    let commit = null
    try { commit = exec(['rev-parse', 'HEAD'], cacheDir) } catch { /* 非 git 缓存，无 commit */ }
    return { cacheDir, commit, reused: true }
  }
  const tmp = join(root, 'temp', `${key}-${Date.now()}`)
  mkdirSync(dirname(tmp), { recursive: true })
  if (isLocal && !existsSync(join(resolve(url), '.git'))) {
    cpSync(resolve(url), tmp, { recursive: true })
  } else {
    const args = ['clone', '--depth', '1']
    if (ref) args.push('--branch', ref)
    args.push(url, tmp)
    exec(args)
  }
  let commit = null
  try { commit = exec(['rev-parse', 'HEAD'], tmp) } catch { /* 非 git */ }
  mkdirSync(dirname(cacheDir), { recursive: true })
  renameSafe(tmp, cacheDir)
  rmSync(join(root, 'temp'), { recursive: true, force: true })
  return { cacheDir, commit, reused: false }
}

function renameSafe(from, to) {
  try {
    rmSync(to, { recursive: true, force: true })
  } catch { /* 目标不存在 */ }
  renameSync(from, to)
}

// ─────────────────────────────────────────────
// 资产清单
// ─────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** 列出缓存里的资产：含 SKILL.md 的目录 → 技能；其余 .md（README 除外）→ 规则 */
export function listAssets(root) {
  const assets = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (!st.isDirectory()) continue
      if (existsSync(join(abs, 'SKILL.md'))) {
        assets.push({ id: name, kind: 'skill', originalName: name, path: relative(root, abs), abs })
        continue // 技能目录整体是一个资产，不再深入
      }
      walk(abs)
    }
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || !name.toLowerCase().endsWith('.md')) continue
      if (/^readme(\.|$)/i.test(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) continue
      assets.push({ id: name.replace(/\.md$/i, ''), kind: 'rule', originalName: name, path: relative(root, abs), abs })
    }
  }
  walk(root)
  return assets
}

// ─────────────────────────────────────────────
// 安装
// ─────────────────────────────────────────────

function linkWantNames(config, dstDir, { home, env }) {
  // 链接形态的"想要名单"：所有落点与该运行时目录相同的 target 的目标名
  const want = new Set()
  for (const raw of config.targets ?? []) {
    const pick = (key) => {
      const name = raw.env?.[key]
      return typeof name === 'string' && typeof env?.[name] === 'string' && env[name].trim() !== '' ? env[name] : raw[key]
    }
    const dst = pick('dstDir')
    const srcDir = pick('srcDir')
    if (!dst || typeof srcDir !== 'string' || typeof raw.dstName !== 'string' || !raw.dstName.includes('{name}')) continue
    if (resolve(expandHome(dst, home)) !== resolve(dstDir)) continue
    // srcDir 与 dstDir 同样展开 ~ 并 resolve——否则 "~/x" 这类写法读不到目录、want 名单悄悄变空，
    // 链接形态撞名守卫就失效了
    for (const n of readdirSafe(resolve(expandHome(srcDir, home)))) {
      want.add(raw.dstName.split('{name}').join(n))
    }
  }
  return want
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

function resolveNames(names, assets, opts) {
  if (names.length === 0) return assets // 调用方已保证 TTY 多选路径
  const picked = []
  for (const n of names) {
    const hits = assets.filter((a) => a.id === n)
    if (hits.length === 0) {
      throw new Error(`源里没有叫 "${n}" 的资产；可选：${assets.map((a) => a.id).join('、') || '（缓存里没有任何资产）'}`)
    }
    if (hits.length > 1) {
      throw new Error(`"${n}" 对应多个资产（${hits.map((h) => h.path).join('、')}）；请先用更明确的源或 --as 指定`)
    }
    picked.push(hits[0])
  }
  if (opts.as && names.length === 1) picked[0] = { ...picked[0], id: opts.as }
  return picked
}

/**
 * 装一个资产。返回动作：'installed' | 'skip'。
 * 撞名优先级：链接形态撞名 → 拒绝；大小写撞名 → 拒绝；运行时已有但无账 → 拒绝（提示 import）；
 * 账本已有 → TTY 问 / 非 TTY 按缺省取向（--yes 覆盖，否则跳过）。
 */
export async function installOne({ asset, editorName, editor, config, ledger, ledgerPath, home, opts }) {
  const runtimeName = resolveRuntimeName(editor, asset.kind, asset.originalName)
  const dir = resolveEditorDir(editor, asset.kind, { home })
  const runtimePath = join(dir, runtimeName)
  const mode = opts.copy ? 'copy' : 'link'

  // 1) 链接形态撞名 → 一律拒绝（设计稿 §4）
  const want = linkWantNames(config, dir, { home, env: opts.env ?? {} })
  if (want.has(runtimeName)) {
    throw new Error(`"${runtimeName}" 已被链接形态占用（sync.config.json 的 targets）——两条管理线不能叠；先移除该链接或换 id`)
  }

  // 2) 大小写撞名 → 拒绝（Windows 文件系统大小写不敏感）
  for (const f of readdirSafe(dir)) {
    if (f.toLowerCase() === runtimeName.toLowerCase() && f !== runtimeName) {
      throw new Error(`大小写撞名：目录里已有 "${f}"，与 "${runtimeName}" 冲突——请换 id`)
    }
  }

  // 3) 运行时已有同名 → 按「路径」找账本主人（按 id 找会漏掉 --as 换 id 的场景）：
  //    有主且是别的 id → 拒绝（同一运行时位置不能有两个账本条目盯着）；
  //    无主 → 可能是手装的，归 aas import 管，拒绝
  const owner = ledger.entries.find((e) => e.editor === editorName
    && typeof e.runtimePath === 'string'
    && resolve(expandHome(e.runtimePath, home)) === resolve(runtimePath))
  if (owner && owner.id !== asset.id) {
    throw new Error(`运行时位置已被账本条目 "${owner.id}" 占用（${runtimePath}）——换个账本 id 也还是同一个位置；先 aas remove ${owner.id} 再装`)
  }
  if (!owner && lexists(runtimePath)) {
    throw new Error(`运行时已有 "${runtimeName}" 但账本无记录（可能是手工放置）——用 aas import 收编，或先手工移除`)
  }

  // 4) 账本已有 → TTY 问 / 非 TTY 缺省取向
  const dup = findEntry(ledger, asset.id, editorName)
  if (dup) {
    if (opts.isTTY && !opts.yes) {
      const { confirm } = await import('@inquirer/prompts')
      const overwrite = await confirm({ message: `${runtimeName} 已安装过，覆盖？`, default: false })
      if (!overwrite) return 'skip'
    } else if (!opts.isTTY && !opts.yes) {
      return 'skip'
    }
  }

  // 5) 先记账（installing）→ 写运行时 → 改 installed（半装态可恢复，设计稿 §4）
  const entry = {
    id: asset.id,
    kind: asset.kind,
    status: 'installing',
    editor: editorName,
    originalName: asset.originalName,
    runtimeName,
    runtimePath: runtimePath,
    mode,
    source: { repo: asset.repo, ref: asset.ref, commit: asset.commit, path: asset.path, fetchedAt: new Date().toISOString() },
    installedAt: new Date().toISOString(),
  }
  const idx = ledger.entries.findIndex((e) => e.id === asset.id && e.editor === editorName)
  if (idx === -1) ledger.entries.push(entry)
  else ledger.entries[idx] = entry
  writeLedger(ledgerPath, ledger)

  mkdirSync(dir, { recursive: true })
  if (lexists(runtimePath)) removeLinkOrCopy(runtimePath)
  if (mode === 'copy') {
    if (asset.kind === 'skill') cpSync(asset.abs, runtimePath, { recursive: true })
    else copyFileSync(asset.abs, runtimePath)
  } else {
    symlinkSync(asset.abs, runtimePath, editorLevel(editor, asset.kind) === 'dir' ? 'junction' : 'file')
  }
  if (!existsSync(runtimePath)) throw new Error(`装完读不到：${runtimePath}（可能缺开发者模式——规则侧 file symlink 依赖它）`)

  entry.status = 'installed'
  writeLedger(ledgerPath, ledger)
  return 'installed'
}

/**
 * aas add 主流程。返回打印行数组。
 * opts: { editor, yes, copy, as, configPath, home, isTTY, env }
 */
export async function runAdd({ sourceSpec, names = [], opts }) {
  const home = opts.home ?? homedir()
  const isTTY = opts.isTTY ?? false
  const lines = []

  const config = normalizeConfig(loadConfig(opts.configPath ?? DEFAULT_CONFIG_PATH))
  const picked = pickEditor(config, { editor: opts.editor, home })
  if (picked.needChoice) {
    if (!isTTY) throw new Error(`${picked.message}（非交互环境）`)
    throw new Error(`${picked.message}——交互挑选见阶段 3 后续版本，当前请显式 --editor`)
  }
  const { name: editorName, editor } = picked

  const src = parseSource(sourceSpec, config)
  const { cacheDir, commit } = cloneToCache(src, { home })
  lines.push(`源：${src.url}${src.ref ? `（ref: ${src.ref}）` : ''}`)
  lines.push(`缓存：${cacheDir}${commit ? `（commit ${commit.slice(0, 12)}）` : ''}`)

  const assets = listAssets(cacheDir)
  const ledgerPath = defaultLedgerPath(home)
  const ledger = readLedger(ledgerPath)

  let selected
  if (names.length > 0) {
    selected = resolveNames(names, assets, opts)
  } else {
    if (!isTTY) {
      throw new Error(`非交互环境必须给出要装的资产名；缓存里可选：${assets.map((a) => a.id).join('、') || '（无）'}`)
    }
    const { checkbox } = await import('@inquirer/prompts')
    const installedSet = new Set(ledger.entries.filter((e) => e.editor === editorName).map((e) => `${e.id}`))
    const answers = await checkbox({
      message: '选择要安装的资产（空格勾选，回车确认；[已装] = 账本里有记录）',
      choices: assets.map((a) => ({
        name: `${a.kind === 'skill' ? '[技能]' : '[规则]'} ${a.id}${installedSet.has(a.id) ? '  [已装]' : ''}  (${a.path})`,
        value: a,
      })),
    })
    if (answers.length === 0) {
      lines.push('未选择任何资产，无事可做。')
      return lines
    }
    selected = answers
  }

  let installed = 0
  let skipped = 0
  for (const asset of selected) {
    const action = await installOne({
      asset: { ...asset, repo: src.url, ref: src.ref, commit },
      editorName, editor, config, ledger, ledgerPath, home,
      opts: { ...opts, isTTY },
    })
    if (action === 'installed') {
      installed++
      const e = findEntry(ledger, asset.id, editorName)
      const verb = e.mode === 'copy' ? '装副本' : '装链接'
      lines.push(`· ${verb}  ${e.runtimeName}  →  ${e.runtimePath}  （来自 ${e.source.path}）`)
    } else {
      skipped++
      lines.push(`· 跳过    ${asset.id}  （已存在；要覆盖加 --yes）`)
    }
  }
  lines.push(`→ 完成：新增 ${installed}、跳过 ${skipped}。账本：${ledgerPath}`)
  return lines
}
