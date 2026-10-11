/** config.mjs 的测试：新格式 / 旧格式归一 + schemaVersion 校验 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig, mergeConfigs, derivePaths, resolveConfig, expandHome, requireAbsoluteSrcDir } from '../src/config.mjs'

/** 平台无关的绝对路径（C:/ 在 POSIX 不是绝对路径，会让 derivePaths 的 repoRoot 校验误报） */
const ABS = (p) => join(process.cwd(), p)

const LEGACY = {
  targets: [{ label: 'r', srcDir: 'C:/s', dstDir: 'C:/d', dstName: 'rule-{name}', level: 'file' }],
}
const NEW = {
  schemaVersion: 1,
  editors: { 'fake-ed': { detect: ['C:/nope'], rules: { dir: 'C:/d', nameTemplate: 'rule-{name}', level: 'file' } } },
  sources: { myrules: 'https://github.com/x/y' },
  linkTargets: LEGACY.targets,
}

test('旧格式（只有 targets）→ editors/sources 为空对象，targets 原样透传', () => {
  const c = normalizeConfig(LEGACY)
  assert.equal(c.schemaVersion, 1)
  assert.deepEqual(c.editors, {})
  assert.deepEqual(c.sources, {})
  assert.deepEqual(c.targets, LEGACY.targets)
})

test('新格式（linkTargets）→ targets 取自 linkTargets，editors/sources 透传', () => {
  const c = normalizeConfig(NEW)
  assert.deepEqual(c.targets, NEW.linkTargets)
  assert.deepEqual(c.editors, NEW.editors)
  assert.deepEqual(c.sources, NEW.sources)
})

test('schemaVersion 不支持 → 报错', () => {
  assert.throws(() => normalizeConfig({ ...NEW, schemaVersion: 2 }), /schemaVersion=2 不受支持/)
})

test('既无 targets 也无 linkTargets → 报错', () => {
  assert.throws(() => normalizeConfig({ schemaVersion: 1 }), /targets\/linkTargets/)
})

test('新格式允许空 linkTargets（只用安装形态的场景）', () => {
  const c = normalizeConfig({ schemaVersion: 1, editors: {}, sources: {}, linkTargets: [] })
  assert.deepEqual(c.targets, [])
})

test('非对象 / 数组 → 报错', () => {
  assert.throws(() => normalizeConfig(null), /不是对象/)
  assert.throws(() => normalizeConfig([]), /不是对象/)
})

test('skills 目录：归一化返回', () => {
  const raw = {
    schemaVersion: 1, editors: {}, sources: {},
    linkTargets: [],
    skills: { 'multi-lens-review': { source: 'https://github.com/seedhuang/retro-skills.git', localPath: 'D:/Seed/retro-skills' } },
  }
  const c = normalizeConfig(raw)
  assert.equal(c.skills['multi-lens-review'].source, 'https://github.com/seedhuang/retro-skills.git')
})

test('skills 条目缺 source → 报错（B4）', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 1, editors: {}, sources: {}, linkTargets: [],
    skills: { bad: { localPath: 'D:/x' } },
  }), /skills 条目缺 source：bad/)
})

test('skills 条目 localPath 非字符串 → 报错（拦在写回前，与 derivePaths 一致）', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 1, editors: {}, sources: {}, linkTargets: [],
    skills: { bad: { source: 'https://x', localPath: 3 } },
  }), /skills 条目 localPath 应为字符串：bad/)
  // undefined/null 合法：derivePaths 会给它们补 repoRoot
  const c = normalizeConfig({
    schemaVersion: 1, editors: {}, sources: {}, linkTargets: [],
    skills: { a: { source: 'https://x', localPath: undefined }, b: { source: 'https://y', localPath: null } },
  })
  assert.equal(c.skills.a.localPath, undefined)
  assert.equal(c.skills.b.localPath, null)
})

test('skills 非对象 → 报错', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 1, editors: {}, sources: {}, linkTargets: [], skills: [],
  }), /skills 应为对象/)
})

