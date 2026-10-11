/** config-cmd.mjs 的测试：目录校验 / 非交互 get / set 写入 / 键校验 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateRepoRoot, runConfigGet, runConfigSet, runConfigInit, editorChoices,
} from '../src/config-cmd.mjs'
import { loadUserConfig, userConfigPath } from '../src/user-config.mjs'

const tempHome = () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-'))
  const home = join(root, 'h')
  mkdirSync(home, { recursive: true })
  const src = join(root, 'src')
  mkdirSync(join(src, 'rules'), { recursive: true })
  mkdirSync(join(src, 'skills'), { recursive: true })
  return { root, home, src, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('validateRepoRoot：存在且有 rules/skills → 无 warning；目录不存在 → 抛错', () => {
  const f = tempHome()
  try {
    const v = validateRepoRoot(f.src, { home: f.home })
    assert.equal(v.path, f.src)
    assert.equal(v.warning, null)
    assert.throws(() => validateRepoRoot(join(f.root, 'nope'), { home: f.home }), /目录不存在/)
  } finally { f.done() }
})

test('validateRepoRoot：存在但缺 rules/skills → warning 不拦', () => {
  const f = tempHome()
  try {
    const empty = join(f.root, 'empty')
    mkdirSync(empty)
    const v = validateRepoRoot(empty, { home: f.home })
    assert.match(v.warning, /rules|skills/)
  } finally { f.done() }
})

test('validateRepoRoot：传文件路径（非目录）→ 报错', () => {
  const f = tempHome()
  try {
    const file = join(f.root, 'afile')
    writeFileSync(file, 'x')
    assert.throws(() => validateRepoRoot(file, { home: f.home }), /不是目录/)
  } finally { f.done() }
})

test('validateRepoRoot：非字符串 / 空串 → 报错（不裸抛 TypeError）', () => {
  const f = tempHome()
  try {
    assert.throws(() => validateRepoRoot(null, { home: f.home }), /应为非空字符串/)
    assert.throws(() => validateRepoRoot('', { home: f.home }), /应为非空字符串/)
  } finally { f.done() }
})

test('runConfigGet 非交互：打印全部字段（含中文解释与未设置标记）', async () => {
  const f = tempHome()
  try {
    const out = []
    await runConfigGet({ home: f.home, isTTY: false, print: (l) => out.push(l) })
    const s = out.join('\n')
    assert.match(s, /repoRoot/)
    assert.match(s, /editor/)
    assert.match(s, /schemaVersion/)
    assert.match(s, /源仓库根目录/)
    assert.match(s, /未设置/)
  } finally { f.done() }
})

test('runConfigSet：repoRoot 显式值直接写 + 落盘', async () => {
  const f = tempHome()
  try {
    const out = []
    await runConfigSet({ key: 'repoRoot', value: f.src, home: f.home, isTTY: false, print: (l) => out.push(l) })
    assert.equal(loadUserConfig({ home: f.home }).repoRoot, f.src)
    assert.match(out.join('\n'), /repoRoot = /)
  } finally { f.done() }
})

test('runConfigSet：editor 显式值（骨架预设 trae-cn）直接写 + 落盘', async () => {
  const f = tempHome()
  try {
    const out = []
    await runConfigSet({ key: 'editor', value: 'trae-cn', home: f.home, isTTY: false, print: (l) => out.push(l) })
    assert.equal(loadUserConfig({ home: f.home }).editor, 'trae-cn')
    assert.match(out.join('\n'), /editor = trae-cn/)
  } finally { f.done() }
})

test('runConfigSet：未知键 / 只读键报错；非交互不给值报错', async () => {
  const f = tempHome()
  try {
    await assert.rejects(() => runConfigSet({ key: 'nope', home: f.home, isTTY: false }), /未知配置键/)
    await assert.rejects(() => runConfigSet({ key: 'schemaVersion', home: f.home, isTTY: false }), /只读/)
    await assert.rejects(() => runConfigSet({ key: 'repoRoot', home: f.home, isTTY: false }), /非交互请直接给/)
  } finally { f.done() }
})

test('editorChoices：骨架里的预设名（trae-cn）', () => {
  const f = tempHome()
  try {
    const choices = editorChoices({ home: f.home })
    assert.ok(choices.includes('trae-cn'))
  } finally { f.done() }
})

test('editorChoices：用户配置坏了 → 退回骨架预设 + 警告（可捕获的 warn）', () => {
  const f = tempHome()
  try {
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(userConfigPath({ home: f.home }), JSON.stringify({ bogusKey: 1 }), 'utf8')
    const warns = []
    const choices = editorChoices({ home: f.home, warn: (m) => warns.push(m) })
    assert.ok(choices.includes('trae-cn'), '应退回骨架预设')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /用户配置无法载入/)
  } finally { f.done() }
})

test('editorChoices：用户配置能读但推导不过（相对 repoRoot）→ 降级 + 警告', () => {
  const f = tempHome()
  try {
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(userConfigPath({ home: f.home }), JSON.stringify({ schemaVersion: 1, repoRoot: 'relative/repo' }), 'utf8')
    const warns = []
    const choices = editorChoices({ home: f.home, warn: (m) => warns.push(m) })
    assert.ok(choices.includes('trae-cn'), '应降级到骨架预设')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /用户配置无法生效/)
  } finally { f.done() }
})

test('runConfigGet：坏配置不阻塞查看（宽容读 + 警告，仍按「未设置」显示）', async () => {
  const f = tempHome()
  try {
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(userConfigPath({ home: f.home }), '{ broken', 'utf8')
    const out = []
    const warns = []
    await runConfigGet({ home: f.home, isTTY: false, print: (l) => out.push(l), warn: (m) => warns.push(m) })
    assert.match(out.join('\n'), /repoRoot/, '仍应打印配置表')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /用户配置无法载入/)
  } finally { f.done() }
})

test('editorChoices：骨架文件不存在 → 直接抛（回退救不了它，不加无谓警告）', () => {
  const f = tempHome()
  try {
    const warns = []
    assert.throws(
      () => editorChoices({ home: f.home, baseConfigPath: join(f.root, 'nope.json'), warn: (m) => warns.push(m) }),
      /配置文件不存在/,
    )
    assert.equal(warns.length, 0, '骨架故障不该说成「用户配置无法载入」')
  } finally { f.done() }
})

test('editorChoices：骨架结构不合法（合法 JSON 但缺 linkTargets）→ 直接抛、不警告', () => {
  const f = tempHome()
  try {
    const badSkel = join(f.root, 'bad-skel.json')
    writeFileSync(badSkel, JSON.stringify({ schemaVersion: 1, editors: {} }), 'utf8')
    const warns = []
    assert.throws(
      () => editorChoices({ home: f.home, baseConfigPath: badSkel, warn: (m) => warns.push(m) }),
      /targets\/linkTargets/,
    )
    assert.equal(warns.length, 0, '骨架结构错误不该被标成「用户配置无法载入」')
  } finally { f.done() }
})

test('runConfigInit 非交互：直接抛错（退出码=2，不读配置也不打印表）', async () => {
  const f = tempHome()
  try {
    const out = []
    await assert.rejects(
      () => runConfigInit({ home: f.home, isTTY: false, print: (l) => out.push(l) }),
      /初始化需要交互窗口/,
    )
    assert.equal(out.length, 0, '失败前不应打印任何东西')
  } finally { f.done() }
})
