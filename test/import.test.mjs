/** import.mjs 的测试：收编 / 名字匹配变体 / 同名拒绝 / 非手建拒绝 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runImport, inverseTemplate } from '../src/import.mjs'

function tmp(p = 'imp-') { return mkdtempSync(join(tmpdir(), p)) }

/** 假 home：runtime 目录（手建规则/技能放这里）+ 源目录（收编目的地）+ 配置 */
function makeFixture() {
  const home = tmp('home-')
  const runtimeRules = join(home, 'user_rules')
  const runtimeSkills = join(home, 'skills')
  const srcRules = join(home, 'my-src-rules')
  const srcSkills = join(home, 'my-src-skills')
  mkdirSync(runtimeRules, { recursive: true })
  mkdirSync(runtimeSkills, { recursive: true })
  mkdirSync(srcRules, { recursive: true })
  mkdirSync(srcSkills, { recursive: true })
  const config = {
    schemaVersion: 1,
    editors: {},
    sources: {},
    linkTargets: [
      { label: 'r', srcDir: srcRules, dstDir: runtimeRules, dstName: 'rule-{name}', level: 'file' },
      { label: 'k', srcDir: srcSkills, dstDir: runtimeSkills, dstName: '{name}', level: 'dir' },
    ],
  }
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(config), 'utf8')
  const opts = { configPath: cfgPath, home, env: {} }
  return { home, runtimeRules, runtimeSkills, srcRules, srcSkills, cfgPath, opts }
}

test('inverseTemplate：正反例', () => {
  assert.equal(inverseTemplate('rule-{name}', 'rule-foo.md'), 'foo.md')
  assert.equal(inverseTemplate('{name}', 'anything'), 'anything')
  assert.equal(inverseTemplate('rule-{name}', 'other.md'), null)
  assert.equal(inverseTemplate('rule-{name}', 'rule-'), null, '空 middle 无效')
})

test('import：手建规则收编 → 源里出现原始名文件，内容一致；不碰账本、不建链接', async () => {
  const f = makeFixture()
  writeFileSync(join(f.runtimeRules, 'rule-handmade.md'), 'HANDMADE BODY', 'utf8')
  const lines = await runImport({ name: 'rule-handmade.md', opts: f.opts })
  assert.ok(lines.some((l) => l.includes('收编')), lines.join('\n'))
  const dest = join(f.srcRules, 'handmade.md')
  assert.ok(existsSync(dest), '源里应出现原始名（去掉模板前缀）')
  assert.equal(readFileSync(dest, 'utf8'), 'HANDMADE BODY')
  assert.ok(lines.some((l) => l.includes('aas sync --replace')), '必须提示接管命令')
  const { readLedger } = await import('../src/ledger.mjs')
  assert.equal(readLedger(join(f.home, '.aas', 'installed.json')).entries.length, 0, 'import 不碰账本')
})

test('import：名字匹配的四种变体（运行时名/无扩展/原名/原名无扩展）', async () => {
  for (const variant of ['rule-foo.md', 'rule-foo', 'foo.md', 'foo']) {
    const f = makeFixture()
    writeFileSync(join(f.runtimeRules, 'rule-foo.md'), 'X', 'utf8')
    const lines = await runImport({ name: variant, opts: f.opts })
    assert.ok(existsSync(join(f.srcRules, 'foo.md')), `变体 ${variant} 应命中`)
    assert.ok(lines.length > 0)
  }
})

test('import：手建技能目录收编（整目录拷贝）', async () => {
  const f = makeFixture()
  mkdirSync(join(f.runtimeSkills, 'hand-skill'), { recursive: true })
  writeFileSync(join(f.runtimeSkills, 'hand-skill', 'SKILL.md'), 'hi', 'utf8')
  const lines = await runImport({ name: 'hand-skill', opts: f.opts })
  assert.ok(lines.some((l) => l.includes('收编')), lines.join('\n'))
  assert.ok(existsSync(join(f.srcSkills, 'hand-skill', 'SKILL.md')))
})

