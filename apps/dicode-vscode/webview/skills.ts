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
