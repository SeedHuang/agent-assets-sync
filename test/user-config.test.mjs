/** user-config.mjs 的测试：读写 / 形状校验 / 原子写 .bak */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadUserConfig, writeUserConfig, userConfigPath,
  validateUserConfigShape, setUserValue, USER_CONFIG_SCHEMA_VERSION,
} from '../src/user-config.mjs'

const tempHome = () => {
  const root = mkdtempSync(join(tmpdir(), 'uc-'))
  const home = join(root, 'h')
  mkdirSync(home, { recursive: true })
  return { root, home, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('loadUserConfig：文件不存在 → {}（首次使用不是错误）', () => {
  const f = tempHome()
  try { assert.deepEqual(loadUserConfig({ home: f.home }), {}) } finally { f.done() }
})

test('writeUserConfig + loadUserConfig：往返 + 覆盖留 .bak', () => {
  const f = tempHome()
  try {
    writeUserConfig({ schemaVersion: 1, repoRoot: 'D:/repo', editor: 'trae' }, { home: f.home })
    assert.deepEqual(loadUserConfig({ home: f.home }), { schemaVersion: 1, repoRoot: 'D:/repo', editor: 'trae' })
    writeUserConfig({ schemaVersion: 1, repoRoot: 'D:/repo2' }, { home: f.home })
    assert.equal(loadUserConfig({ home: f.home }).repoRoot, 'D:/repo2')
    assert.ok(existsSync(`${userConfigPath({ home: f.home })}.bak`))
  } finally { f.done() }
})

test('loadUserConfig：损坏 → 抛错并指路 .bak', () => {
  const f = tempHome()
  try {
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(userConfigPath({ home: f.home }), '{ broken', 'utf8')
    assert.throws(() => loadUserConfig({ home: f.home }), /用户配置损坏[\s\S]*\.bak/)
  } finally { f.done() }
})

test('validateUserConfigShape：非法类型 / 空串 / schemaVersion 报错；合法通过', () => {
  assert.throws(() => validateUserConfigShape({ repoRoot: 3 }), /repoRoot 应为非空字符串/)
  assert.throws(() => validateUserConfigShape({ editor: '' }), /editor 应为非空字符串/)
  assert.throws(() => validateUserConfigShape({ editor: '   ' }), /editor 应为非空字符串/, '空白串也算无效')
  assert.throws(() => validateUserConfigShape({ schemaVersion: 9 }), /schemaVersion=9/)
  validateUserConfigShape({ schemaVersion: 1, repoRoot: 'D:/x' })
})

test('validateUserConfigShape：未知键被拒绝（防手改加的键经合并静默覆盖骨架）', () => {
  assert.throws(() => validateUserConfigShape({ linkTargts: [] }), /未知键：linkTargts/)
  // 预留扩展键（可覆盖骨架的位）放行，但类型要正确——错误类型（如 skills: null）会经合并静默清空骨架
  validateUserConfigShape({ sources: {}, skills: {}, editors: {}, linkTargets: [] })
  assert.throws(() => validateUserConfigShape({ skills: null }), /skills 应为对象/)
  assert.throws(() => validateUserConfigShape({ linkTargets: {} }), /linkTargets 应为数组/)
})

test('setUserValue：补 schemaVersion + 保留已有键', () => {
  const f = tempHome()
  try {
    setUserValue('repoRoot', 'D:/r', { home: f.home })
    setUserValue('editor', 'trae', { home: f.home })
    const d = loadUserConfig({ home: f.home })
    assert.equal(d.schemaVersion, USER_CONFIG_SCHEMA_VERSION)
    assert.equal(d.repoRoot, 'D:/r')
    assert.equal(d.editor, 'trae')
  } finally { f.done() }
})

test('setUserValue：宽容读——清掉未知键（config set 是修复路径）', () => {
  const f = tempHome()
  try {
    const p = userConfigPath({ home: f.home })
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(p, JSON.stringify({ repo_root: 'D:/typo', repoRoot: 'D:/old' }), 'utf8')
    setUserValue('repoRoot', 'D:/new', { home: f.home })
    const d = loadUserConfig({ home: f.home })
    assert.equal(d.repoRoot, 'D:/new')
    assert.equal(d.repo_root, undefined, '未知键应被清掉')
  } finally { f.done() }
})

test('setUserValue：版本总是归一——未来版本(2)的文件也能被修复', () => {
  const f = tempHome()
  try {
    const p = userConfigPath({ home: f.home })
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(p, JSON.stringify({ schemaVersion: 2, repoRoot: 'D:/old' }), 'utf8')
    setUserValue('repoRoot', 'D:/new', { home: f.home })
    const d = loadUserConfig({ home: f.home })
    assert.equal(d.schemaVersion, USER_CONFIG_SCHEMA_VERSION)
    assert.equal(d.repoRoot, 'D:/new')
  } finally { f.done() }
})

test('setUserValue：未知键被拒绝（防 __proto__ 命中原型 setter）', () => {
  const f = tempHome()
  try {
    assert.throws(() => setUserValue('__proto__', { x: 1 }, { home: f.home }), /未知配置键/)
  } finally { f.done() }
})

test('setUserValue：形状非法的已知键也被清掉（修复路径不因残留坏值死锁）', () => {
  const f = tempHome()
  try {
    const p = userConfigPath({ home: f.home })
    mkdirSync(join(f.home, '.aas'), { recursive: true })
    writeFileSync(p, JSON.stringify({ repoRoot: '', skills: null }), 'utf8')
    setUserValue('editor', 'trae', { home: f.home })
    const d = loadUserConfig({ home: f.home })
    assert.equal(d.repoRoot, undefined, '非法 repoRoot 应被清掉')
    assert.equal(d.skills, undefined, '非法 skills 应被清掉')
    assert.equal(d.editor, 'trae')
  } finally { f.done() }
})
