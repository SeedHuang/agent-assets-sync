/**
 * sync.mjs 的测试。
 *
 * 全部在系统临时目录里造"假源 + 假运行时"——**绝不碰真实的 ~/.trae-cn**（那是你的运行时）。
 *
 * 跑法（在本项目根下）：node --test test/sync.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync,
  symlinkSync, lstatSync, readFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inspect, applyOne, parseArgs, buildTargets, loadConfig, isDirectRun } from '../src/sync.mjs'
import { pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────
function fixture({ dirLevel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sync-test-'))
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  mkdirSync(src)
  mkdirSync(dst)
  const t = {
    label: 'test',
    srcDir: src,
    dstDir: dst,
    dstName: (n) => (dirLevel ? n : `rule-${n}`),
    dirLevel,
  }
  return { root, src, dst, t, done: () => rmSync(root, { recursive: true, force: true }) }
}
const write = (p, s) => writeFileSync(p, s)
const names = (d) => readdirSync(d).sort()
const dirSnapshot = (d) => names(d).map((n) => `${n}:${lstatSync(join(d, n)).size}`).join('|')
const tmpRoot = (prefix) => mkdtempSync(join(tmpdir(), prefix))

// ─────────────────────────────────────────────
// 体检（只读）
// ─────────────────────────────────────────────
test('体检：源里有、运行时没有 → 报「需建链接」，且一个字都不改', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    const before = dirSnapshot(f.dst)
    const r = inspect(f.t)
    assert.equal(r.needLink.length, 1)
    assert.equal(r.needLink[0].dstName, 'rule-a.md')
    assert.equal(r.ok.length, 0)
    assert.equal(dirSnapshot(f.dst), before, '体检不应改动运行时')
  } finally { f.done() }
})

test('体检：已是正确链接 → 报「已就位」', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    symlinkSync(join(f.src, 'a.md'), join(f.dst, 'rule-a.md'), 'file')
    const r = inspect(f.t)
    assert.equal(r.ok.length, 1)
    assert.equal(r.needLink.length, 0)
    assert.equal(r.wrong.length, 0)
  } finally { f.done() }
})

test('体检：真实副本且内容不同 → 报「需替换」', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-a.md'), 'OLD')
    const r = inspect(f.t)
    assert.equal(r.wrong.length, 1)
    assert.match(r.wrong[0].why, /过时/)
  } finally { f.done() }
})

test('体检：旧名残留（内容与源一致的真实文件）→ 报「待迁移」，并指出将换成哪个新名', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-1700000000000.md'), 'AAA')
    const r = inspect(f.t)
    assert.equal(r.legacy.length, 1)
    assert.equal(r.legacy[0].dstName, 'rule-a.md')
    assert.equal(r.orphans.length, 0)
  } finally { f.done() }
})

test('体检：源目录不存在 → 抛错（不能静默当"无事发生"）', () => {
  const f = fixture()
  try {
    rmSync(f.src, { recursive: true, force: true })
    assert.throws(() => inspect(f.t), /源目录不存在/)
  } finally { f.done() }
})

test('体检：我们自己留下的失效链接 → 归「staleSelf(待清理)」，不算孤儿', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    // 一条指向"源目录内已不存在的文件"的链接 —— 是我们自己的残留
    symlinkSync(join(f.src, 'gone.md'), join(f.dst, 'rule-gone.md'), 'file')
    const r = inspect(f.t)
    assert.equal(r.staleSelf.length, 1, '应识别为自己的残留')
    assert.equal(r.orphans.length, 0, '不能当成"用户资产"保护起来')
  } finally { f.done() }
})

test('体检：无关目录 → 报「孤儿」，不会被误伤', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    mkdirSync(join(f.dst, 'some-other-tool'))
    const r = inspect(f.t)
    assert.equal(r.orphans.length, 1)
    assert.equal(r.orphans[0].name, 'some-other-tool')
    applyOne(r, { replace: true, rmOld: true })
    assert.ok(names(f.dst).includes('some-other-tool'), '孤儿必须原样保留')
  } finally { f.done() }
})

// ─────────────────────────────────────────────
// 执行（--apply 的语义）
// ─────────────────────────────────────────────
test('apply：缺失的建链接', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    const r = inspect(f.t)
    applyOne(r, {})
    assert.equal(readFileSync(join(f.dst, 'rule-a.md'), 'utf8'), 'AAA')
    const r2 = inspect(f.t)
    assert.equal(r2.ok.length, 1)
    assert.equal(r2.needLink.length, 0)
  } finally { f.done() }
})

test('apply 不带 replace：**不删**真实副本，也不建链接（安全默认）', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-a.md'), 'OLD')
    const r = inspect(f.t)
    applyOne(r, {})
    assert.equal(readFileSync(join(f.dst, 'rule-a.md'), 'utf8'), 'OLD', '真实副本必须原样保留')
  } finally { f.done() }
})

test('apply 带 replace：真实副本换成链接', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-a.md'), 'OLD')
    const r = inspect(f.t)
    applyOne(r, { replace: true })
    assert.equal(readFileSync(join(f.dst, 'rule-a.md'), 'utf8'), 'AAA', '应指向源内容')
    assert.equal(inspect(f.t).ok.length, 1)
  } finally { f.done() }
})

test('apply 不带 rm-old：旧名残留保留', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-1700000000000.md'), 'AAA')
    const r = inspect(f.t)
    applyOne(r, {})
    assert.ok(names(f.dst).includes('rule-1700000000000.md'), '旧名不应被删')
  } finally { f.done() }
})

test('apply 带 rm-old：旧名残留被删，新名就位', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.dst, 'rule-1700000000000.md'), 'AAA')
    const r = inspect(f.t)
    applyOne(r, { rmOld: true })
    assert.ok(!names(f.dst).includes('rule-1700000000000.md'), '旧名应被删')
    assert.equal(readFileSync(join(f.dst, 'rule-a.md'), 'utf8'), 'AAA')
  } finally { f.done() }
})

test('幂等：连续 apply 两次，第二次无事可做且状态不变', () => {
  const f = fixture()
  try {
    write(join(f.src, 'a.md'), 'AAA')
    write(join(f.src, 'b.md'), 'BBB')
    applyOne(inspect(f.t), {})
    const after1 = dirSnapshot(f.dst)
    const r2 = inspect(f.t)
    assert.equal(r2.ok.length, 2)
    assert.equal(r2.needLink.length + r2.wrong.length + r2.legacy.length, 0)
    applyOne(r2, {})
    assert.equal(dirSnapshot(f.dst), after1, '第二次 apply 不应改变任何东西')
  } finally { f.done() }
})

// ─────────────────────────────────────────────
// 目录级目标（技能那侧用 junction）
// ─────────────────────────────────────────────
test('目录级：建链接并可通过它读到源里的文件（幂等）', () => {
  const f = fixture({ dirLevel: true })
  try {
    mkdirSync(join(f.src, 'skill-a'))
    write(join(f.src, 'skill-a', 'SKILL.md'), '# hi')
    const r = inspect(f.t)
    assert.equal(r.needLink.length, 1)
    assert.equal(r.needLink[0].dstName, 'skill-a')
    applyOne(r, {})
    assert.equal(readFileSync(join(f.dst, 'skill-a', 'SKILL.md'), 'utf8'), '# hi')
    const r2 = inspect(f.t)
    assert.equal(r2.ok.length, 1)
    assert.equal(r2.needLink.length, 0)
    applyOne(r2, {})
    assert.equal(inspect(f.t).ok.length, 1)
  } finally { f.done() }
})

// ─────────────────────────────────────────────
// CLI 参数解析（纯函数，R33：给参数解析补测试）
// ─────────────────────────────────────────────
test('parseArgs：无参数 → 体检模式，三个"会删东西"的开关默认全关', () => {
  const a = parseArgs([])
  assert.equal(a.command, 'sync')
  assert.equal(a.apply, false)
  assert.equal(a.replace, false)
  assert.equal(a.rmOld, false)
  assert.equal(a.help, false)
  assert.equal(a.configPath, null)
  assert.equal(a.error, null)
})

test('parseArgs：三个开关各自可被识别', () => {
  assert.equal(parseArgs(['--apply']).apply, true)
  assert.equal(parseArgs(['--replace']).replace, true)
  assert.equal(parseArgs(['--rm-old']).rmOld, true)
  const all = parseArgs(['--apply', '--replace', '--rm-old'])
  assert.deepEqual([all.apply, all.replace, all.rmOld], [true, true, true])
})

test('parseArgs：--help / -h → help 打开', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('parseArgs：list → 走 list 命令', () => {
  assert.equal(parseArgs(['list']).command, 'list')
  assert.equal(parseArgs(['--apply', 'list']).command, 'list')
  assert.equal(parseArgs(['not-a-command']).command, 'sync', '未知位置参数不改变命令')
})

test('parseArgs：--config <路径> 与 --config=<路径> 两种写法都认，且路径不被当成位置参数', () => {
  const a = parseArgs(['--config', 'C:/x/sync.config.json', 'list'])
  assert.equal(a.configPath, 'C:/x/sync.config.json')
  assert.equal(a.command, 'list', '路径值被吃掉后，list 才是位置参数')
  const b = parseArgs(['--config=C:/y/sync.config.json'])
  assert.equal(b.configPath, 'C:/y/sync.config.json')
  assert.equal(b.error, null)
})

test('parseArgs：--config 缺值 / 后跟另一个选项 → 报错，不静默', () => {
  assert.match(parseArgs(['--config']).error, /--config/)
  assert.match(parseArgs(['--config', '--apply']).error, /--config/)
  assert.match(parseArgs(['--config=']).error, /--config/)
})

// ─────────────────────────────────────────────
// 配置 → TARGETS（配置驱动，见 docs/design.md）
// ─────────────────────────────────────────────
test('配置：dstName 模板把 {name} 换成源文件名；level 决定 dirLevel', () => {
  const ts = buildTargets({
    targets: [{ label: 'r', srcDir: 'C:/s', dstDir: 'C:/d', dstName: 'rule-{name}', level: 'file' }],
  })
  assert.equal(ts[0].dstName('a.md'), 'rule-a.md')
  assert.equal(ts[0].dirLevel, false)

  const ts2 = buildTargets({
    targets: [{ label: 'k', srcDir: 'C:/s', dstDir: 'C:/d', dstName: '{name}', level: 'dir' }],
  })
  assert.equal(ts2[0].dstName('skill-a'), 'skill-a')
  assert.equal(ts2[0].dirLevel, true)
})

test('配置：开头的 ~ 展开到 home', () => {
  const ts = buildTargets(
    { targets: [{ label: 'r', srcDir: '~/src', dstDir: '~/.trae-cn/user_rules', dstName: '{name}', level: 'file' }] },
    { home: 'C:/home/x' },
  )
  assert.equal(ts[0].srcDir, resolve('C:/home/x/src'))
  assert.equal(ts[0].dstDir, resolve('C:/home/x/.trae-cn/user_rules'))
})

test('配置：env 指定的环境变量覆盖路径；空值不算覆盖', () => {
  const cfg = {
    targets: [{
      label: 'r', srcDir: 'C:/default', dstDir: 'C:/d', dstName: '{name}', level: 'file',
      env: { srcDir: 'RETRO_SKILLS_RULES' },
    }],
  }
  assert.equal(buildTargets(cfg, { env: { RETRO_SKILLS_RULES: 'C:/override' } })[0].srcDir, resolve('C:/override'))
  assert.equal(buildTargets(cfg, { env: { RETRO_SKILLS_RULES: '   ' } })[0].srcDir, resolve('C:/default'), '空白不算覆盖')
  assert.equal(buildTargets(cfg, { env: {} })[0].srcDir, resolve('C:/default'), '未设置时用配置里的值')
})

test('配置：形状不对就报错（缺 targets / 缺 srcDir / dstName 无 {name} / level 非法）', () => {
  assert.throws(() => buildTargets({}), /targets/)
  assert.throws(() => buildTargets({ targets: [] }), /targets/)
  assert.throws(
    () => buildTargets({ targets: [{ label: 'r', dstDir: 'C:/d', dstName: '{name}', level: 'file' }] }),
    /srcDir/,
  )
  assert.throws(
    () => buildTargets({ targets: [{ label: 'r', srcDir: 'C:/s', dstDir: 'C:/d', dstName: 'fixed.md', level: 'file' }] }),
    /\{name\}/,
  )
  assert.throws(
    () => buildTargets({ targets: [{ label: 'r', srcDir: 'C:/s', dstDir: 'C:/d', dstName: '{name}', level: 'dunno' }] }),
    /level/,
  )
})

test('配置：能读带 BOM 的 JSON（PowerShell 写文件容易带，会让 JSON.parse 报错）', () => {
  const root = tmpRoot('sync-cfg-')
  try {
    const p = join(root, 'sync.config.json')
    writeFileSync(p, '\uFEFF' + JSON.stringify({ targets: [] }))
    assert.deepEqual(loadConfig(p), { targets: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('配置：文件不存在 / JSON 损坏 → 抛错并说明原因', () => {
  const root = tmpRoot('sync-cfg-')
  try {
    assert.throws(() => loadConfig(join(root, 'nope.json')), /不存在/)
    const bad = join(root, 'bad.json')
    writeFileSync(bad, '{ not json')
    assert.throws(() => loadConfig(bad), /不是合法 JSON/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('isDirectRun：经 junction 安装目录启动 → 仍判为"直接执行"（否则 CLI 静默不执行）', () => {
  const real = mkdtempSync(join(tmpdir(), 'sync-real-'))
  const linkRoot = mkdtempSync(join(tmpdir(), 'sync-link-'))
  try {
    const realFile = join(real, 'mod.mjs')
    writeFileSync(realFile, '// x', 'utf8')
    const linkDir = join(linkRoot, 'mod-link')
    symlinkSync(real, linkDir, 'junction') // junction 不需要开发者模式
    assert.equal(isDirectRun(join(linkDir, 'mod.mjs'), pathToFileURL(realFile).href), true, '经 junction 进入应算直接执行')
    assert.equal(isDirectRun(realFile, pathToFileURL(realFile).href), true, '真实路径也应算')
    assert.equal(isDirectRun(join(real, 'other.mjs'), pathToFileURL(realFile).href), false, '别的文件不算')
    assert.equal(isDirectRun(undefined, pathToFileURL(realFile).href), false, '拿不到入口路径时不算')
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(linkRoot, { recursive: true, force: true })
  }
})
