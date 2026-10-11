/**
 * import.mjs —— aas import 的实现（设计稿 §5 import 行 / backlog O15）。
 *
 * 把编辑器运行时里"手建"的条目收编进你自己的源仓库（链接形态接管的第一步）：
 *   找到运行时那份未托管文件 → 按 nameTemplate 逆映射出 originalName
 *   → 写进对应 linkTarget 的 srcDir → 提示 `aas sync --replace` 接管。
 *
 * 边界（全部按设计）：
 *   - 只写源仓库，不自动建链接（接管必须用户显式 sync --replace）
 *   - 源里同名 → 拒绝（O15：先处理同名或换名）
 *   - 链接形态管理中 / 账本管理中 / 本身是链接的 → 都不算"手建"，不收
 */
import { existsSync, readdirSync, lstatSync, copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { expandHome, linkTarget } from './sync.mjs'
import { requireAbsoluteSrcDir, targetSrcFields } from './config.mjs'
import { loadEffectiveConfig } from './user-config.mjs'
import { readLedger, runtimePathsIndex, defaultLedgerPath } from './ledger.mjs'

const stripExt = (f) => f.replace(/\.md$/i, '')

/**
 * 该 target 是否被 import 循环真正消费：返回消费时的 {dst, srcDir}，不消费返回 null。
 * 守卫 filter 与 import 循环共用这一份判定（既防漂移，也让循环不用二次解引用）。
 */
function matchesImportTarget(raw, { home, env }) {
  const f = targetSrcFields(raw, env)
  if (!f) return null
  return existsSync(resolve(expandHome(f.dst, home))) ? f : null
}

/** nameTemplate 逆映射：'rule-{name}' + 'rule-foo.md' → 'foo.md'；不匹配 → null */
export function inverseTemplate(template, file) {
  const i = template.indexOf('{name}')
  if (i === -1) return null
  const prefix = template.slice(0, i)
  const suffix = template.slice(i + '{name}'.length)
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return null
  const middle = file.slice(prefix.length, file.length - suffix.length)
  return middle === '' ? null : middle
}

/**
 * aas import 主流程。返回打印行数组。
 * opts: { configPath, home, env }
 */
export async function runImport({ name, opts }) {
  const home = opts.home ?? homedir()
  if (typeof name !== 'string' || name.trim() === '') throw new Error('要给运行时条目名（如 rule-foo.md 或 foo）')
  const input = name.trim()

  const config = loadEffectiveConfig(opts.configPath, { home })
  const ledger = readLedger(defaultLedgerPath(home))
  const ledgerPaths = runtimePathsIndex(ledger, { home })

  const matches = []
  const unmanaged = [] // 运行时里"无主"的条目（报错时提示用户可选什么）
  const managedHits = [] // 名字对得上、但由别的机制管理的条目（报错时点名）

  // 骨架相对 srcDir 缺 repoRoot 且无环境变量时先报错——否则 resolve 到 cwd、把条目写进 <cwd>/rules。
  // 只校验 import 循环真正会读 srcDir 的 target（matchesImportTarget 与循环同一判定），无关 target 不误杀
  requireAbsoluteSrcDir(config.targets, { home, env: opts.env, filter: (raw) => matchesImportTarget(raw, { home, env: opts.env }) })

  for (const raw of config.targets ?? []) {
    const f = matchesImportTarget(raw, { home, env: opts.env })
    if (!f) continue
    const dstAbs = resolve(expandHome(f.dst, home))
    const srcAbs = resolve(expandHome(f.srcDir, home))
    const kind = raw.level === 'dir' ? 'skill' : 'rule'

    // 链接形态"想要名单"：这些名字由 sync 管理，不是手建的
    const wantNames = new Set(
      existsSync(srcAbs)
        ? readdirSync(srcAbs).filter((n) => !n.startsWith('.')).map((n) => raw.dstName.split('{name}').join(n))
        : [],
    )

    for (const file of readdirSync(dstAbs).filter((f) => !f.startsWith('.'))) {
      const abs = join(dstAbs, file)
      let st
      try { st = lstatSync(abs) } catch { continue }
      const isLink = linkTarget(abs) !== null
      const isDir = st.isDirectory()
      if ((kind === 'rule' && isDir) || (kind === 'skill' && !isDir)) continue // 形态不符（规则要文件、技能要目录）
      const original = inverseTemplate(raw.dstName, file)
      if (!original) continue // 名字不符合编辑器命名约定，不是我们能收的形状
      const candidates = new Set([file, stripExt(file), original, stripExt(original)])
      const hit = candidates.has(input) || candidates.has(stripExt(input))
      const ledgerManaged = ledgerPaths.has(resolve(abs))
      const wantManaged = wantNames.has(file)
      if (wantManaged || ledgerManaged) {
        if (hit) managedHits.push({ file, via: wantManaged ? '链接形态（真实副本请用 aas sync --replace 接管）' : 'aas 账本（请用 aas update / aas remove）' })
        continue
      }
      unmanaged.push({ file, isLink })
      if (hit) matches.push({ raw, file, abs, original, kind, srcAbs, dstAbs, isLink })
    }
  }

  if (matches.length === 0) {
    if (managedHits.length === 1) {
      const h = managedHits[0]
      throw new Error(`"${h.file}" 不归 import 管——它由${h.via}`)
    }
    if (managedHits.length > 1) {
      throw new Error(`"${input}" 对应多个由其他机制管理的条目（${managedHits.map((h) => h.file).join('、')}），import 不收`)
    }
    const listing = unmanaged.map((u) => `${u.file}${u.isLink ? ' [链接]' : ''}`).join('、') || '（无）'
    throw new Error(`运行时里没有匹配 "${input}" 的手建条目；未托管的条目有：${listing}`)
  }
  if (matches.length > 1) {
    throw new Error(`"${input}" 对应多个条目（${matches.map((m) => m.file).join('、')}）——请用更完整的名字（含 .md）`)
  }

  const m = matches[0]
  if (m.isLink) {
    throw new Error(`"${m.file}" 是链接不是手建副本——链接形态的请在源仓库里直接改；aas 安装的走账本管理，都不需要 import`)
  }

  // 源里同名 → 拒绝（O15）
  let original = m.original
  if (m.kind === 'rule' && !/\.md$/i.test(original)) original += '.md'
  const destAbs = join(m.srcAbs, original)
  if (existsSync(destAbs)) {
    throw new Error(`源里已有同名文件：${destAbs}\n下一步：先处理同名（改名或合并）再 import`)
  }

  mkdirSync(m.srcAbs, { recursive: true })
  if (m.kind === 'skill') cpSync(m.abs, destAbs, { recursive: true })
  else copyFileSync(m.abs, destAbs)

  return [
    `· 收编  ${m.file}  →  ${destAbs}`,
    `→ 完成：收编 1。源仓库已更新（由你 commit）`,
    `下一步：aas sync --replace 接管——会把运行时这份真实副本删掉、换成指向源的链接`,
  ]
}
