import React, { useState } from 'react'
import { Icon } from './Icon'
import {
  canDelete, canReimport, canToggle, canUnregister, deleteWarning, enabledCount,
  filterInstalled, formatInstalledAt, scopeLabel, skillNotes, sortInstalled, sourceLabel, sourceTone,
  type InstalledSkill, type SkillDetail,
} from './skills'

/**
 * 【已安装】页签。
 *
 * 数据来自扩展侧合并结果（登记 ∪ 目录 ∪ 索引），本组件只负责展示与派发消息；
 * 启停、删除、重新导入、移出登记全部由扩展侧执行并回推新列表。
 */
export function Installed({ skills, indexAvailable, message, detail, pending, onImport, onToggle, onDelete, onReimport, onUnregister, onDetail, onCloseDetail, onIgnoreRegistry, showIgnoreHint }: {
  skills: InstalledSkill[]
  indexAvailable: boolean
  message: string
  detail: SkillDetail | null
  pending: Record<string, boolean>
  onImport: (mode: 'folder' | 'zip') => void
  onToggle: (skill: InstalledSkill) => void
  onDelete: (skill: InstalledSkill) => void
  onReimport: (skill: InstalledSkill) => void
  onUnregister: (skill: InstalledSkill) => void
  onDetail: (skill: InstalledSkill) => void
  onCloseDetail: () => void
  onIgnoreRegistry: () => void
  showIgnoreHint?: boolean
}) {
  const [query, setQuery] = useState('')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const sorted = sortInstalled(skills)
  const filtered = filterInstalled(sorted, { query, onlyEnabled })

  return <div className="installed-page">
    <div className="installed-toolbar">
      <label className="search-box"><Icon kind="search" /><input className="page-search" aria-label="搜索已安装技能" placeholder="搜索名称、描述或目录" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="installed-actions">
        <button type="button" className="ghost-button" onClick={() => onImport('folder')}><Icon kind="upload" />文件夹</button>
        <button type="button" className="ghost-button" onClick={() => onImport('zip')}><Icon kind="plus" />ZIP</button>
      </div>
    </div>

    <div className="list-controls">
      <div className="list-tabs" aria-label="技能筛选">
        <button aria-pressed={!onlyEnabled} className={!onlyEnabled ? 'active' : ''} onClick={() => setOnlyEnabled(false)}>全部<span>{skills.length}</span></button>
        <button aria-pressed={onlyEnabled} className={onlyEnabled ? 'active' : ''} onClick={() => setOnlyEnabled(true)}>已启用<span>{enabledCount(skills)}</span></button>
      </div>
    </div>

    {showIgnoreHint && <div className="list-notice" role="status">登记文件尚未被 .gitignore 忽略，团队共享时可能被误提交。<button type="button" className="inline-link" onClick={onIgnoreRegistry}>加入 .gitignore</button></div>}
    {message && <div className="list-notice" role="status">{message}</div>}

    <div className="skill-list">
      {filtered.map(skill => {
        const toggle = canToggle(skill, indexAvailable)
        const remove = canDelete(skill)
        const busy = pending[skill.dir] === true
        return <article className={`skill-card ${skill.missing ? 'is-missing' : ''}`} key={skill.dir} data-dir={skill.dir}>
          <div className="skill-card-head">
            <span className={`source-tag ${sourceTone(skill)}`}>{sourceLabel(skill)}</span>
            <span className="skill-name" title={skill.dir}>{skill.name}</span>
            {skill.version && <span className="skill-version">v{skill.version}</span>}
            {skill.installedAt && <span className="skill-date">{formatInstalledAt(skill.installedAt)}</span>}
          </div>
          <p className="skill-summary">{skill.summary || '暂无描述'}</p>
          <div className="skill-meta">
            <span className="skill-dir">{skill.dir}</span>
            {scopeLabel(skill) && <span className="skill-scope">{scopeLabel(skill)}</span>}
            {skillNotes(skill).map(note => <span className="skill-note" key={note}>{note}</span>)}
          </div>
          <div className="skill-actions">
            <button type="button" className="ghost-button" onClick={() => onDetail(skill)}>详情</button>
            {canReimport(skill) && <button type="button" className="ghost-button" disabled={busy} onClick={() => onReimport(skill)}>重新导入</button>}
            {canUnregister(skill) && <button type="button" className="ghost-button" disabled={busy} onClick={() => onUnregister(skill)}>移出登记</button>}
            <button type="button" className="ghost-button danger" disabled={!remove.ok || busy} title={remove.reason} onClick={() => onDelete(skill)}>删除</button>
            <button
              type="button"
              className={`skill-switch ${skill.enabled === true ? 'on' : ''}`}
              role="switch"
              aria-checked={skill.enabled === true}
              aria-label={`${skill.enabled === true ? '禁用' : '启用'} ${skill.name}`}
              title={toggle.ok ? (skill.enabled === true ? '已启用，点击禁用' : '已禁用，点击启用') : toggle.reason}
              disabled={!toggle.ok || busy}
              onClick={() => onToggle(skill)}
            ><span /></button>
          </div>
        </article>
      })}
    </div>

    {!filtered.length && <div className="page-empty-state">
      <Icon kind="skills" />
      <strong>{skills.length ? '没有匹配的技能' : '还没有安装技能'}</strong>
      <p>{skills.length ? '调整搜索条件或切换筛选。' : '从文件夹或 ZIP 导入；市场安装会在后续版本接入。'}</p>
    </div>}

    {detail && <section className="skill-detail" aria-label={`技能详情 ${detail.dir}`}>
      <header className="skill-detail-head">
        <div><strong>{detail.record?.name || detail.dir}</strong><small>{detail.dirPath}</small></div>
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={onCloseDetail}><Icon kind="close" /></button>
      </header>
      <div className="skill-detail-meta">
        {detail.record ? <><span className={`source-tag ${`tone-${detail.record.source}`}`}>{sourceLabel({ source: detail.record.source } as InstalledSkill)}</span>{detail.record.version && <span className="skill-version">v{detail.record.version}</span>}</> : <span className="source-tag tone-external">手工放置</span>}
        <span className="skill-dir">{detail.files.length} 个文件</span>
      </div>
      <div className="skill-detail-body">
        <ul className="skill-file-list">
          {detail.files.slice(0, 80).map(file => <li key={file.path}><span>{file.path}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></li>)}
        </ul>
        <pre className="skill-readme">{detail.readme || '没有可预览的 SKILL.md'}</pre>
      </div>
      <footer className="skill-detail-foot">
        <span className="muted">{deleteWarning({ source: detail.record?.source || 'external' } as InstalledSkill)}</span>
      </footer>
    </section>}
  </div>
}

export default Installed
