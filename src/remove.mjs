/**
 * remove.mjs —— aas remove 的实现（设计稿 §5 remove 行）。
 *
 * 按账本精确定位：摘运行时条目 → 销账（先摘后销，中断重跑收敛）。
 * isTTY 守卫：非 TTY 且没给 --yes → 直接报错，绝不静默删（设计稿 §7）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'
import { expandHome, removeLinkOrCopy, lexists, loadConfig, DEFAULT_CONFIG_PATH } from './sync.mjs'
import { normalizeConfig } from './config.mjs'
import { readLedger, writeLedger, defaultLedgerPath } from './ledger.mjs'
import { cacheKeyForSource } from './add.mjs'

/**
 * aas remove 主流程。返回打印行数组。
 * opts: { editor, yes, purge, configPath, home, isTTY }
 */
export async function runRemove({ id, opts }) {
  const home = opts.home ?? homedir()
  const isTTY = opts.isTTY ?? false
  const lines = []

  const config = normalizeConfig(loadConfig(opts.configPath ?? DEFAULT_CONFIG_PATH))
  void config // remove 只认账本；载入配置是为了保持与 add 同一套"配置有效性"前提
  const ledgerPath = defaultLedgerPath(home)
  const ledger = readLedger(ledgerPath)

  const matches = ledger.entries.filter((e) => e.id === id && (!opts.editor || e.editor === opts.editor))
  if (matches.length === 0) {
    const ids = [...new Set(ledger.entries.map((e) => `${e.id}@${e.editor}`))]
    throw new Error(`账本里没有 "${id}"${opts.editor ? `（编辑器 ${opts.editor}）` : ''}；可选：${ids.join('、') || '（账本是空的）'}`)
  }

  if (!isTTY && !opts.yes) {
    throw new Error('删除是危险操作：非交互环境必须显式加 --yes（或在交互终端里确认）')
  }
  if (isTTY && !opts.yes) {
    const { confirm } = await import('@inquirer/prompts')
    const ok = await confirm({ message: `确认摘除 ${id}（${matches.map((m) => m.runtimeName).join('、')}）？`, default: false })
    if (!ok) {
      lines.push('已取消，什么都没动。')
      return lines
    }
  }

  let removed = 0
  for (const e of matches) {
    const p = expandHome(e.runtimePath, home)
    if (lexists(p)) {
      removeLinkOrCopy(p)
      lines.push(`· 摘除  ${e.runtimeName}  （${p}）`)
    } else {
      lines.push(`· 运行时已不存在，仅销账  ${e.runtimeName}`)
    }
    removed++
  }
  ledger.entries = ledger.entries.filter((e) => !(e.id === id && (!opts.editor || e.editor === opts.editor)))
  writeLedger(ledgerPath, ledger)

  if (opts.purge) {
    const stillReferenced = new Set(ledger.entries.map((e) => cacheKeyForSource(e.source.repo, e.source.repo && !e.source.repo.includes('://'))))
    for (const e of matches) {
      const key = cacheKeyForSource(e.source.repo, e.source.repo && !e.source.repo.includes('://'))
      if (!stillReferenced.has(key)) {
        const dir = join(home, '.aas', 'repos', key)
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true })
          lines.push(`· 清缓存  ${key}`)
        }
      }
    }
  }

  lines.push(`→ 完成：摘除 ${removed}。账本：${ledgerPath}`)
  return lines
}
