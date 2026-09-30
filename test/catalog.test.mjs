import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveSourceForName, lookupCatalog } from '../src/catalog.mjs'

const cfg = {
  sources: {},
  skills: {
    'multi-lens-review': { source: 'https://github.com/seedhuang/retro-skills.git', localPath: 'D:/Seed/retro-skills' },
    'evolving-skills': { source: 'https://github.com/seedhuang/retro-skills.git' },
  },
}
const fakeExists = (p) => p === 'D:/Seed/retro-skills' || p === resolve('D:/Seed/retro-skills')

test('lookupCatalog：命中 / 未命中', () => {
  assert.equal(lookupCatalog('multi-lens-review', cfg).found, true)
  assert.equal(lookupCatalog('nope', cfg).found, false)
})

test('resolveSourceForName：本地存在的路径 → path', () => {
  const r = resolveSourceForName('D:/Seed/retro-skills', cfg, { isLocal: false, exists: fakeExists })
  assert.equal(r.ok, true)
  assert.equal(r.context.kind, 'path')
})

test('resolveSourceForName：目录命中默认 → source', () => {
  const r = resolveSourceForName('multi-lens-review', cfg, { isLocal: false, exists: fakeExists })
  assert.equal(r.context.kind, 'source')
  assert.equal(r.context.source, 'https://github.com/seedhuang/retro-skills.git')
})

test('resolveSourceForName：--islocal + localPath → path（工作副本）', () => {
  const r = resolveSourceForName('multi-lens-review', cfg, { isLocal: true, exists: fakeExists })
  assert.equal(r.context.kind, 'path')
  assert.equal(r.context.path, resolve('D:/Seed/retro-skills'))
})

test('resolveSourceForName：--islocal 无 localPath 有缓存 → path（缓存）', () => {
  const r = resolveSourceForName('evolving-skills', cfg, {
    isLocal: true, exists: (p) => fakeExists(p) || p.includes(homedir()),
  })
  assert.equal(r.context.kind, 'path')
})

test('resolveSourceForName：--islocal 都无 → 本地未找到（不联网）', () => {
  const r = resolveSourceForName('evolving-skills', cfg, { isLocal: true, exists: fakeExists })
  assert.equal(r.ok, false)
  assert.match(r.reason, /本地未找到：evolving-skills/)
})

test('resolveSourceForName：目录未命中 --islocal → 本地未找到', () => {
  const r = resolveSourceForName('nope', cfg, { isLocal: true, exists: fakeExists })
  assert.equal(r.ok, false)
  assert.match(r.reason, /本地未找到：nope/)
})

test('resolveSourceForName：目录未命中默认 → npx 回退', () => {
  const r = resolveSourceForName('nope', cfg, { isLocal: false, exists: fakeExists })
  assert.equal(r.context.kind, 'npx')
  assert.equal(r.context.name, 'nope')
})
