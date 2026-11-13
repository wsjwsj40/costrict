import React, { useState } from 'react'

type IconComponent = React.ComponentType<{ kind: string }>
export function HistoryList({ threads, query, currentId, onSelect, onRename, Icon }: { threads: any[]; query: string; currentId?: string; onSelect: (id: string) => void; onRename: (id: string, title: string) => void; Icon: IconComponent }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const saveTitle = () => { if (editing && draft.trim()) { onRename(editing, draft.trim()); setEditing(null) } }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const groups = ['今天', '过去 7 天', '更早'].map(label => ({ label, threads: [] as any[] }))
  for (const thread of [...threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const age = today.getTime() - (thread.updatedAt || 0)
    groups[age <= 0 ? 0 : age < 6 * 86400000 ? 1 : 2].threads.push(thread)
  }
  if (!threads.length) return <div className="page-empty-state"><Icon kind="history" /><strong>{query ? '没有匹配的会话' : '还没有历史会话'}</strong><p>{query ? '试试其他关键词，支持搜索标题和对话内容。' : '开始一次对话，记录会出现在这里。'}</p></div>
  return <div className="session-groups">{groups.filter(group => group.threads.length).map(group => <section className="session-group" key={group.label}><div className="list-section-label">{group.label}<span>{group.threads.length}</span></div>{group.threads.map(thread => {
    const last = thread.turns?.at(-1)
    const status = thread.waiting ? '待回答' : ['starting', 'inProgress'].includes(last?.status) ? '正在运行' : ['failed', 'interrupted'].includes(last?.status) ? '已停止' : '已完成'
    const time = thread.updatedAt ? new Date(thread.updatedAt) : null
    return <div className={`session-row ${thread.id === currentId ? 'is-current' : ''}`} key={thread.id}><button className="session-symbol" aria-label={`打开会话 ${thread.title || '新会话'}`} onClick={() => onSelect(thread.id)}><Icon kind="chat" /></button><div className="session-body">{editing === thread.id ? <div className="session-title-editor"><input autoFocus aria-label="会话标题" value={draft} maxLength={120} onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); saveTitle() } if (event.key === 'Escape') { event.preventDefault(); setEditing(null) } }} /><button disabled={!draft.trim()} aria-label="保存标题" title="保存（Enter）" onClick={saveTitle}><Icon kind="check" /></button><button aria-label="取消编辑" title="取消（Esc）" onClick={() => setEditing(null)}><Icon kind="close" /></button></div> : <button className="session-title" title="点击修改标题" onClick={() => { setEditing(thread.id); setDraft(thread.title || '') }}>{thread.title || '新会话'}<span className="title-edit-icon"><Icon kind="edit" /></span>{thread.id === currentId && <span className="current-label">当前</span>}</button>}<button className="session-open" aria-label={`进入会话 ${thread.title || '新会话'}`} onClick={() => onSelect(thread.id)}><span className="session-preview">{last?.user || '图片消息或暂无输入'}</span><span className="session-meta"><span className={`status-label ${status === '已完成' ? 'done' : status === '已停止' ? 'stopped' : 'running'}`}><i />{status}</span><time title={time?.toLocaleString('zh-CN')}>{time ? time.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</time></span></button></div><button className="row-arrow" aria-label={`进入会话 ${thread.title || '新会话'}`} onClick={() => onSelect(thread.id)}><Icon kind="right" /></button></div>
  })}</section>)}</div>
}

export function SkillList({ skills, query, message, onToggle, Icon }: { skills: any[]; query: string; message: string; onToggle: (skill: any) => void; Icon: IconComponent }) {
  const [filter, setFilter] = useState('all')
  const filtered = skills.filter(skill => (filter === 'all' || !!skill.enabled) && [skill.name, skill.description, skill.pluginId, skill.scope].some(value => String(value || '').toLowerCase().includes(query.trim().toLowerCase())))
  const scopes: Record<string, string> = { user: '个人技能', repo: '工作区', system: '系统', admin: '组织' }
  return <><div className="list-controls"><div className="list-tabs" aria-label="技能筛选"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部<span>{skills.length}</span></button><button aria-pressed={filter === 'enabled'} className={filter === 'enabled' ? 'active' : ''} onClick={() => setFilter('enabled')}>已启用<span>{skills.filter(skill => skill.enabled).length}</span></button></div></div>{message && <div className="list-notice" role="status">{message}</div>}<div className="skill-list">{filtered.map(skill => <article className="skill-row" key={skill.path}><div className="skill-symbol"><Icon kind="skills" /></div><div className="skill-body"><div className="skill-title">{skill.name}</div><div className="skill-owner">{skill.pluginId || scopes[skill.scope] || '本地技能'}</div><p className="skill-description">{skill.description || '暂无描述'}</p></div><button className={`skill-switch ${skill.enabled ? 'on' : ''}`} role="switch" aria-checked={!!skill.enabled} aria-label={`${skill.enabled ? '禁用' : '启用'} ${skill.name}`} title={skill.enabled ? '已启用，点击禁用' : '已禁用，点击启用'} onClick={() => onToggle(skill)}><span /></button></article>)}</div>{!filtered.length && !message && <div className="page-empty-state"><Icon kind="skills" /><strong>{skills.length ? '没有匹配的技能' : '添加你的第一个技能'}</strong><p>{skills.length ? '调整搜索条件或切换筛选。' : '点击右上角导入，选择包含 SKILL.md 的文件夹。'}</p></div>}</>
}
