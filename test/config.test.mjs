/** config.mjs 的测试：新格式 / 旧格式归一 + schemaVersion 校验 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.mjs'

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

test('skills 非对象 → 报错', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 1, editors: {}, sources: {}, linkTargets: [], skills: [],
  }), /skills 应为对象/)
})