test('normalizeConfig：repoRoot/editor 透传；类型错报错', () => {
  const c = normalizeConfig({ schemaVersion: 1, editors: {}, sources: {}, linkTargets: [], repoRoot: 'D:/x', editor: 'trae' })
  assert.equal(c.repoRoot, 'D:/x')
  assert.equal(c.editor, 'trae')
  const d = normalizeConfig({ schemaVersion: 1, editors: {}, sources: {}, linkTargets: [] })
  assert.equal(d.repoRoot, null)
  assert.equal(d.editor, null)
  assert.throws(() => normalizeConfig({ schemaVersion: 1, editors: {}, sources: {}, linkTargets: [], repoRoot: 3 }), /repoRoot 应为字符串/)
  assert.throws(() => normalizeConfig({ schemaVersion: 1, editors: {}, sources: {}, linkTargets: [], editor: {} }), /editor 应为字符串/)
})

test('expandHome：~ 与 ~/ 展开到 home，其余原样', () => {
  assert.equal(expandHome('~', 'C:/h'), 'C:/h')
  // 用 join 镜像实现，别用 resolve——resolve('C:/h/x') 在 POSIX 会被当相对路径拼上 cwd，跨平台翻车
  assert.equal(expandHome('~/x', 'C:/h'), join('C:/h', 'x'))
  assert.equal(expandHome('~\\x', 'C:/h'), join('C:/h', 'x'))
  assert.equal(expandHome('C:/abs', 'C:/h'), 'C:/abs')
})

test('mergeConfigs：标量覆盖 / 对象深合并 / 数组替换 / undefined 跳过', () => {
  const base = { a: 1, b: { x: 1, y: 2 }, arr: [1, 2], keep: 'k' }
  const user = { a: 9, b: { y: 20, z: 30 }, arr: [3], keep: undefined }
  const m = mergeConfigs(base, user)
  assert.equal(m.a, 9)
  assert.deepEqual(m.b, { x: 1, y: 20, z: 30 })
  assert.deepEqual(m.arr, [3])
  assert.equal(m.keep, 'k', 'user 的 undefined 应被跳过而不是覆盖 base 的值')
})

test('mergeConfigs：__proto__ / constructor / prototype 键被跳过（防原型污染）', () => {
  // JSON.parse 会把 __proto__ 解析成自有属性，直接赋值会命中 Object.prototype 的 setter 改原型
  const user = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "prototype": {"y": 1}, "repoRoot": "C:/r"}')
  const m = mergeConfigs({ schemaVersion: 1 }, user)
  assert.equal(m.polluted, undefined, '原型不应被污染')
  assert.equal(Object.getPrototypeOf(m), Object.prototype)
  assert.equal(Object.hasOwn(m, 'constructor'), false, 'constructor 键应被跳过')
  assert.equal(Object.hasOwn(m, 'prototype'), false, 'prototype 键应被跳过')
  assert.equal(m.repoRoot, 'C:/r')
})

test('derivePaths：repoRoot 推导 linkTargets 的相对 srcDir 与 skills 缺省的 localPath；绝对路径不动', () => {
  const ABS_SRC = ABS('abs')
  const ABS_LP = ABS('mine')
  const cfg = {
    repoRoot: ABS('Seed/retro-skills'),
    linkTargets: [
      { label: 'r', srcDir: 'rules', dstDir: 'C:/d', dstName: '{name}', level: 'file' },
      { label: 'abs', srcDir: ABS_SRC, dstDir: 'C:/d', dstName: '{name}', level: 'file' },
    ],
    skills: { a: { source: 'https://x' }, b: { source: 'https://y', localPath: ABS_LP } },
  }
  const d = derivePaths(cfg, { home: 'C:/h' })
  assert.ok(d.linkTargets[0].srcDir.includes('retro-skills\\rules') || d.linkTargets[0].srcDir.includes('retro-skills/rules'))
  assert.equal(d.linkTargets[1].srcDir, ABS_SRC)
  assert.ok(d.skills.a.localPath.includes('retro-skills'))
  assert.equal(d.skills.b.localPath, ABS_LP)
})

test('derivePaths：无 repoRoot → 原样返回', () => {
  const cfg = { linkTargets: [{ srcDir: 'rules' }], skills: { a: { source: 'x' } } }
  assert.deepEqual(derivePaths(cfg), cfg)
})

test('derivePaths：相对 repoRoot → 报错（别静默 resolve 到 cwd）；非字符串 localPath → 报错（别静默重定向到仓库根）', () => {
  assert.throws(
    () => derivePaths({ repoRoot: 'relative/repo', linkTargets: [] }, { home: 'C:/h' }),
    /repoRoot 是相对路径/,
  )
  assert.throws(
    () => derivePaths({ repoRoot: ABS('r'), skills: { a: { source: 'x', localPath: 3 } } }, { home: 'C:/h' }),
    /localPath 应为字符串/,
  )
})

