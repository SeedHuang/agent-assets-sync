import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, needsUpdate, ensureCli, isSelfCli } from '../src/cli-version.mjs'

test('parseVersion：剥 v 前缀与非版本噪音', () => {
  assert.equal(parseVersion('v22.12.0'), '22.12.0')
  assert.equal(parseVersion('aas 1.2.3 (c) 2026'), '1.2.3')
  assert.equal(parseVersion('not a version'), null)
})

test('compareVersions：数值比较；无法解析 → null', () => {
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', 'abc'), null)
})

test('needsUpdate：本地缺失 → true；minVersion 不满足 → true；远端新 → true', () => {
  assert.equal(needsUpdate({ local: null, remote: '2.0.0' }), true)
  assert.equal(needsUpdate({ local: '1.0.0', remote: '1.2.0', minVersion: '1.1.0' }), true)
  assert.equal(needsUpdate({ local: '1.2.0', remote: '1.3.0' }), true)
  assert.equal(needsUpdate({ local: '1.3.0', remote: '1.3.0' }), false)
})

test('isSelfCli：识别 aas 自身（B2）', () => {
  assert.equal(isSelfCli('aas'), true)
  assert.equal(isSelfCli('prettier'), false)
})

test('ensureCli：正常运行 → updated / ok', async () => {
  const exec = (cmd, args) => {
    if (cmd === 'prettier' && args[0] === '--version') return '2.0.1\n'
    if (cmd === 'npm' && args[0] === 'view') return '2.5.0\n'
    if (cmd === 'npm' && args[0] === 'install') return 'added\n'
    throw new Error('unexpected ' + cmd)
  }
  const r = await ensureCli({ name: 'prettier', versionSource: 'npm' }, { exec })
  assert.equal(r.action, 'updated')
  // 修正：第二个调用用独立 mock，npm view 返回与本地相同的 2.0.1 → needsUpdate=false → 'ok'
  const execOk = (cmd, args) => {
    if (cmd === 'prettier' && args[0] === '--version') return '2.0.1\n'
    if (cmd === 'npm' && args[0] === 'view') return '2.0.1\n'
    throw new Error('unexpected ' + cmd)
  }
  const ok = await ensureCli({ name: 'prettier', versionSource: 'npm', minVersion: '2.0.0' }, { exec: execOk })
  assert.equal(ok.action, 'ok')
})

test('ensureCli：aas 自身 → error 不更新（B2）', async () => {
  const r = await ensureCli({ name: 'aas', versionSource: 'npm' }, { exec: () => { throw new Error('should not run') } })
  assert.equal(r.action, 'error')
  assert.match(r.detail, /不能自动更新正在运行的 aas 自身/)
})

test('ensureCli：取版本失败 → error 带命令原文与退出码（R6）', async () => {
  const exec = (cmd, args) => {
    if (cmd === 'prettier' && args[0] === '--version') throw Object.assign(new Error('boom'), { stderr: 'cannot run', status: 127 })
    throw new Error('unexpected')
  }
  const r = await ensureCli({ name: 'prettier', versionSource: 'npm' }, { exec })
  assert.equal(r.action, 'error')
  assert.match(r.detail, /prettier --version.*127.*cannot run/s)
})
