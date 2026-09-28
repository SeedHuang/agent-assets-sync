#!/usr/bin/env node
/**
 * aas —— agent-assets-sync 的命令行入口（阶段 1 骨架，设计见 docs/cli-design.md）。
 *
 * 本文件是 commander 的**薄壳**：只做子命令解析，全部逻辑仍走 src/sync.mjs 的 main()
 * （含参数解析 / 配置载入 / 体检报告 / 同步执行），行为与 `node src/sync.mjs` 完全一致。
 * 后续阶段（账本 / add / update / remove）再逐个命令换成真实现。
 *
 * 子命令（阶段 1）：
 *   aas               = aas doctor    只体检（默认命令，绝不改动任何东西）
 *   aas doctor        同上
 *   aas sync          同步：把源链接进运行时（默认只建缺失的链接，删东西要显式 flag）
 *     --replace       允许把"真实副本 / 指错的链接"换成链接（会删东西）
 *     --rm-old        允许清理残留：旧名文件 + 自家失效链接（会删东西）
 *   aas list          列出配置里各源有哪些条目（只读）
 *   --config <路径>   用别的配置文件（默认 项目根的 sync.config.json）
 */
import { Command } from 'commander'
import { main } from './sync.mjs'

function run(argvForMain) {
  process.exit(main(argvForMain))
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

program.parse(process.argv)
