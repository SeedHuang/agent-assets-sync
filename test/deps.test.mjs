import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readManifest, resolveSkillDeps } from '../src/deps.mjs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tmpManifestDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, 'skilldependencies'), { recursive: true })
    writeFileSync(join(dir, 'skilldependencies', name), content, 'utf8')
  }
  return join(dir, 'skilldependencies')
}

test('readManifest：合法清单解析 + skill 名', () => {
  const dir = tmpManifestDir({ 's.json': JSON.stringify({ schemaVersion: 1, skill: 's', dependencies: { skills: [{ name: 'b' }] } }) })
  const m = readManifest(join(dir, 's.json'))
  assert.equal(m.skill, 's')
  assert.equal(m.skills[0].name, 'b')
})

test('readManifest：schemaVersion 不支持 / 缺 skill → 报错', () => {
  const d1 = tmpManifestDir({ 'x.json': JSON.stringify({ schemaVersion: 2, skill: 'x' }) })
  assert.throws(() => readManifest(join(d1, 'x.json')), /schemaVersion=2 不受支持/)
  const d2 = tmpManifestDir({ 'y.json': JSON.stringify({ schemaVersion: 1 }) })
  assert.throws(() => readManifest(join(d2, 'y.json')), /缺 skill/)
})

test('resolveSkillDeps：BFS 递归 + visited 防环（A→B→A）', async () => {
  const mdir = tmpManifestDir({
    'a.json': JSON.stringify({ schemaVersion: 1, skill: 'a', dependencies: { skills: [{ name: 'b' }] } }),
    'b.json': JSON.stringify({ schemaVersion: 1, skill: 'b', dependencies: { skills: [{ name: 'a' }] } }),
  })
  const ensureSkill = (name, ctx) => ({ ok: true, action: 'installed', manifestDir: mdir })
  const ensureCli = () => ({ action: 'ok', name: '', detail: '' })
  const r = await resolveSkillDeps({ skill: 'a', rootManifestDir: mdir, rootSourceCtx: 'inherit', ensureSkill, ensureCli })
  assert.equal(r.installed.includes('b'), true)
  assert.equal(r.failures.length, 0)
})

test('resolveSkillDeps：B1 已存在非账本 → failures 记录，不中断', async () => {
  const mdir = tmpManifestDir({ 'a.json': JSON.stringify({ schemaVersion: 1, skill: 'a', dependencies: { skills: [{ name: 'b' }] } }) })
  const ensureSkill = () => ({ ok: false, error: '已存在但非 aas 管理：用 aas import 收编或手动移除' })
  const r = await resolveSkillDeps({ skill: 'a', rootManifestDir: mdir, rootSourceCtx: 'inherit', ensureSkill, ensureCli: () => ({ action: 'ok', name: '', detail: '' }) })
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0].detail, /已存在但非 aas 管理/)
})

test('resolveSkillDeps：cli 依赖汇总 updated / error', async () => {
  const mdir = tmpManifestDir({ 'a.json': JSON.stringify({ schemaVersion: 1, skill: 'a', dependencies: { cli: [{ name: 'prettier', versionSource: 'npm' }] } }) })
  const calls = []
  const ensureCli = (c) => { calls.push(c.name); return Promise.resolve({ action: 'updated', name: c.name, detail: '→ 2.0.0' }) }
  const r = await resolveSkillDeps({ skill: 'a', rootManifestDir: mdir, rootSourceCtx: 'inherit', ensureSkill: () => ({ ok: true, action: 'installed', manifestDir: mdir }), ensureCli })
  assert.equal(calls[0], 'prettier')
  assert.equal(r.cliUpdated.length, 1)
})
