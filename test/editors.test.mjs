/** editors.mjs 的测试：检测 / 挑选 / 名称映射 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectEditors, pickEditor, resolveRuntimeName, resolveEditorDir, editorLevel, describeEditors } from '../src/editors.mjs'

const ED = (rulesDir, skillsDir) => ({
  detect: [rulesDir],
  rules: { dir: rulesDir, nameTemplate: 'rule-{name}', level: 'file' },
  skills: { dir: skillsDir, nameTemplate: '{name}', level: 'dir' },
})

test('detectEditors：命中 / 零命中 / 多命中', () => {
  const real = mkdtempSync(join(tmpdir(), 'ed-'))
  try {
    const cfg = {
      editors: {
        hit: ED(real, join(real, 's')),
        miss: ED(join(real, 'nope'), join(real, 'nope2')),
      },
    }
    assert.deepEqual(detectEditors(cfg, {}).map((h) => h.name), ['hit'])

    const cfg2 = { editors: { a: ED(real, real), b: ED(real, real) } }
    assert.equal(detectEditors(cfg2, {}).length, 2)

    const cfg3 = { editors: { miss: ED(join(real, 'nope'), join(real, 'x')) } }
    assert.equal(detectEditors(cfg3, {}).length, 0)
  } finally { rmSync(real, { recursive: true, force: true }) }
})

test('pickEditor：显式存在 → 返回；显式未知 → 报错带可选值；未给 + 恰好一个 → 自动选；未给 + 多个 → needChoice', () => {
  const cfg = { editors: { ed1: ED('C:/d1', 'C:/d1'), ed2: ED('C:/d2', 'C:/d2') } }
  assert.equal(pickEditor(cfg, { editor: 'ed2', exists: () => false }).name, 'ed2')
  assert.throws(() => pickEditor(cfg, { editor: 'nope', exists: () => false }), /可选：ed1、ed2/)

  const one = { editors: { only: ED('C:/real', 'C:/real') } }
  assert.equal(pickEditor(one, { exists: () => true }).name, 'only')

  const zero = { editors: { only: ED('C:/real', 'C:/real') } }
  const r0 = pickEditor(zero, { exists: () => false })
  assert.equal(r0.needChoice, true)
  assert.match(r0.message, /没有编辑器命中/)

  const r2 = pickEditor(cfg, { exists: () => true })
  assert.equal(r2.needChoice, true)
  assert.match(r2.message, /命中多个/)
})

test('resolveRuntimeName：规则模板 / 技能模板 / 缺段报错', () => {
  const ed = ED('C:/d1', 'C:/d2')
  assert.equal(resolveRuntimeName(ed, 'rule', 'code-style.md'), 'rule-code-style.md')
  assert.equal(resolveRuntimeName(ed, 'skill', 'skill-a'), 'skill-a')
  assert.throws(() => resolveRuntimeName({ rules: { dir: 'x', nameTemplate: 'fixed' } }, 'rule', 'a.md'), /nameTemplate/)
  assert.throws(() => resolveRuntimeName({}, 'skills2', 'a'), /缺 skills2 段/)
})

test('resolveEditorDir / editorLevel', () => {
  const ed = ED('~/user_rules', '~/skills')
  const home = 'C:/home/u'
  assert.ok(resolveEditorDir(ed, 'rule', { home }).startsWith('C:\\home\\u') || resolveEditorDir(ed, 'rule', { home }).startsWith('C:/home/u'))
  assert.equal(editorLevel(ed, 'rule'), 'file')
  assert.equal(editorLevel(ed, 'skill'), 'dir')
})

test('describeEditors：命中标 ✓，未命中标 ？，含 prereq', () => {
  const real = mkdtempSync(join(tmpdir(), 'ed2-'))
  try {
    mkdirSync(real, { recursive: true })
    const cfg = { editors: { hit: ED(real, real), miss: ED(join(real, 'no'), join(real, 'no2')) } }
    cfg.editors.hit.prereq = 'windows-dev-mode:rules'
    const out = describeEditors(cfg, {}).join('\n')
    assert.match(out, /✓ hit/)
    assert.match(out, /prereq: windows-dev-mode:rules/)
    assert.match(out, /？ miss/)
    assert.match(out, /规则 →/)
    assert.match(out, /技能 →/)
  } finally { rmSync(real, { recursive: true, force: true }) }
})
