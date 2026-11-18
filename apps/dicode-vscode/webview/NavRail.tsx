import React from 'react'
import { Icon } from './Icon'

export type RailPage = 'home' | 'skills' | 'history' | 'notices'

const ENTRIES: Array<{ page: RailPage; kind: string; label: string }> = [
  { page: 'home', kind: 'chat', label: '对话' },
  { page: 'skills', kind: 'box', label: 'Skill 市场' },
  { page: 'history', kind: 'history', label: '历史会话' },
  { page: 'notices', kind: 'bell', label: '消息提醒' },
]

/**
 * 左侧竖排导航：左上四项入口，左下用户中心与设置。
 * 用 aria-pressed 表达选中态，方便键盘与测试定位。
 */
export function NavRail({ page, onNavigate, onProfile, onSettings, historyUnread, noticesUnread }: {
  page: string
  onNavigate: (page: RailPage) => void
  onProfile: () => void
  onSettings: () => void
  historyUnread?: boolean
  noticesUnread?: boolean
}) {
  return <nav className="product-rail" aria-label="DiCode 导航">
    {ENTRIES.map(entry => <button
      key={entry.page}
      type="button"
      className={page === entry.page ? 'selected' : ''}
      aria-pressed={page === entry.page}
      aria-label={entry.label}
      title={entry.label}
      data-page={entry.page}
      onClick={() => onNavigate(entry.page)}
    >
      <Icon kind={entry.kind} />
      {entry.page === 'history' && historyUnread && <span className="rail-dot" aria-hidden="true" />}
      {entry.page === 'notices' && noticesUnread && <span className="rail-dot" aria-hidden="true" />}
    </button>)}
    <div className="rail-grow" />
    <div className="rail-divider" />
    <button type="button" aria-label="用户中心" title="用户中心" onClick={onProfile}><Icon kind="user" /></button>
    <button type="button" aria-label="设置" title="设置" onClick={onSettings}><Icon kind="settings" /></button>
  </nav>
}

export default NavRail
