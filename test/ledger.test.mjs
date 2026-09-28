/** ledger.mjs 的测试：空账本 / 原子写 / .bak 滚动 / BOM / 损坏报错 / 体检拦截 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readLedger, writeLedger, findEntry, runtimePathsIndex, reclassifyWithLedger, defaultLedgerPath,
} from '../src/ledger.mjs'

function tmp() { return mkdtempSync(join(tmpdir(), 'ledger-')) }
const entry = (id, editor = 'ed', runtimePath = `~/user_rules/rule-${id}.md`) => ({
  id, kind: 'rule', status: 'installed', editor,
  originalName: `${id}.md`, runtimeName: `rule-${id}.md`,
  runtimePath, mode: 'link',
  source: { repo: 'x', ref: 'main', commit: 'a', path: `${id}.md`, fetchedAt: 't' },
  installedAt: 't',
})

test('账本文件不存在 → 空账本（首次使用不是错误）', () => {
  const root = tmp()
  const l = readLedger(join(root, 'nope.json'))
  assert.deepEqual(l, { schemaVersion: 1, entries: [] })
})

test('写 + 读往返；第二次写滚动 .bak（bak = 第一次内容）', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  writeLedger(p, { schemaVersion: 1, entries: [entry('a')] })
  const first = readFileSync(p, 'utf8')
  writeLedger(p, { schemaVersion: 1, entries: [entry('a'), entry('b')] })
  assert.equal(readFileSync(`${p}.bak`, 'utf8'), first, '.bak 应是上一次内容')
  const l = readLedger(p)
  assert.equal(l.entries.length, 2)
  assert.equal(findEntry(l, 'b', 'ed').id, 'b')
})

test('损坏 JSON → 报错并指路 .bak（不静默当空账本）', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  writeFileSync(p, '{ not json', 'utf8')
  assert.throws(() => readLedger(p), /账本损坏[\s\S]*\.bak/)
})

test('含 BOM 的账本 → 正常解析（PowerShell 写文件防御）', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  writeFileSync(p, '\uFEFF' + JSON.stringify({ schemaVersion: 1, entries: [] }), 'utf8')
  assert.doesNotThrow(() => readLedger(p))
})

test('schemaVersion 不支持 / 缺 entries / 条目缺字段 → 报错', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  for (const bad of [
    { schemaVersion: 9, entries: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, entries: [{ id: 'x' }] },
  ]) {
    writeFileSync(p, JSON.stringify(bad), 'utf8')
    assert.throws(() => readLedger(p), /账本不合法/)
  }
})

test('runtimePathsIndex：~ 展开并 resolve 成绝对路径集合', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  writeLedger(p, { schemaVersion: 1, entries: [entry('a'), entry('b')] })
  const set = runtimePathsIndex(readLedger(p))
  assert.equal(set.size, 2)
  assert.ok([...set].every((x) => !x.startsWith('~')))
})

test('reclassifyWithLedger：命中账本的条目从六类移入 aasInstall，其余原样', () => {
  const root = tmp()
  const p = join(root, 'installed.json')
  const t = { dstDir: join(tmpdir(), 'whatever-user_rules') }
  writeLedger(p, {
    schemaVersion: 1,
    entries: [entry('a', 'ed', join(t.dstDir, 'rule-a.md')), entry('b', 'ed', join(t.dstDir, 'rule-b.md'))],
  })
  const paths = runtimePathsIndex(readLedger(p))
  const r = {
    orphans: [{ name: 'rule-a.md', isLink: true }, { name: 'stranger', isLink: false }],
    wrong: [{ dstName: 'rule-b.md' }],
    legacy: [{ name: 'rule-c.md' }],
    staleSelf: [],
  }
  reclassifyWithLedger(r, t, paths)
  assert.deepEqual(r.orphans.map((x) => x.name), ['stranger'], '只有命中的移出')
  assert.deepEqual(r.wrong, [])
  assert.deepEqual(r.legacy, [{ name: 'rule-c.md' }])
  assert.deepEqual(r.aasInstall.map((x) => x.name).sort(), ['rule-a.md', 'rule-b.md'])
  assert.deepEqual(r.aasInstall.map((x) => x.via).sort(), ['孤儿', '需替换'])
})

test('defaultLedgerPath 指向 ~/.aas/installed.json', () => {
  const p = defaultLedgerPath('C:/home/u')
  assert.ok(p.endsWith(join('.aas', 'installed.json')))
  assert.ok(p.startsWith('C:\\home\\u') || p.startsWith('C:/home/u'))
})

test('目录不存在时写账本自动建目录', () => {
  const root = tmp()
  const p = join(root, 'deep', 'dir', 'installed.json')
  writeLedger(p, { schemaVersion: 1, entries: [] })
  assert.ok(existsSync(p))
  void rmSync
  void mkdirSync
})
