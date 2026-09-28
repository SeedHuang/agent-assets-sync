/**
 * editors.mjs —— 编辑器适配器（设计稿 §3）。
 *
 * 每个 editor 条目：{ detect: [目录...], prereq, rules: {dir,nameTemplate,level}, skills: {...} }
 * 这里只做三件事：检测、挑选、把 originalName 映射成 runtimeName。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
 *   显式给了名字 → 必须存在，否则报错并列出可选值
 *   没给 → 恰好命中一个就用它；零个或多个 → 返回 needChoice（调用方决定交互还是报错）
 */
export function pickEditor(config, { editor, home = homedir(), exists = existsSync } = {}) {
  const names = Object.keys(config.editors ?? {})
  if (editor) {
    if (!config.editors?.[editor]) {
      throw new Error(`编辑器 "${editor}" 不在配置里；可选：${names.join('、') || '（配置里没有任何编辑器）'}`)
    }
    return { name: editor, editor: config.editors[editor] }
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
  if (!conf?.dir || !conf?.nameTemplate?.includes('{name}')) {
    throw new Error(`编辑器配置缺 ${kind} 段（或 nameTemplate 不含 {name}）`)
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
  for (const [name, editor] of entries) {
    const hit = detectEditors(config, { home, exists }).some((h) => h.name === name)
    lines.push(`${hit ? '✓' : '？'} ${name}${hit ? '  （检测命中）' : '  （未检测到）'}${editor.prereq ? `  prereq: ${editor.prereq}` : ''}`)
    for (const kind of ['rules', 'skills']) {
      const c = editor[kind]
      if (c) lines.push(`    ${kind === 'rules' ? '规则' : '技能'} → ${c.dir}  模板 ${c.nameTemplate} (${c.level})`)
    }
  }
  return lines
}
