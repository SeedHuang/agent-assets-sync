/**
 * update.mjs —— aas update 的实现（设计稿 §5 update 行 / §6 三态漂移修复）。
 *
 * 按账本刷新：重新拉源 → 比对 commit → 换缓存 → 重建链接 → 更新账本。
 * 同时是三态漂移的修复入口：断链（缓存/运行时没了）、副本化（链接被换成真实副本）、
 * 指向别处 —— 一律"摘旧建新"回到账本记录的形态。
 *
 * 共享缓存语义：同一 repo+ref 的所有账本条目跟随同一条缓存链接——缓存一换，
 * 所有指向它的链接内容同时变新（账本 commit 一并刷新）；只对本次选中的条目做运行时修复。
 */
import {
  existsSync, mkdirSync, rmSync, renameSync, copyFileSync, cpSync, symlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  loadConfig, expandHome, removeLinkOrCopy, lexists, linkTarget, DEFAULT_CONFIG_PATH,
} from './sync.mjs'
import { normalizeConfig } from './config.mjs'
import { readLedger, writeLedger, defaultLedgerPath } from './ledger.mjs'
import { cacheKeyForSource } from './add.mjs'

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
  mkdirSync(dirnameSafe(p), { recursive: true })
  if (entry.mode === 'copy') {
    if (entry.kind === 'skill') cpSync(assetAbs, p, { recursive: true })
    else copyFileSync(assetAbs, p)
  } else {
    symlinkSync(assetAbs, p, editorLevelSafe(config, entry.editor, entry.kind))
  }
  if (!existsSync(p)) throw new Error(`重建后读不到：${p}`)
  return p
}

function dirnameSafe(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? '.' : p.slice(0, i)
}

/** 拉新版到 temp（git clone / 本地拷贝），返回 { tmp, commit } */
function fetchFresh(group, home) {
  const key = cacheKeyForSource(group.repo, group.isLocal)
  const tmp = join(home, '.aas', 'temp', `${key}-${Date.now()}`)
  mkdirSync(dirnameSafe(tmp), { recursive: true })
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

/** 真目录递归拷贝（copy 模式换缓存用） */
function copyTree(from, to) {
  mkdirSync(dirnameSafe(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
}

/**
 * aas update 主流程。返回打印行数组。
 * opts: { editor, configPath, home, isTTY, env }
 */
export async function runUpdate({ name, all, opts }) {
  const home = opts.home ?? homedir()
  const isTTY = opts.isTTY ?? false
  void isTTY // update 是非破坏性的原位刷新，不需要确认（旧版本仍在 git 历史里）
  const lines = []

  const config = normalizeConfig(loadConfig(opts.configPath ?? DEFAULT_CONFIG_PATH))
  const ledgerPath = defaultLedgerPath(home)
  const ledger = readLedger(ledgerPath)

  let entries
  if (name) {
    entries = ledger.entries.filter((e) => e.id === name && (!opts.editor || e.editor === opts.editor))
    if (entries.length === 0) {
      const ids = [...new Set(ledger.entries.map((e) => `${e.id}@${e.editor}`))]
      throw new Error(`账本里没有 "${name}"${opts.editor ? `（编辑器 ${opts.editor}）` : ''}；可选：${ids.join('、') || '（账本是空的）'}`)
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

  // 按来源分组：同一 repo+ref 只拉一次（groupKey 用于分组；cacheKey 用于定位缓存目录）
  const groups = new Map()
  for (const e of entries) {
    const isLocal = typeof e.source.repo === 'string' && !e.source.repo.includes('://')
    const groupKey = `${e.source.repo}|${e.source.ref ?? ''}`
    const cacheKey = cacheKeyForSource(e.source.repo, isLocal)
    if (!groups.has(groupKey)) groups.set(groupKey, { repo: e.source.repo, ref: e.source.ref, isLocal, cacheKey, entries: [] })
    groups.get(groupKey).entries.push(e)
  }

  let contentUpdated = 0
  let driftRepaired = 0
  let alreadyOk = 0

  for (const g of groups.values()) {
    const cacheDir = join(home, '.aas', 'repos', g.cacheKey)
    const { tmp, commit: newCommit } = fetchFresh(g, home)

    // 上游路径核对：本次涉及的所有资产路径必须在新版里都还在，否则不动旧缓存
    const missing = g.entries.filter((e) => !existsSync(join(tmp, e.source.path)))
    if (missing.length > 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`上游已不含这些路径，本次不刷新（旧缓存未动，现有链接仍有效）：${missing.map((m) => `${m.id}→${m.source.path}`).join('、')}`)
    }

    const commitChanged = newCommit ? g.entries.some((e) => e.source.commit !== newCommit) : true

    if (commitChanged || !existsSync(cacheDir)) {
      // 换缓存：先确认没有别的未选中条目也指这个缓存——它们跟着链接自动变新，账本 commit 一并刷
      copyTree(tmp, cacheDir)
      for (const e of ledger.entries) {
        if (`${e.source.repo}|${e.source.ref ?? ''}` === `${g.repo}|${g.ref ?? ''}`) {
          if (newCommit) e.source.commit = newCommit
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

  lines.push(`→ 完成：内容更新 ${contentUpdated}、修复漂移 ${driftRepaired}、已最新 ${alreadyOk}。账本：${ledgerPath}`)
  return lines
}
