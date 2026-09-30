#!/usr/bin/env node
/**
 * aas —— agent-assets-sync 的命令行入口（设计见 docs/cli-design.md）。
 *
 * 结构：doctor/sync/list 是 commander 薄壳，转发 src/sync.mjs 的 main()（行为与 node src/sync.mjs 一致）；
 *       editors/add/remove/update/import 走独立模块（config / ledger / editors / add / remove / update / import）。
 *
 * 子命令：
 *   aas               = aas doctor    只体检（默认命令，绝不改动任何东西）
 *   aas doctor        同上
 *   aas sync          同步：把源链接进运行时（默认只建缺失的链接，删东西要显式 flag）
 *     --replace / --rm-old            允许删东西的动作（见 aas sync --help）
 *   aas list          列出配置里各源有哪些条目（只读）
 *   aas editors       列出检测到的编辑器与各自目录、前置条件（只读）
 *   aas add <源> [名...]   从远端/本地源安装资产（多选标注已装；记录原名→运行时名映射）
 *     --editor <名>  显式指定编辑器（非 TTY 必须给）
 *     --copy         复制而不是链接（默认缓存+链接）
 *     --as <id>      单个资产换账本 id（撞名时用）
 *     --yes          非 TTY 下允许覆盖已存在条目
 *   aas update [名]   按账本刷新已装资产（内容更新 + 三态漂移修复）
 *     --all / --editor <名>
 *   aas remove <名>   按账本摘除运行时条目并销账
 *     --editor <名> / --purge / --yes
 *   aas import <名>   把编辑器里手建的条目收编进源仓库（接管需再跑 aas sync --replace）
 *   --config <路径>   用别的配置文件（默认 项目根的 sync.config.json）
 */
import { Command } from 'commander'
import { main, loadConfig, DEFAULT_CONFIG_PATH } from './sync.mjs'
import { normalizeConfig } from './config.mjs'
import { describeEditors } from './editors.mjs'
import { runAdd } from './add.mjs'
import { runRemove } from './remove.mjs'
import { runUpdate } from './update.mjs'
import { runImport } from './import.mjs'
import { homedir } from 'node:os'

function run(argvForMain) {
  // 不用 process.exit：Windows 上对 TTY/管道的写入是异步的，打完报告立刻退出有概率丢尾部输出。
  // 设 exitCode 后正常返回，让 Node 自己把 stdout 冲完再退
  process.exitCode = main(argvForMain)
}

// 交互判定：只认真实 TTY。
// 曾有 AAS_FORCE_INTERACTIVE=1 强制开交互的开关，但它同时把 isTTY 一并置真，
// 会让非 TTY 下的删除绕过 --yes 强制——与"删除类操作仍受 --yes 约束"的承诺矛盾，已移除。
const isTTY = process.stdin.isTTY === true

function loadNormalized(configPath) {
  return normalizeConfig(loadConfig(configPath ?? DEFAULT_CONFIG_PATH))
}

const program = new Command()
program
  .name('aas')
  .description('agent-assets-sync —— 把源仓库的规则/技能同步与安装进编辑器的运行时目录（设计：docs/cli-design.md）')
  .option('--config <路径>', '用别的配置文件（默认 项目根的 sync.config.json）')

program
  .command('doctor', { isDefault: true })
  .description('只体检（默认命令，绝不改动任何东西）')
  .option('--config <路径>', '用别的配置文件')
  .action((opts) => {
    const cfg = opts.config ?? program.opts().config
    run(cfg ? ['--config', cfg] : [])
  })

program
  .command('sync')
  .description('同步：把源链接进运行时（默认只建缺失的链接，删东西要显式 flag）')
  .option('--replace', '允许把"真实副本 / 指错的链接"换成链接（会删东西）')
  .option('--rm-old', '允许清理残留：旧名文件 + 自家失效链接（会删东西）')
  .option('--config <路径>', '用别的配置文件')
  .action((opts) => {
    const cfg = opts.config ?? program.opts().config
    const args = ['--apply']
    if (opts.replace) args.push('--replace')
    if (opts.rmOld) args.push('--rm-old')
    if (cfg) args.push('--config', cfg)
    run(args)
  })

