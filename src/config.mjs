/**
 * config.mjs —— 配置规范化（阶段 2 底座）。
 *
 * sync.config.json 有两种形态：
 *   旧格式：{ targets: [...] }                              —— 仅链接形态
 *   新格式：{ schemaVersion, editors, sources, linkTargets } —— 编辑器适配器 + 源登记 + 链接形态
 *
 * 载入器必须两种都认（设计稿 §3「配置文件的演进纪律」）：
 * normalizeConfig 把两种都归一成 { schemaVersion, editors, sources, targets }，
 * 其中 targets 永远是链接形态的原始条目数组（直接喂给 sync.mjs 的 buildTargets）。
 */
export const SUPPORTED_SCHEMA_VERSION = 1

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置文件内容不是对象')
  }
  const schemaVersion = raw.schemaVersion ?? 1
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`配置 schemaVersion=${schemaVersion} 不受支持（支持 ${SUPPORTED_SCHEMA_VERSION}）`)
  }
  const editors = raw.editors ?? {}
  const sources = raw.sources ?? {}
  if (typeof editors !== 'object' || Array.isArray(editors)) throw new Error('配置的 editors 应为对象')
  if (typeof sources !== 'object' || Array.isArray(sources)) throw new Error('配置的 sources 应为对象')

  let targets
  if (Array.isArray(raw.linkTargets)) targets = raw.linkTargets
  else if (Array.isArray(raw.targets)) targets = raw.targets // 旧格式
  else throw new Error('配置里没有 targets/linkTargets（应为非空数组）')
  if (!Array.isArray(targets)) throw new Error('配置里没有 targets/linkTargets（应为非空数组）')

  return { schemaVersion, editors, sources, targets }
}
