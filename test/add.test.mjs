/** add.mjs / remove.mjs 的测试：源解析 / 缓存 / 资产清单 / 安装与记账 / 撞名 / 非交互守卫 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  parseSource, cacheKeyForSource, cloneToCache, listAssets, runAdd,
} from '../src/add.mjs'
import { runRemove } from '../src/remove.mjs'

// ── 夹具 ─────────────────────────────────────────────
function tmp(prefix = 'add-') { return mkdtempSync(join(tmpdir(), prefix)) }

/** 造一个带规则/技能/README 的源目录 */
function makeSourceDir(root) {
  writeFileSync(join(root, 'selftest.md'), 'SELFTEST CONTENT', 'utf8')
  writeFileSync(join(root, 'other.md'), 'OTHER', 'utf8')
  writeFileSync(join(root, 'README.md'), '# readme', 'utf8')
  mkdirSync(join(root, 'skill-a'), { recursive: true })
  writeFileSync(join(root, 'skill-a', 'SKILL.md'), '---\nname: skill-a\n---\nhi', 'utf8')
  return root
}

function makeHome() {
  const home = tmp('home-')
  mkdirSync(join(home, 'user_rules'), { recursive: true })
  return home
}

function makeConfig(home, { withLinkTarget = false } = {}) {
  return {
    schemaVersion: 1,
    editors: {
      fake: {
        detect: [join(home, 'user_rules')],
        rules: { dir: join(home, 'user_rules'), nameTemplate: 'rule-{name}', level: 'file' },
        skills: { dir: join(home, 'skills'), nameTemplate: '{name}', level: 'dir' },
      },
    },
    sources: { mysrc: 'https://github.com/owner/repo' },
    linkTargets: withLinkTarget
      ? [{ label: 'r', srcDir: join(home, 'my-src'), dstDir: join(home, 'user_rules'), dstName: 'rule-{name}', level: 'file' }]
      : [],
  }
}

const OPTS = (home, configPath, over = {}) => ({
  editor: 'fake', configPath, home, isTTY: false, env: {}, ...over,
})

async function addSelftest(home, configPath, srcDir, over = {}) {
  return runAdd({
    sourceSpec: srcDir,
    names: ['selftest'],
    opts: OPTS(home, configPath, over),
  })
}

// ── parseSource ──────────────────────────────────────
test('parseSource：URL / #ref / .git 剥离 / 短名 / 本地路径 / 无法识别', () => {
  const cfg = { sources: { mysrc: 'https://github.com/owner/repo.git' } }
  assert.deepEqual(parseSource('https://github.com/o/r', cfg), { url: 'https://github.com/o/r', ref: null, isLocal: false })
  assert.deepEqual(parseSource('https://github.com/o/r.git#dev', cfg), { url: 'https://github.com/o/r', ref: 'dev', isLocal: false })
  assert.equal(parseSource('mysrc', cfg).url, 'https://github.com/owner/repo')
  const dir = tmp()
  assert.equal(parseSource(dir, cfg).isLocal, true)
  assert.throws(() => parseSource('nope-not-exist', cfg), /无法识别源/)
})

test('cacheKeyForSource：同一来源稳定，不同来源不同', () => {
  const a = cacheKeyForSource('https://github.com/owner/repo', false)
  const b = cacheKeyForSource('https://github.com/owner/repo', false)
  const c = cacheKeyForSource('https://github.com/owner/other', false)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

// ── listAssets ───────────────────────────────────────
test('listAssets：规则（README 除外）+ 技能目录（不深入）', () => {
  const root = makeSourceDir(tmp())
  const assets = listAssets(root)
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]))
  assert.deepEqual(assets.map((a) => a.id).sort(), ['other', 'selftest', 'skill-a'])
  assert.equal(byId.selftest.kind, 'rule')
  assert.equal(byId['skill-a'].kind, 'skill')
  assert.ok(!assets.some((a) => a.id === 'README'), 'README 不算资产')
})

// ── cloneToCache ─────────────────────────────────────
test('cloneToCache：git 仓库（file:// URL）clone 出 commit；二次调用复用', () => {
  const repo = makeSourceDir(tmp('repo-'))
  const exec = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  exec(['init', '-b', 'main'], repo)
  exec(['add', '.'], repo)
  exec(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], repo)

  const home = makeHome()
  const r1 = cloneToCache({ url: pathToFileURL(repo).href, ref: null, isLocal: false }, { home })
  assert.ok(r1.commit && /^[0-9a-f]{40}$/.test(r1.commit), '应有 commit sha')
  assert.ok(existsSync(join(r1.cacheDir, 'selftest.md')))

  const r2 = cloneToCache({ url: pathToFileURL(repo).href, ref: null, isLocal: false }, { home })
  assert.equal(r2.cacheDir, r1.cacheDir)
  assert.equal(r2.reused, true)
})

