/**
 * update.mjs —— aas update 的实现（设计稿 §5 update 行 / §6 三态漂移修复）。
 *
 * 按账本刷新：重新拉源 → 比对 commit → 换缓存 → 重建链接 → 更新账本。
 * 同时是三态漂移的修复入口：断链（缓存/运行时没了）、副本化（链接被换成真实副本）、
 * 指向别处 —— 一律"摘旧建新"回到账本记录的形态。
 *
 * 共享缓存语义：同一 repo+ref 的所有「链接模式」条目跟随同一条缓存——缓存一换，
 * 指向它的链接内容同时变新（这些条目的账本 commit 一并刷新）；「副本模式」的运行时
 * 是真实拷贝，必须被 relink 才算更新，所以 commit 号只推给被 relink 的 copy 条目和
 * 跟随缓存的 link 条目，绝不能提前推给未 relink 的 copy 条目（否则它们会被永远判成
 * 「已是最新」，内容却停在旧版，且 detectDrift 不查 copy 模式，再也不会被发现）。
 */
import {
  existsSync, mkdirSync, rmSync, renameSync, copyFileSync, cpSync, symlinkSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  expandHome, removeLinkOrCopy, lexists, linkTarget,
} from './sync.mjs'
import { loadEffectiveConfig } from './user-config.mjs'
import { readLedger, writeLedger, defaultLedgerPath } from './ledger.mjs'
import { cacheKeyForSource, reposDirFor } from './add.mjs'
import { resolveSkillDeps } from './deps.mjs'
import { ensureSkillDep } from './add.mjs'
import { ensureCli } from './cli-version.mjs'

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const tail = String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(' | ')
    throw new Error(`git 失败（${args.join(' ')}）：${tail}\n下一步：检查网络/凭证，或先 aas remove 后重装`)
  }
}

function editorLevelSafe(config, editorName, kind) {
  const ed = config.editors?.[editorName]
  const conf = kind === 'skill' ? ed?.skills : ed?.rules
  if (conf?.level === 'dir') return 'junction'
  if (conf?.level === 'file') return 'file'
  return kind === 'skill' ? 'junction' : 'file' // 编辑器配置被删时按 kind 兜底
}

/** 运行时漂移判定（设计稿 §6 三态）：返回漂移描述，无漂移返回 null */
export function detectDrift(entry, assetAbs, { home = homedir() } = {}) {
  const p = resolve(expandHome(entry.runtimePath, home))
  if (!lexists(p)) return '断链/运行时缺失'
  if (entry.mode === 'link') {
    const lt = linkTarget(p)
    if (!lt) return '副本化（链接被换成真实副本）'
    if (resolve(lt) !== resolve(assetAbs)) return '链接指向别处'
  }
  return null
}

function relink(entry, assetAbs, config, { home }) {
  const p = resolve(expandHome(entry.runtimePath, home))
  if (lexists(p)) removeLinkOrCopy(p)
  mkdirSync(dirname(p), { recursive: true })
  if (entry.mode === 'copy') {
    if (entry.kind === 'skill') cpSync(assetAbs, p, { recursive: true })
    else copyFileSync(assetAbs, p)
  } else {
    symlinkSync(assetAbs, p, editorLevelSafe(config, entry.editor, entry.kind))
  }
  if (!existsSync(p)) throw new Error(`重建后读不到：${p}`)
  return p
}

/** 拉新版到 temp（git clone / 本地拷贝），返回 { tmp, commit } */
function fetchFresh(group, home) {
  const key = cacheKeyForSource(group.repo, group.isLocal, group.ref ?? null)
  const tmp = join(dirname(reposDirFor(home)), 'temp', `${key}-${Date.now()}`)
  mkdirSync(dirname(tmp), { recursive: true })
  let commit = null
  if (group.isLocal && !existsSync(join(resolve(group.repo), '.git'))) {
    cpSync(resolve(group.repo), tmp, { recursive: true })
  } else {
    const args = ['clone', '--depth', '1']
    if (group.ref) args.push('--branch', group.ref)
    args.push(group.repo, tmp)
    runGit(args)
    try { commit = runGit(['rev-parse', 'HEAD'], tmp) } catch { /* 非 git */ }
  }
  return { tmp, commit }
}