program
  .command('list')
  .description('列出配置里各源有哪些条目（只读）')
  .option('--config <路径>', '用别的配置文件')
  .action((opts) => {
    const cfg = opts.config ?? program.opts().config
    run(cfg ? ['list', '--config', cfg] : ['list'])
  })

program
  .command('editors')
  .description('列出配置里的编辑器、检测状态与前置条件（只读）')
  .option('--config <路径>', '用别的配置文件')
  .action((opts) => {
    try {
      const cfgPath = opts.config ?? program.opts().config
      const config = loadNormalized(cfgPath)
      for (const line of describeEditors(config, { home: homedir() })) console.log(line)
      process.exitCode = 0
    } catch (e) {
      console.error(e.message)
      process.exitCode = 2
    }
  })

program
  .command('add <源> [名...]')
  .description('从远端/本地源安装资产（多选标注已装；记录原名→运行时名映射）')
  .option('--editor <名>', '显式指定编辑器（非交互环境必须给）')
  .option('--copy', '复制而不是链接（默认缓存+链接）')
  .option('--as <id>', '单个资产换账本 id（撞名时用）')
  .option('--yes', '非交互环境下允许覆盖已存在条目')
  .option('--config <路径>', '用别的配置文件')
  .action(async (source, names, opts) => {
    try {
      const cfg = opts.config ?? program.opts().config
      const lines = await runAdd({
        sourceSpec: source,
        names,
        opts: {
          editor: opts.editor, yes: opts.yes, copy: opts.copy, as: opts.as,
          configPath: cfg, home: homedir(), isTTY,
          env: process.env,
        },
      })
      for (const line of lines) console.log(line)
      process.exitCode = 0
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exitCode = 2
    }
  })

program
  .command('remove <名>')
  .description('按账本摘除运行时条目并销账（非交互环境必须 --yes）')
  .option('--editor <名>', '只摘某个编辑器的')
  .option('--purge', '连缓存一起清（没有别的条目引用时）')
  .option('--yes', '非交互环境必须给；交互终端可省（会确认）')
  .option('--config <路径>', '用别的配置文件')
  .action(async (id, opts) => {
    try {
      const cfg = opts.config ?? program.opts().config
      const lines = await runRemove({
        id,
        opts: {
          editor: opts.editor, yes: opts.yes, purge: opts.purge,
          configPath: cfg, home: homedir(), isTTY,
        },
      })
      for (const line of lines) console.log(line)
      process.exitCode = 0
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exitCode = 2
    }
  })

program
  .command('update [名]')
  .description('按账本刷新已装资产（内容更新 + 三态漂移修复；也是缓存漂移的修复入口）')
  .option('--all', '刷新账本里的全部条目')
  .option('--editor <名>', '只刷新某个编辑器的')
  .option('--config <路径>', '用别的配置文件')
  .action(async (name, opts) => {
    try {
      const cfg = opts.config ?? program.opts().config
      if (!name && !opts.all) {
        console.error('✗ 要给资产名，或用 --all 全量刷新')
        process.exitCode = 2
        return
      }
      const lines = await runUpdate({
        name, all: opts.all,
        opts: {
          editor: opts.editor, configPath: cfg, home: homedir(), isTTY,
          env: process.env,
        },
      })
      for (const line of lines) console.log(line)
      process.exitCode = 0
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exitCode = 2
    }
  })

program
  .command('import <名>')
  .description('把编辑器里手建的条目收编进你的源仓库（只写源；接管需再跑 aas sync --replace）')
  .option('--config <路径>', '用别的配置文件')
  .action(async (name, opts) => {
    try {
      const cfg = opts.config ?? program.opts().config
      const lines = await runImport({
        name,
        opts: { configPath: cfg, home: homedir(), env: process.env },
      })
      for (const line of lines) console.log(line)
      process.exitCode = 0
    } catch (e) {
      console.error(`✗ ${e.message}`)
      process.exitCode = 2
    }
  })

program.parseAsync(process.argv)