test('resolveConfig：骨架 + 用户配置 → 合并 + 推导 + 归一一体', () => {
  const base = {
    schemaVersion: 1,
    editors: { trae: { detect: ['C:/t'], rules: { dir: 'C:/d', nameTemplate: 'rule-{name}', level: 'file' }, skills: { dir: 'C:/s', nameTemplate: '{name}', level: 'dir' } } },
    sources: {},
    linkTargets: [{ label: '规则', srcDir: 'rules', dstDir: 'C:/d', dstName: 'rule-{name}', level: 'file', editor: 'trae' }],
    skills: { retro: { source: 'https://github.com/x/y.git' } },
  }
  const user = { schemaVersion: 1, repoRoot: ABS('repo'), editor: 'trae' }
  const c = resolveConfig({ base, user, home: 'C:/h' })
  assert.equal(c.repoRoot, ABS('repo'))
  assert.equal(c.editor, 'trae')
  assert.ok(c.targets[0].srcDir.includes('repo\\rules') || c.targets[0].srcDir.includes('repo/rules'))
  assert.ok(c.skills.retro.localPath.includes('repo'))
})

test('requireAbsoluteSrcDir：相对 srcDir（缺 repoRoot）→ 报错指路 config init；绝对路径 / ~ 放行', () => {
  // 用当前平台上确实绝对的路径（C:/ 在 POSIX 不是绝对路径，会让用例跨平台翻车）
  const ABS_HOME = process.cwd()
  const ABS_SRC = join(ABS_HOME, 'src')
  const ABS_ENV = join(ABS_HOME, 'env')
  assert.throws(
    () => requireAbsoluteSrcDir([{ label: 'r', srcDir: 'rules' }], { home: ABS_HOME }),
    /相对路径.*repoRoot/,
  )
  // ~ 展开后是绝对路径 → 放行；绝对路径 → 放行
  requireAbsoluteSrcDir([{ label: 'r', srcDir: '~/x' }], { home: ABS_HOME })
  requireAbsoluteSrcDir([{ label: 'r', srcDir: ABS_SRC }], { home: ABS_HOME })
  // 空 / 非对象条目不炸
  requireAbsoluteSrcDir([], { home: ABS_HOME })
  requireAbsoluteSrcDir([null], { home: ABS_HOME })
  // env srcDir 提供绝对路径 → 即使 repoRoot 未配也放行（env 优先级最高，别误杀 env-only 用法）
  requireAbsoluteSrcDir(
    [{ label: 'r', srcDir: 'rules', env: { srcDir: 'ENV_SRC' } }],
    { home: ABS_HOME, env: { ENV_SRC: ABS_ENV } },
  )
  // env 变量空白不算覆盖 → 仍按相对 srcDir 报错
  assert.throws(
    () => requireAbsoluteSrcDir(
      [{ label: 'r', srcDir: 'rules', env: { srcDir: 'ENV_SRC' } }],
      { home: ABS_HOME, env: { ENV_SRC: '   ' } },
    ),
    /相对路径.*repoRoot/,
  )
  // filter：只校验满足条件的 target（无关 target 的相对 srcDir 不误杀）
  requireAbsoluteSrcDir(
    [
      { label: 'irrelevant', srcDir: 'rules', dstDir: 'C:/other', dstName: '{name}' },
      { label: 'relevant', srcDir: ABS_SRC, dstDir: 'C:/d', dstName: '{name}' },
    ],
    { home: ABS_HOME, filter: (t) => t.dstDir === 'C:/d' },
  )
})

test('resolveConfig：用户配置的 schemaVersion 不覆盖骨架的（两个命名空间，合并时剥掉）', () => {
  const base = { schemaVersion: 1, editors: {}, sources: {}, linkTargets: [] }
  const user = { schemaVersion: 2, repoRoot: ABS('r') }
  const c = resolveConfig({ base, user, home: 'C:/h' })
  assert.equal(c.schemaVersion, 1)
  assert.equal(c.repoRoot, ABS('r'))
})

test('resolveConfig：user 传非对象（null）→ 不裸抛 TypeError', () => {
  const base = { schemaVersion: 1, editors: {}, sources: {}, linkTargets: [] }
  const c = resolveConfig({ base, user: null, home: 'C:/h' })
  assert.equal(c.schemaVersion, 1)
})