/**
 * 换缓存（copy 模式换内容用）：先把旧缓存整体改名挪走，再把新版搬进正式位置，最后清掉旧的。
 * 两步 rename 各自原子，任何一步之间中断都不会出现「缓存目录缺失、所有链接悬空」的窗口；
 * 搬新失败还会把旧的还回去。
 */
function replaceCacheDir(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  const old = `${to}.old-${Date.now()}`
  let hadOld = false
  try {
    renameSync(to, old)
    hadOld = true
  } catch { /* 旧缓存不存在，无需挪走 */ }
  try {
    renameSync(from, to)
  } catch (e) {
    if (hadOld) renameSync(old, to) // 搬新失败 → 旧的还回去
    throw e
  }
  if (hadOld) rmSync(old, { recursive: true, force: true })
}

/** 单条目刷新（依赖解析的"刷新"语义用；成功返回 { commit }） */
export async function refreshOne(entry, config, { home = homedir() } = {}) {
  const isLocal = typeof entry.source.repo === 'string' && !entry.source.repo.includes('://')
  const { tmp, commit: newCommit } = fetchFresh({ repo: entry.source.repo, ref: entry.source.ref, isLocal }, home)
  const key = cacheKeyForSource(entry.source.repo, isLocal, entry.source.ref ?? null)
  const cacheDir = join(reposDirFor(home), key)
  replaceCacheDir(tmp, cacheDir)
  const assetAbs = join(cacheDir, entry.source.path)
  relink(entry, assetAbs, config, { home })
  entry.status = 'installed'
  entry.source.commit = newCommit ?? entry.source.commit
  entry.source.fetchedAt = new Date().toISOString()
  return { commit: newCommit }
}

/**
 * aas update 主流程。返回打印行数组。
 * opts: { editor, configPath, home, isTTY, env }
 */