// ── add 全流程（假编辑器，不碰真实运行时）─────────────
test('add：装一个规则 → 链接可读 + 账本 installed + 原名→运行时名映射', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')

  const lines = await addSelftest(home, cfgPath, srcDir)
  assert.ok(lines.some((l) => l.includes('→ 完成：新增 1、跳过 0')), lines.join('\n'))

  const runtime = join(home, 'user_rules', 'rule-selftest.md')
  assert.ok(existsSync(runtime), '运行时应可通过链接读到内容')
  assert.equal(readFileSync(runtime, 'utf8'), 'SELFTEST CONTENT')

  const { readLedger } = await import('../src/ledger.mjs')
  const l = readLedger(join(home, '.aas', 'installed.json'))
  assert.equal(l.entries.length, 1)
  const e = l.entries[0]
  assert.equal(e.id, 'selftest')
  assert.equal(e.status, 'installed')
  assert.equal(e.editor, 'fake')
  assert.equal(e.originalName, 'selftest.md')
  assert.equal(e.runtimeName, 'rule-selftest.md', '原名→运行时名映射必须记账')
  assert.equal(e.mode, 'link')
})

test('add：重复装（非 TTY 无 --yes）→ 默认跳过，内容与账本不变', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  await addSelftest(home, cfgPath, srcDir)
  const before = readFileSync(join(home, '.aas', 'installed.json'), 'utf8')

  const lines = await addSelftest(home, cfgPath, srcDir)
  assert.ok(lines.some((l) => l.includes('跳过')), lines.join('\n'))
  assert.equal(readFileSync(join(home, '.aas', 'installed.json'), 'utf8'), before)
})

test('add：重复装（非 TTY 带 --yes）→ 覆盖成功', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  await addSelftest(home, cfgPath, srcDir)
  const lines = await addSelftest(home, cfgPath, srcDir, { yes: true })
  assert.ok(lines.some((l) => l.includes('新增 1')), lines.join('\n'))
})

test('add：不给名且非 TTY → 报错并列出可选；给了不存在的名 → 报错', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  await assert.rejects(
    () => runAdd({ sourceSpec: srcDir, names: [], opts: OPTS(home, cfgPath) }),
    /非交互环境必须给出要装的资产名[\s\S]*selftest/,
  )
  await assert.rejects(
    () => runAdd({ sourceSpec: srcDir, names: ['nope'], opts: OPTS(home, cfgPath) }),
    /没有叫 "nope" 的资产/,
  )
})

test('add：运行时已有同名但账本无记录 → 拒绝并提示 import（手工放置不吞）', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  writeFileSync(join(home, 'user_rules', 'rule-selftest.md'), 'HAND MADE', 'utf8')
  await assert.rejects(
    () => addSelftest(home, cfgPath, srcDir),
    /账本无记录[\s\S]*aas import/,
  )
})

test('add：大小写撞名 → 拒绝（Windows 文件系统大小写不敏感）', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  mkdirSync(join(home, 'user_rules'), { recursive: true })
  writeFileSync(join(home, 'user_rules', 'Rule-Selftest.md'), 'x', 'utf8')
  await assert.rejects(() => addSelftest(home, cfgPath, srcDir), /大小写撞名/)
})

test('add：与链接形态撞名（targets 的 want 名单）→ 拒绝', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  mkdirSync(join(home, 'my-src'), { recursive: true })
  writeFileSync(join(home, 'my-src', 'selftest.md'), 'LINK FORM', 'utf8')
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home, { withLinkTarget: true })), 'utf8')
  await assert.rejects(() => addSelftest(home, cfgPath, srcDir), /已被链接形态占用/)
})

test('add：编辑器缺省 + 多命中 + 非 TTY → 报错提示 --editor', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfg = makeConfig(home)
  cfg.editors.second = JSON.parse(JSON.stringify(cfg.editors.fake))
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8')
  await assert.rejects(
    () => runAdd({ sourceSpec: srcDir, names: ['selftest'], opts: OPTS(home, cfgPath, { editor: undefined }) }),
    /命中多个编辑器[\s\S]*--editor/,
  )
})

// ── remove ───────────────────────────────────────────
test('remove：非 TTY 无 --yes → 报错（绝不静默删）；带 --yes → 摘除 + 销账', async () => {
  const home = makeHome()
  const srcDir = makeSourceDir(tmp())
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  await addSelftest(home, cfgPath, srcDir)

  const runtime = join(home, 'user_rules', 'rule-selftest.md')
  assert.ok(existsSync(runtime))

  await assert.rejects(
    () => runRemove({ id: 'selftest', opts: OPTS(home, cfgPath) }),
    /必须显式加 --yes/,
  )
  assert.ok(existsSync(runtime), '报错路径不应删东西')

  const lines = await runRemove({ id: 'selftest', opts: OPTS(home, cfgPath, { yes: true }) })
  assert.ok(lines.some((l) => l.includes('摘除')), lines.join('\n'))
  assert.ok(!existsSync(runtime), '运行时条目应被摘除')
  const { readLedger } = await import('../src/ledger.mjs')
  assert.equal(readLedger(join(home, '.aas', 'installed.json')).entries.length, 0, '账本应销账')
})

test('remove：账本里没有 → 报错并列出可选', async () => {
  const home = makeHome()
  const cfgPath = join(home, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(makeConfig(home)), 'utf8')
  await assert.rejects(
    () => runRemove({ id: 'ghost', opts: OPTS(home, cfgPath, { yes: true }) }),
    /账本是空的|可选：/,
  )
})