test('import：链接形态管理中的名字 → 点名拒绝（不是含糊的没匹配）', async () => {
  const f = makeFixture()
  writeFileSync(join(f.srcRules, 'managed.md'), 'SOURCE', 'utf8')
  writeFileSync(join(f.runtimeRules, 'rule-managed.md'), 'MANAGED', 'utf8') // 想要名单内的运行时副本
  await assert.rejects(() => runImport({ name: 'managed', opts: f.opts }), /不归 import 管[\s\S]*链接形态[\s\S]*sync --replace/)
})

test('import：源里同名 → 拒绝（O15；无扩展名手建文件归一化后撞上源里的 .md）', async () => {
  const f = makeFixture()
  writeFileSync(join(f.runtimeRules, 'rule-dup'), 'RUNTIME', 'utf8') // 手建时忘了扩展名
  writeFileSync(join(f.srcRules, 'dup.md'), 'SOURCE ALREADY', 'utf8')
  await assert.rejects(() => runImport({ name: 'rule-dup', opts: f.opts }), /源里已有同名/)
  assert.equal(readFileSync(join(f.srcRules, 'dup.md'), 'utf8'), 'SOURCE ALREADY', '源文件不能被覆盖')
})

test('import：本身是链接 → 拒绝（链接不是手建副本）', async () => {
  const f = makeFixture()
  writeFileSync(join(f.home, 'elsewhere.md'), 'ELSEWHERE', 'utf8')
  symlinkSync(join(f.home, 'elsewhere.md'), join(f.runtimeRules, 'rule-linked.md'), 'file')
  await assert.rejects(() => runImport({ name: 'linked', opts: f.opts }), /是链接不是手建副本/)
})

test('import：无匹配 → 报错并列出未托管条目（防呆）', async () => {
  const f = makeFixture()
  writeFileSync(join(f.runtimeRules, 'rule-aaa.md'), 'A', 'utf8')
  writeFileSync(join(f.runtimeRules, 'rule-bbb.md'), 'B', 'utf8')
  await assert.rejects(
    () => runImport({ name: 'zzz', opts: f.opts }),
    /没有匹配 "zzz"[\s\S]*rule-aaa\.md[\s\S]*rule-bbb\.md/,
  )
})

test('import：目标运行时目录存在的相对 srcDir 缺 repoRoot → 报错指路（守卫与循环同判定）', async () => {
  const home = tmp('home-')
  try {
    const runtime = join(home, 'rules')
    mkdirSync(runtime, { recursive: true })
    const config = {
      schemaVersion: 1, editors: {}, sources: {},
      linkTargets: [{ label: 'r', srcDir: 'rules', dstDir: runtime, dstName: 'rule-{name}', level: 'file' }],
    }
    const cfgPath = join(home, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify(config), 'utf8')
    await assert.rejects(
      () => runImport({ name: 'rule-x.md', opts: { configPath: cfgPath, home, env: {} } }),
      /相对路径.*repoRoot/,
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('import：相对 srcDir 的 target 目标目录不存在 → 守卫不误杀（无关 target）', async () => {
  const home = tmp('home-')
  try {
    const existing = join(home, 'existing')
    mkdirSync(existing, { recursive: true })
    const config = {
      schemaVersion: 1, editors: {}, sources: {},
      linkTargets: [
        { label: 'rel-missing', srcDir: 'rules', dstDir: join(home, 'nope'), dstName: 'rule-{name}', level: 'file' },
        { label: 'ok', srcDir: existing, dstDir: existing, dstName: 'rule-{name}', level: 'file' },
      ],
    }
    const cfgPath = join(home, 'cfg.json')
    writeFileSync(cfgPath, JSON.stringify(config), 'utf8')
    // 目标目录不存在的相对 srcDir target 被 matchesImportTarget 排除 → 不报 repoRoot；
    // 循环里没有可收编条目 → 报「没有匹配」（而非 repoRoot 指路）
    await assert.rejects(
      () => runImport({ name: 'rule-x.md', opts: { configPath: cfgPath, home, env: {} } }),
      /没有匹配/,
    )
  } finally { rmSync(home, { recursive: true, force: true }) }
})