export async function runUpdate({ name, all, opts }) {
  const home = opts.home ?? homedir()
  // update 是非破坏性的原位刷新，不需要确认（旧版本仍在 git 历史里），因此不用 isTTY
  const lines = []

  const config = loadEffectiveConfig(opts.configPath, { home })
  const ledgerPath = defaultLedgerPath(home)
  const ledger = readLedger(ledgerPath)

  let entries
  if (name) {
    entries = ledger.entries.filter((e) => e.id === name && (!opts.editor || e.editor === opts.editor))
    if (entries.length === 0) {
      const ids = [...new Set(ledger.entries.map((e) => `${e.id}@${e.editor}`))]
      throw new Error(
        `账本里没有 "${name}"${opts.editor ? `（编辑器 ${opts.editor}）` : ''}。\n` +
          '  说明：账本只记「从远端仓库装的」资产（aas add 装的那些）。\n' +
          '  如果你要的是「你自己源仓库里的技能 / 规则」，它不走账本、也不需要 update —— 改用：aas sync\n' +
          `  账本里现有：${ids.join('、') || '（账本是空的）'}`,
      )
    }
  } else if (all) {
    entries = [...ledger.entries]
  } else {
    throw new Error('要给资产名，或用 --all 全量刷新')
  }
  if (entries.length === 0) {
    lines.push('账本是空的，无事可做。')
    return lines
  }
  lines.push(`目标 ${entries.length} 条（${[...new Set(entries.map((e) => `${e.id}@${e.editor}`))].join('、')}）`)

  // 按来源分组：同一 repo+ref 只拉一次（groupKey 用于分组；cacheKey 用于定位缓存目录，两者都必须含 ref）
  const groups = new Map()
  for (const e of entries) {
    const isLocal = typeof e.source.repo === 'string' && !e.source.repo.includes('://')
    const groupKey = `${e.source.repo}|${e.source.ref ?? ''}`
    const cacheKey = cacheKeyForSource(e.source.repo, isLocal, e.source.ref ?? null)
    if (!groups.has(groupKey)) groups.set(groupKey, { repo: e.source.repo, ref: e.source.ref, isLocal, cacheKey, entries: [] })
    groups.get(groupKey).entries.push(e)
  }

  let contentUpdated = 0
  let driftRepaired = 0
  let alreadyOk = 0

  for (const g of groups.values()) {
    const cacheDir = join(reposDirFor(home), g.cacheKey)
    const { tmp, commit: newCommit } = fetchFresh(g, home)

    // 上游路径核对：本次涉及的所有资产路径必须在新版里都还在，否则不动旧缓存
    const missing = g.entries.filter((e) => !existsSync(join(tmp, e.source.path)))
    if (missing.length > 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`上游已不含这些路径，本次不刷新（旧缓存未动，现有链接仍有效）：${missing.map((m) => `${m.id}→${m.source.path}`).join('、')}`)
    }

    const commitChanged = newCommit ? g.entries.some((e) => e.source.commit !== newCommit) : true

    if (commitChanged || !existsSync(cacheDir)) {
      // 换缓存：先确认没有别的未选中条目也指这个缓存——link 模式的跟着链接自动变新，账本 commit 一并刷；
      // copy 模式的不能推 commit（它的运行时副本没动，见文件头说明）
      replaceCacheDir(tmp, cacheDir)
      for (const e of ledger.entries) {
        if (`${e.source.repo}|${e.source.ref ?? ''}` === `${g.repo}|${g.ref ?? ''}`) {
          if (newCommit && e.mode !== 'copy') e.source.commit = newCommit
          e.source.fetchedAt = new Date().toISOString()
        }
      }
    } else {
      rmSync(tmp, { recursive: true, force: true })
    }

    for (const e of g.entries) {
      const assetAbs = join(cacheDir, e.source.path)
      const drift = detectDrift(e, assetAbs, { home })
      if (!commitChanged && !drift && existsSync(cacheDir)) {
        alreadyOk++
        lines.push(`· 已是最新  ${e.runtimeName}  （commit ${(e.source.commit ?? '?').slice(0, 12)}）`)
        continue
      }
      relink(e, assetAbs, config, { home })
      e.status = 'installed'
      e.installedAt = new Date().toISOString()
      if (drift) { driftRepaired++; lines.push(`· 修复漂移  ${e.runtimeName}  （${drift}）`) }
      if (commitChanged) { contentUpdated++; lines.push(`· 内容更新  ${e.runtimeName}  （→ commit ${(newCommit ?? '?').slice(0, 12)}）`) }
    }
    writeLedger(ledgerPath, ledger)
  }

  // 依赖重校验（spec §5.2）：刷新完每个 skill 条目后解析其依赖
  const depSummary = { installed: [], refreshed: [], cliUpdated: [], cliInstalled: [], failures: [] }
  for (const e of entries) {
    if (e.kind !== 'skill') continue
    const isLocal = typeof e.source.repo === 'string' && !e.source.repo.includes('://')
    const manifestDir = join(reposDirFor(home), cacheKeyForSource(e.source.repo, isLocal, e.source.ref ?? null))
    const sd = join(manifestDir, 'skilldependencies')
    if (!existsSync(sd)) continue
    const ensureSkill = (name, sourceCtx) => ensureSkillDep({
      name, sourceCtx, manifestRoot: manifestDir, editorName: e.editor, editor: config.editors?.[e.editor],
      config, ledger, ledgerPath, home, opts: { editor: e.editor, isTTY: false, copy: e.mode === 'copy', env: opts.env },
      // C1：inherit 依赖继承父条目的真实来源——绝不让 repo=null 进账本，否则 update --all / remove --purge 会崩
      parentSource: { repo: e.source.repo, ref: e.source.ref, commit: e.source.commit },
    })
    const r = await resolveSkillDeps({
      skill: e.id, rootManifestDir: sd, rootSourceCtx: 'inherit',
      ensureSkill, ensureCli,
    })
    depSummary.installed.push(...r.installed)
    depSummary.refreshed.push(...r.refreshed)
    depSummary.cliUpdated.push(...r.cliUpdated)
    depSummary.cliInstalled.push(...r.cliInstalled)
    depSummary.failures.push(...r.failures)
  }
  for (const n of depSummary.installed) lines.push(`· 依赖安装  ${n}`)
  for (const n of depSummary.refreshed) lines.push(`· 依赖刷新  ${n}`)
  for (const r of depSummary.cliUpdated) lines.push(`· CLI 更新  ${r.name}  ${r.detail}`)
  for (const r of depSummary.cliInstalled) lines.push(`· CLI 安装  ${r.name}  ${r.detail}`)
  for (const f of depSummary.failures) lines.push(`· 依赖失败  [${f.type}] ${f.name}：${f.detail}`)

  lines.push(`→ 完成：内容更新 ${contentUpdated}、修复漂移 ${driftRepaired}、已最新 ${alreadyOk}。账本：${ledgerPath}`)
  return lines
}
