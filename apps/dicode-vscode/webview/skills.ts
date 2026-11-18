/**
 * 【已安装】页签的类型与纯函数。
 *
 * 数据由扩展侧 `installedView.buildInstalledView` 合并后推过来，
 * 这里只做展示层的过滤、排序、文案与按钮可用性，不发消息、不读文件。
 */

export type SkillSource = 'market' | 'import' | 'external'

export interface InstalledSkill {
  dir: string
  dirPath: string
  name: string
  summary: string
  version: string | null
  source: SkillSource
  installedAt: number | null
  enabled: boolean | null
  scope: string | null
  path: string | null
  missing: boolean
  external: boolean
  indexStale: boolean
  altered: boolean
  tags: string[]
  publisher?: string
  record: any
}

export interface SkillDetail {
  dir: string
  dirPath: string
  files: Array<{ path: string; size: number }>
  readme: string
  record: any
}

export const SOURCE_LABELS: Record<SkillSource, string> = {
  market: '市场安装',
  import: '本地导入',
  external: '手工放置',
}

const SCOPE_LABELS: Record<string, string> = {
  user: '个人',
  repo: '工作区',
  system: '系统',
  admin: '组织',
}

/**
 * 页面上的附加说明。顺序固定，避免同一项每次渲染顺序不同。
 * altered 只是附注，不改变已安装状态。
 */
export function skillNotes(skill: InstalledSkill): string[] {
  const notes: string[] = []
  if (skill.missing) notes.push('目录已不存在')
  if (skill.external) notes.push('未登记')
  if (skill.indexStale) notes.push('索引待刷新')
  if (skill.altered) notes.push('内容已变化')
  return notes
}

export function sourceLabel(skill: InstalledSkill): string {
  return SOURCE_LABELS[skill.source] || '本地技能'
}

export function scopeLabel(skill: InstalledSkill): string {
  if (!skill.scope) return ''
  return SCOPE_LABELS[skill.scope] || skill.scope
}

/** 来源标签的样式 key，市场项与本地项配色不同 */
export function sourceTone(skill: InstalledSkill): string {
  return `tone-${skill.source}`
}

export function formatInstalledAt(value: number | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/**
 * 搜索 + 「已启用」筛选。
 * enabled 为 null（索引不可用）时按未知处理：不进入已启用筛选，但也不隐藏。
 */
export function filterInstalled(
  skills: InstalledSkill[],
  options: { query?: string; onlyEnabled?: boolean } = {},
): InstalledSkill[] {
  const query = (options.query || '').trim().toLocaleLowerCase()
  return skills.filter(skill => {
    if (options.onlyEnabled && skill.enabled !== true) return false
    if (!query) return true
    return [skill.name, skill.summary, skill.dir, skill.publisher, ...(skill.tags || [])]
      .some(value => String(value || '').toLocaleLowerCase().includes(query))
  })
}

/** 名称优先的稳定排序，同名再按目录名兜底 */
export function sortInstalled(skills: InstalledSkill[]): InstalledSkill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.dir.localeCompare(b.dir))
}

export function enabledCount(skills: InstalledSkill[]): number {
  return skills.filter(skill => skill.enabled === true).length
}

/** 启停依赖 skills/config/write：索引不可用、目录缺失、条目不在索引里都禁用 */
export function canToggle(skill: InstalledSkill, indexAvailable: boolean): { ok: boolean; reason: string } {
  if (!indexAvailable) return { ok: false, reason: 'Codex CLI 不可用，无法启停' }
  if (skill.missing) return { ok: false, reason: '目录已不存在' }
  if (!skill.path) return { ok: false, reason: '索引尚未收录该技能' }
  return { ok: true, reason: '' }
}

/** 系统/管理员技能只读；手工放置项允许删除但要二次确认 */
export function canDelete(skill: InstalledSkill): { ok: boolean; reason: string } {
  if (skill.scope === 'system' || skill.scope === 'admin') return { ok: false, reason: '系统/组织技能为只读' }
  if (skill.missing) return { ok: false, reason: '目录已不存在' }
  return { ok: true, reason: '' }
}

export function canReimport(skill: InstalledSkill): boolean {
  return Boolean(skill.record)
}

export function canUnregister(skill: InstalledSkill): boolean {
  return Boolean(skill.record)
}

/** 手工放置项删除前的额外提示 */
export function deleteWarning(skill: InstalledSkill): string {
  if (skill.source === 'external') return '该目录不在安装登记中，可能是团队共享文件。删除后不可恢复。'
  if (skill.source === 'market') return '删除后可在【全部】重新安装。'
  return '删除后需要重新导入才能恢复。'
}

// ---------------------------------------------------------------------------
// 【全部】页签（市场目录）：类型与五态按钮映射（5.4 表格为唯一口径）
// ---------------------------------------------------------------------------

export interface MarketSkill {
  id: string // `${namespace}/${slug}`
  namespace: string
  slug: string
  name: string
  publisher: string
  publisherDept: string
  version: string // '' = 列表未回填（列表接口不返回版本，14 #15）
  summary: string
  tags: string[]
  icon?: string
  needApiKey: boolean
  compat: 'compatible' | 'incompatible' | 'restricted'
  minClientVersion?: string
  compatReason?: string
  updatedAt?: number
  downloadCount: number
  starCount: number
  ratingAvg?: number
  ratingCount: number
}

