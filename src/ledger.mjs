/**
 * ledger.mjs —— aas 安装账本（~/.aas/installed.json，设计稿 §4）。
 *
 * 一条 entry = 一个资产 × 一个编辑器，含 originalName → runtimeName 映射。
 * 写入纪律：.bak 滚动 + 临时文件原子改名；读取容错：剥 BOM + schema 校验，
 * 损坏 → 报错并指路 .bak，绝不静默当空账本。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { expandHome } from './sync.mjs'

export const LEDGER_SCHEMA_VERSION = 1
const ENTRY_REQUIRED = ['id', 'kind', 'status', 'editor', 'runtimeName']

export function defaultLedgerPath(home = homedir()) {
  return join(home, '.aas', 'installed.json')
}

/** 形状校验：不合 → 抛错（含原因） */
export function validateLedgerShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('账本内容不是对象')
  if (data.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`账本 schemaVersion=${data.schemaVersion} 不受支持（支持 ${LEDGER_SCHEMA_VERSION}）`)
  }
  if (!Array.isArray(data.entries)) throw new Error('账本缺 entries 数组')
  for (const e of data.entries) {
    for (const k of ENTRY_REQUIRED) {
      if (!e || typeof e[k] !== 'string' || e[k] === '') throw new Error(`账本条目缺字段 ${k}：${JSON.stringify(e).slice(0, 120)}`)
    }
  }
}

/** 读账本。文件不存在 → 空账本（首次使用不是错误）；损坏 → 抛错并指路 .bak */
export function readLedger(ledgerPath = defaultLedgerPath()) {
  if (!existsSync(ledgerPath)) return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [] }
  const rawTxt = readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, '')
  let data
  try {
    data = JSON.parse(rawTxt)
  } catch (e) {
    throw new Error(`账本损坏：${ledgerPath}\n${e.message}\n下一步：从备份恢复——复制 ${ledgerPath}.bak 回去后重试`)
  }
  try {
    validateLedgerShape(data)
  } catch (e) {
    throw new Error(`账本不合法：${ledgerPath}\n${e.message}\n下一步：从备份恢复——复制 ${ledgerPath}.bak 回去后重试`)
  }
  return data
}

/** 写账本：先滚动 .bak，再经临时文件原子改名落盘 */
export function writeLedger(ledgerPath, ledger) {
  validateLedgerShape(ledger)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  if (existsSync(ledgerPath)) copyFileSync(ledgerPath, `${ledgerPath}.bak`)
  const tmp = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  renameSync(tmp, ledgerPath)
}

export function findEntry(ledger, id, editor) {
  return ledger.entries.find((e) => e.id === id && e.editor === editor)
}

export function removeEntry(ledger, id, editor) {
  const before = ledger.entries.length
  ledger.entries = ledger.entries.filter((e) => !(e.id === id && e.editor === editor))
  return before - ledger.entries.length
}

/** 账本里所有 runtimePath 的绝对路径集合（供体检拦截用；~ 已展开、已 resolve） */
export function runtimePathsIndex(ledger, { home = homedir() } = {}) {
  const set = new Set()
  for (const e of ledger.entries) {
    if (typeof e.runtimePath === 'string' && e.runtimePath !== '') {
      set.add(resolve(expandHome(e.runtimePath, home)))
    }
  }
  return set
}

/**
 * 体检拦截（设计稿 §6「账本优先，全类豁免」）：
 * 把 inspect 结果里命中账本 runtimePath 的条目从六类中移出，归入 r.aasInstall，
 * 防止被 --replace / --rm-old 误删。via 记录原分类，报告里可追溯。
 */
export function reclassifyWithLedger(r, t, resolvedPaths) {
  r.aasInstall ??= []
  const move = (arr, nameField, via) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const x = arr[i]
      const name = x[nameField]
      if (resolvedPaths.has(resolve(join(t.dstDir, name)))) {
        arr.splice(i, 1)
        r.aasInstall.push({ name, via })
      }
    }
  }
  move(r.orphans ?? [], 'name', '孤儿')
  move(r.wrong ?? [], 'dstName', '需替换')
  move(r.legacy ?? [], 'name', '旧名残留')
  move(r.staleSelf ?? [], 'name', '自家残留')
  return r
}
