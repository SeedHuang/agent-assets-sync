# agent-assets-sync

把「源仓库里的**全局规则**和**技能**」同步到「编辑器真正去读的**运行时目录**」的小工具。

设计缘由（为什么独立成项目、为什么叫这个名、为什么不发 npm）见 [docs/design.md](docs/design.md)；这里只讲怎么用。

## 它解决什么问题

平台的规则 / 技能要生效，得放在它自己认的目录里（如 Trae CN 的 `~\.trae-cn\`）。
但那些目录**不在任何 git 里** —— 直接改，下一次同步就被冲掉；不放进 git，又没法版本管理、没法换机器。

这个工具的做法：**源仓库是你唯一编辑的地方**，运行时目录只是它的镜像（用符号链接 / junction 指过去）。

- 改规则 → 在 `my-rules\rules\` 改
- 改技能 → 在 `retro-skills\skills\` 改
- 改完跑一次同步，运行时就是新的了

因为是链接而不是复制，**改源即生效**，平时甚至不用重跑。

## 快速开始

前置：Node ≥ 18；Windows 上**规则那一侧**需要开「开发者模式」（符号链接靠它；技能那侧用 junction，不需要）。

```
# 1. 只体检（默认，绝不改动任何东西）
node src/sync.mjs

# 2. 同步：只建"缺失的链接"，不删任何东西
node src/sync.mjs --apply

# 3. 看它管了哪些、会落到什么名字
node src/sync.mjs list

# 跑测试（临时目录里，不碰你真实的 ~\.trae-cn）
node --test test/sync.test.mjs
```

**安全默认**：默认只做一件事 —— 建缺失的链接。凡是会删东西的动作，都要你显式开口：

| 参数 | 允许删什么 |
|---|---|
| （无） | 什么都不删 |
| `--replace` | 把「真实副本 / 指错的链接」换成规范链接（先删旧的） |
| `--rm-old` | 清掉旧名残留文件 + 「自家残留链接」（指向源里已不存在的文件） |

退出码：`0` = 一致；`1` = 有差异；`2` = 出错。**幂等**：重复跑没有副作用，出错后重跑一次就收敛。

## 配置

全部写在 `sync.config.json`。**换编辑器 / 换机器只改这里，不碰代码。**

```json
{
  "targets": [
    {
      "label": "全局规则",
      "srcDir": "D:/Seed/my-rules/rules",
      "dstDir": "~/.trae-cn/user_rules",
      "dstName": "rule-{name}",
      "level": "file",
      "env": { "srcDir": "MY_RULES_SRC", "dstDir": "TRAE_RULES_DST" }
    },
    {
      "label": "技能",
      "srcDir": "D:/Seed/retro-skills/skills",
      "dstDir": "~/.trae-cn/skills",
      "dstName": "{name}",
      "level": "dir",
      "env": { "srcDir": "RETRO_SKILLS_DIR", "dstDir": "TRAE_SKILLS_DST" }
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `label` | 给人看的名字 |
| `srcDir` | 源目录（开头可写 `~`） |
| `dstDir` | 运行时目标目录（开头可写 `~`） |
| `dstName` | 目标文件名模板，**必须含 `{name}`**；源里的文件名会替换进去 |
| `level` | `file` = 对文件建符号链接；`dir` = 对目录建 junction |
| `env` | 可选。把环境变量名绑到 `srcDir` / `dstDir`：**换机器时不用改配置，设个变量就行** |

用别的配置文件：`node src/sync.mjs --config <路径>`。

### 环境变量（可选，用来覆盖配置里的路径）

| 变量 | 覆盖哪条 |
|---|---|
| `MY_RULES_SRC` | 全局规则的源目录 |
| `RETRO_SKILLS_DIR` | 技能的源目录 |
| `TRAE_RULES_DST` | 全局规则的运行时目录 |
| `TRAE_SKILLS_DST` | 技能的运行时目录 |

（这些变量名本身也写在配置里 —— 换成别的编辑器时，可以一并换成你习惯的变量名。）

## 换成别的编辑器

改 `sync.config.json` 里那条 target 的 `dstDir` 与 `dstName` 即可 —— **源文件一个字都不用动**
（规则是纯 markdown、不含某家编辑器的专有 frontmatter；技能用的是跨工具的 Agent Skills 约定）。

## 别踩的坑

- **不要在运行时目录里手改**（`~\.trae-cn\user_rules\`、`~\.trae-cn\skills\`）：会被同步冲掉。
- **别和 `npx skills add` / `skills update` 混用同一批技能**：两套机制都在管 = 第二份真相。误用了也不怕 —— 跑一次 `node src/sync.mjs` 能查出来（它会报「真实副本」或「链接指向别处」），`--apply --replace` 能修回去。
- 规则的文件名**必须**是 `rule-<名字>.md`，少了 `rule-` 前缀平台不加载；全局规则**没有 frontmatter**，是纯 markdown。

## 关系

- `D:\Seed\my-rules` —— 全局规则的源
- `D:\Seed\retro-skills` —— 技能套件的源（体系全貌见其 `docs\architecture.md`）

零第三方依赖，只用 Node 内置模块。
