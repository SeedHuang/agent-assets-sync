# agent-assets-sync

把「源仓库里的**全局规则**和**技能**」同步、安装到「编辑器真正去读的**运行时目录**」的命令行工具 **`aas`**。

设计缘由（为什么独立成项目、为什么叫这个名、为什么不发 npm）见 [docs/design.md](docs/design.md)；
CLI 的设计（两种安装形态 / 编辑器适配器 / 安装账本）见 [docs/cli-design.md](docs/cli-design.md)。这里只讲怎么用。

## 它解决什么问题

平台的规则 / 技能要生效，得放在它自己认的目录里（如 Trae CN 的 `~\.trae-cn\`）。
但那些目录**不在任何 git 里** —— 直接改，下一次同步就被冲掉；不放进 git，又没法版本管理、没法换机器。

这个工具维持两条管道：

| 形态 | 谁用 | 怎么生效 |
|---|---|---|
| **链接形态** | 你自己的源仓库（改源即生效） | 源文件 → 符号链接/junction → 运行时 |
| **安装形态** | 别人的远端仓库（git URL） | clone 进本地缓存 → 从缓存装进编辑器，账本记账 |

## 安装

前置：Node ≥ 20 + git + npm；Windows 上**规则那一侧**需要开「开发者模式」（符号链接靠它；技能那侧用 junction，不需要）。

```
git clone <本仓库> && cd agent-assets-sync
npm install
npm link        # 开发态：活链，改代码立即生效
npm run localg  # 或者：本地全局安装（同样是活链）
npm run localg:rm   # 卸载
```

## 命令一览

```
aas                        体检：链接形态 + 安装形态一起查（默认命令，绝不改动任何东西）
aas sync [--replace] [--rm-old]   同步：把源链接进运行时（默认只建缺失的链接）
aas add <源> [名...]        安装：从远端/本地源装规则或技能
aas update [名] [--all]     刷新已装的资产（也是缓存漂移的修复入口）
aas remove <名> [--purge]   摘除已装的资产并销账
aas import <名>             把编辑器里手建的条目收编进你的源仓库
aas list                    列出配置的源与各源条目
aas editors                 列出检测到的编辑器与各自目录、前置条件
```

- `<源>` = git URL（支持 `仓库#分支`、剥 `.git`）、配置 `sources` 里登记的短名、或本地路径
- `--config <路径>` 可换配置文件（默认项目根的 `sync.config.json`）

**安全默认**：默认只建缺失的链接 / 只装你选中的；凡是会删东西的动作都要你显式开口（`remove` 交互确认，脚本里必须 `--yes`；非交互环境绝不静默删）。
退出码：`0` = 一致；`1` = 有差异；`2` = 出错。**幂等**：重复跑没有副作用。

## `aas add` 的行为（安装形态）

1. 把源仓库 clone 进本地缓存 `~\.aas\repos\`（`--depth 1`）
2. 列出里面的规则和技能，**多选列表里已装的直接标 `[已装]`**（不給名则交互多选；脚本模式必须给名）
3. 装进检测到的编辑器（认不出会让你选；默认缓存+链接，`--copy` 可强制复制）
4. 在账本 `~\.aas\installed.json` 记下**原名 ↔ 运行时名**的映射——重复判断、`aas update`、`aas remove` 全靠它

## 配置

全部写在 `sync.config.json`。**换编辑器 / 换机器只改这里，不碰代码。**

```jsonc
{
  "schemaVersion": 1,
  "editors": {                       // 编辑器适配器：目录 + 命名模板 + 链接级别
    "trae-cn": {
      "detect": ["~/.trae-cn"],
      "prereq": "windows-dev-mode:rules",
      "rules":  { "dir": "~/.trae-cn/user_rules", "nameTemplate": "rule-{name}", "level": "file" },
      "skills": { "dir": "~/.trae-cn/skills",     "nameTemplate": "{name}",       "level": "dir" }
    }
  },
  "sources": {},                                     // 源登记（aas add 的短名）
  "linkTargets": [                   // 链接形态：源 → 运行时（旧格式 targets 也兼容）
    { "label": "全局规则", "srcDir": "D:/Seed/retro-skills/rules", "dstDir": "~/.trae-cn/user_rules",
      "dstName": "rule-{name}", "level": "file", "editor": "trae-cn" }
  ]
}
```

### 环境变量（可选，覆盖配置里的路径）

| 变量 | 覆盖哪条 |
|---|---|
| `RETRO_SKILLS_RULES` / `RETRO_SKILLS_DIR` | 两个链接形态的源目录 |
| `TRAE_RULES_DST` / `TRAE_SKILLS_DST` | 两个链接形态的运行时目录 |

## 换成别的编辑器

在 `editors` 里**加一段适配 JSON**（目录 + 命名模板 + 链接级别）即可，源文件一个字不用动。
接入前先实测那个编辑器是否跟随符号链接/junction（目前只实测过 Trae CN：跟随）。

## 别踩的坑

- **不要在运行时目录里手改**：要么改源仓库（链接形态），要么用 aas（安装形态）。手建的条目用 `aas import` 收编。
- **别和 `npx skills add` / `skills update` 混用同一批技能**：两套机制都在管 = 第二份真相。误用了也不怕 —— `aas` 体检能查出来（"真实副本"/"链接指向别处"），`aas sync --replace` 能修回去。
- 规则的文件名**必须**是 `rule-<名字>.md`，少了 `rule-` 前缀平台不加载；全局规则**没有 frontmatter**，是纯 markdown。

## 关系

- `D:\Seed\retro-skills\rules` —— 全局规则的源（链接形态，与技能同仓库）
- `D:\Seed\retro-skills` —— 技能套件的源（体系全貌见其 `docs\architecture.md`）
- `~\.aas\` —— 安装账本与缓存（installed.json / repos / temp）

依赖：Node 内置之外只用 commander + @inquirer/prompts（子命令与交互问询）+ 系统 git。
