/**
 * editors.mjs —— 编辑器适配器（设计稿 §3）。
 *
 * 每个 editor 条目：{ detect: [目录...], prereq, rules: {dir,nameTemplate,level}, skills: {...} }
 * 这里只做三件事：检测、挑选、把 originalName 映射成 runtimeName。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { expandHome } from './sync.mjs'

/** 命中检测信号的编辑器列表 */
export function detectEditors(config, { home = homedir(), exists = existsSync } = {}) {
  const hits = []
  for (const [name, editor] of Object.entries(config.editors ?? {})) {
    const signals = Array.isArray(editor?.detect) ? editor.detect : []
    if (signals.some((d) => exists(resolve(expandHome(d, home))))) hits.push({ name, editor })
  }
  return hits
}

/**
 * 挑编辑器（纯函数，不弹交互）：
 *   显式给了名字（--editor，或用户配置 ~/.aas/config.json 的 editor）→ 必须存在，否则报错并列出可选值
 *   没给 → 恰好命中一个就用它；零个或多个 → 返回 needChoice（调用方决定交互还是报错）
 *   优先级：editor（命令行）> defaultEditor（用户配置）> 自动检测
 */
export function pickEditor(config, { editor, defaultEditor = null, home = homedir(), exists = existsSync } = {}) {
  const names = Object.keys(config.editors ?? {})
  const explicit = editor ?? defaultEditor
  if (explicit) {
    if (!config.editors?.[explicit]) {
      // 点名来源（命令行 vs 用户配置）并给修复入口——否则用户不知道这个名字从哪来、该去哪改
      const from = editor ? '--editor' : '~/.aas/config.json 的 editor'
      const fix = editor ? '--editor <名>' : 'aas config set editor <名>'
      throw new Error(`编辑器 "${explicit}"（来自 ${from}）不在配置里；可选：${names.join('、') || '（配置里没有任何编辑器）'}\n  下一步：${fix}`)
    }
    return { name: explicit, editor: config.editors[explicit] }
  }
  const hits = detectEditors(config, { home, exists })
  if (hits.length === 1) return { name: hits[0].name, editor: hits[0].editor }
  return {
    needChoice: true,
    choices: hits,
    message:
      hits.length === 0
        ? '没有编辑器命中检测信号；请用 --editor <名> 显式指定'
        : `命中多个编辑器（${hits.map((h) => h.name).join('、')}）；请用 --editor <名> 显式指定`,
  }
}

function section(editor, kind) {
  const conf = kind === 'skill' ? editor.skills : editor.rules
  // level 一并校验：缺了它 add 会把技能目录按 file 方式去链接，最后只报一句糊涂的「装完读不到」，
  // 离真正原因（配置缺字段）隔了好几步。在这里大声报配置错误
  if (!conf?.dir || !conf?.nameTemplate?.includes('{name}') || (conf?.level !== 'file' && conf?.level !== 'dir')) {
    throw new Error(`编辑器配置缺 ${kind} 段（需 dir、nameTemplate 含 {name}、level ∈ file|dir）`)
  }
  return conf
}

/** originalName → runtimeName（映射的核心，设计稿 §4） */
export function resolveRuntimeName(editor, kind, originalName) {
  return section(editor, kind).nameTemplate.split('{name}').join(originalName)
}

/** 编辑器某类资产的运行时目录（绝对路径） */
export function resolveEditorDir(editor, kind, { home = homedir() } = {}) {
  return resolve(expandHome(section(editor, kind).dir, home))
}

/** 编辑器某类资产的链接级别（file | dir） */
export function editorLevel(editor, kind) {
  return section(editor, kind).level
}

/** 给 aas editors 命令看的多行描述 */
export function describeEditors(config, { home = homedir(), exists = existsSync } = {}) {
  const lines = ['== 编辑器 ==']
  const entries = Object.entries(config.editors ?? {})
  if (entries.length === 0) lines.push('（配置里没有 editors）')
  const hitNames = new Set(detectEditors(config, { home, exists }).map((h) => h.name)) // 循环外算一次，别每个编辑器都重扫一遍文件系统
  for (const [name, editor] of entries) {
    // normalizeConfig 只保证 editors 是对象，不保证每个条目是对象——null 条目要给出可读的提示而不是 TypeError
    if (!editor || typeof editor !== 'object') {
      lines.push(`？ ${name}  （配置条目无效：应为对象）`)
      continue
    }
    const hit = hitNames.has(name)
    lines.push(`${hit ? '✓' : '？'} ${name}${hit ? '  （检测命中）' : '  （未检测到）'}${editor.prereq ? `  prereq: ${editor.prereq}` : ''}`)
    for (const kind of ['rules', 'skills']) {
      const c = editor[kind]
      if (c) lines.push(`    ${kind === 'rules' ? '规则' : '技能'} → ${c.dir}  模板 ${c.nameTemplate} (${c.level})`)
    }
  }
  return lines
}
