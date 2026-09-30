import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runUpdate } from '../src/update.mjs'

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }

test('runUpdate：刷新后重校验依赖（依赖技能被装进账本）', async () => {
  const home = tmp('upd-home-')
  const src = tmp('upd-src-')
  mkdirSync(join(src, 'skills', 'a'), { recursive: true })
  mkdirSync(join(src, 'skills', 'b'), { recursive: true })
  mkdirSync(join(src, 'skilldependencies'), { recursive: true })
  writeFileSync(join(src, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\nhi', 'utf8')
  writeFileSync(join(src, 'skills', 'b', 'SKILL.md'), '---\nname: b\n---\nhi', 'utf8')
  writeFileSync(join(src, 'skilldependencies', 'a.json'), JSON.stringify({
    schemaVersion: 1, skill: 'a', dependencies: { skills: [{ name: 'b' }] },
  }), 'utf8')

  // 临时配置：editor 'fake'，skills 目录指向 home/skills（level dir；更新走 copy 模式不碰 junction）
  const config = {
    schemaVersion: 1,
    editors: {
      fake: {
        detect: [join(home, 'user_rules')],
        rules: { dir: join(home, 'user_rules'), nameTemplate: 'rule-{name}', level: 'file' },
        skills: { dir: join(home, 'skills'), nameTemplate: '{name}', level: 'dir' },
      },
    },
    sources: {},
    linkTargets: [],
  }
  const configPath = join(home, 'config.json')
  writeFileSync(configPath, JSON.stringify(config), 'utf8')

  // 账本：登记 a（copy 模式，指向假源）
  const ledgerDir = join(home, '.aas')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, 'installed.json'), JSON.stringify({
    schemaVersion: 1,
    entries: [{
      id: 'a', kind: 'skill', status: 'installed', editor: 'fake',
      originalName: 'a', runtimeName: 'a', runtimePath: join(home, 'skills', 'a'), mode: 'copy',
      source: { repo: src, ref: null, commit: null, path: 'skills/a', fetchedAt: new Date().toISOString() },
      installedAt: new Date().toISOString(),
    }],
  }), 'utf8')

  const r = await runUpdate({ name: 'a', all: false, opts: { editor: 'fake', configPath, home, isTTY: false } })
  assert.ok(r.some((l) => l.startsWith('目标')), '应有目标行')
  assert.ok(r.some((l) => l.includes('依赖安装') && l.includes('b')), '应输出「依赖安装 b」')
})