export interface MarketVersion {
  version: string
  status: string
  changelog: string
  fileCount: number
  totalSize: number
  publishedAt: number | null
  downloadReady: boolean
  createdByName: string
}

/** 任务在跑/失败态（阶段 3 接真实任务表，阶段 2 仅渲染用） */
export interface MarketJobView {
  state: 'queued' | 'downloading' | 'verifying' | 'extracting' | 'registering' | 'failed'
  retryable: boolean
  errorCode?: string
  message?: string
}

export const SORT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'newest', label: '最新发布' },
  { id: 'relevance', label: '相关度' },
  { id: 'downloads', label: '下载最多' },
  { id: 'rating', label: '评分最高' },
]

/**
 * 「已安装」标记的身份集合：只认登记 source: market 且 skillId 命中（3.2）。
 * 本地导入/手工放置的同名技能身份不同，不算已安装。
 */
export function marketInstalledIds(installed: InstalledSkill[]): Set<string> {
  return new Set(installed.filter(skill => skill.source === 'market' && skill.record?.skillId).map(skill => String(skill.record.skillId)))
}

/** 本地技能目录基名集合：市场条目 slug 命中即「本地已有同名技能」（8.3 硬阻断在阶段 3 下载后校验） */
export function localDirBasenames(installed: InstalledSkill[]): Set<string> {
  return new Set(installed.map(skill => skill.dir.split('/').pop() || skill.dir))
}

/** 版本可安装门禁（4.3）：仅 PUBLISHED 且包就绪 */
export function versionInstallable(version: MarketVersion): boolean {
  return version.status === 'PUBLISHED' && version.downloadReady === true
}

export function formatTotalSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function formatCacheTime(cachedAt: number | undefined): string {
  if (!cachedAt) return ''
  const date = new Date(cachedAt)
  if (Number.isNaN(date.getTime())) return ''
  const sameDay = new Date().toDateString() === date.toDateString()
  return sameDay
    ? `目录缓存于 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : `目录缓存于 ${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

/** 兼容徽标：compatible 是默认态不显示，避免整页噪音（14 #20） */
export function compatBadge(skill: MarketSkill): { label: string; tone: string } | null {
  if (skill.compat === 'incompatible') return { label: '不兼容', tone: 'tone-incompatible' }
  if (skill.compat === 'restricted') return { label: '已限制', tone: 'tone-restricted' }
  return null
}

export interface MarketCardState {
  key: 'install' | 'installing' | 'installed' | 'retry' | 'incompatible' | 'restricted' | 'blocked'
  label: string
  enabled: boolean
  notes: string[]
}

/**
 * 市场卡片五态映射，与 skillsModel.deriveState / 5.4 表格逐行同口径：
 * - 任务在跑 →【安装中…】禁用（阶段 3 接真实任务；阶段 2 仅渲染用）
 * - 已安装（source: market 且 skillId 命中）→【已安装】禁用
 * - 任务失败可重试 →【重试】可点，保留原因
 * - 任务失败不可重试 →【无法安装】禁用（不复用【不兼容】/【已限制】，14 #12）
 * - compat incompatible →【不兼容】禁用，显示最低客户端版本
 * - compat restricted →【已限制】禁用，显示组织策略说明
 * - 其余 →【安装】可点；目标目录被本地同名技能占用时附注「本地已有同名技能」
 */
export function marketCardState(
  skill: MarketSkill,
  context: { installedIds: Set<string>; localDirs: Set<string>; job?: MarketJobView | null; updateAvailableVersion?: string } = { installedIds: new Set(), localDirs: new Set() },
): MarketCardState {
  const notes: string[] = []
  const job = context.job || null

  if (job && job.state !== 'failed') {
    if (skill.needApiKey) notes.push('运行需 API Key')
    return { key: 'installing', label: '安装中…', enabled: false, notes }
  }

  if (job && job.state === 'failed') {
    notes.push(job.message || job.errorCode || '安装失败')
    return job.retryable
      ? { key: 'retry', label: '重试', enabled: true, notes }
      : { key: 'blocked', label: '无法安装', enabled: false, notes }
  }

  if (context.installedIds.has(skill.id)) {
    if (context.updateAvailableVersion) notes.push(`有 v${context.updateAvailableVersion} 可用`)
    if (skill.needApiKey) notes.push('运行需 API Key')
    return { key: 'installed', label: '已安装', enabled: false, notes }
  }

  if (skill.compat === 'incompatible') {
    notes.push(skill.minClientVersion ? `需要插件 v${skill.minClientVersion} 及以上` : '当前客户端版本不支持')
    return { key: 'incompatible', label: '不兼容', enabled: false, notes }
  }
  if (skill.compat === 'restricted') {
    notes.push(skill.compatReason || '当前账号无权安装该技能')
    return { key: 'restricted', label: '已限制', enabled: false, notes }
  }

  if (context.localDirs.has(skill.slug)) notes.push('本地已有同名技能')
  if (skill.needApiKey) notes.push('运行需 API Key')
  return { key: 'install', label: '安装', enabled: true, notes }
}

/** 详情页的版本行是否显示安装入口（复用 versionInstallable 门禁） */
export function versionActionLabel(version: MarketVersion, installedIds: Set<string>, skillId: string): { label: string; enabled: boolean } {
  if (!versionInstallable(version)) return { label: version.status === 'PUBLISHED' ? '包未就绪' : '未发布', enabled: false }
  if (installedIds.has(skillId)) return { label: '已安装', enabled: false }
  return { label: '安装此版本', enabled: true }
}
