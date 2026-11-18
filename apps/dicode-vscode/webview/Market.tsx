import React, { useMemo, useState } from 'react'
import MarkdownIt from 'markdown-it'
import { Icon } from './Icon'
import type { MarketSkill, MarketVersion } from './skills'
import {
  SORT_OPTIONS,
  compatBadge,
  formatCacheTime,
  formatTotalSize,
  marketCardState,
  versionActionLabel,
} from './skills'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export type MarketErrorView = {
  scope: 'catalog' | 'detail' | 'auth'
  code: string
  message: string
  retryable: boolean
  requiresLogin: boolean
  captchaRequired?: boolean
}

export type MarketDetailData = {
  skillId: string
  skill: MarketSkill
  content: string
  versions: MarketVersion[]
  version: string
}

type Props = {
  items: MarketSkill[]
  total: number
  page: number
  hasNext: boolean
  labelStats: Array<{ label: string; count: number }>
  cachedAt?: number
  stale: boolean
  loading: boolean
  error: MarketErrorView | null
  message: string
  auth: { loggedIn: boolean; baseUrlConfigured: boolean }
  detail: MarketDetailData | null
  detailLoading: boolean
  installedIds: Set<string>
  localDirs: Set<string>
  /** 搜索条件受控于 app 层：页签切换卸载重挂后状态保留（12.1 阶段 2） */
  query: string
  label: string
  sort: string
  onParamsChange: (partial: { query?: string; label?: string; sort?: string }) => void
  onRequest: (params: { query?: string; label?: string; sort?: string; page?: number }) => void
  onOpenDetail: (skillId: string) => void
  onCloseDetail: () => void
  onSelectVersion: (skillId: string, version: string) => void
  onInstall: (skill: MarketSkill) => void
  onLogin: (username: string, password: string) => void
  onLogout: () => void
  onGoInstalled: () => void
}

const numberFormat = (value: number) => value.toLocaleString('zh-CN')

/** 市场卡片：名称/发布者/版本空态/简介/兼容/操作（3.2【全部】） */
function MarketCard({ skill, installed, localDirs, onOpenDetail, onInstall }: { skill: MarketSkill; installed: Set<string>; localDirs: Set<string>; onOpenDetail: (skillId: string) => void; onInstall: (skill: MarketSkill) => void }) {
  const badge = compatBadge(skill)
  const isInstalled = installed.has(skill.id)
  const card = marketCardState(skill, { installedIds: installed, localDirs })
  return <div className={`skill-card market-card ${card.key === 'installed' ? 'is-installed' : ''}`}>
    <div className="skill-card-head">
      {skill.icon ? <img className="market-icon" src={skill.icon} alt="" /> : <span className="market-icon market-icon-empty"><Icon kind="box" /></span>}
      <button className="skill-name as-link" onClick={() => onOpenDetail(skill.id)} title={skill.name}>{skill.name}</button>
      {isInstalled && <span className="source-tag tone-market">已安装</span>}
      {badge && <span className={`source-tag ${badge.tone}`}>{badge.label}</span>}
      {skill.needApiKey && <span className="skill-scope">需 API Key</span>}
    </div>
    <div className="skill-meta">
      <span>{skill.publisher || '未知发布者'}</span>
      <span className="skill-version">{skill.version ? `v${skill.version}` : '版本待查看详情'}</span>
      <span>↓ {numberFormat(skill.downloadCount)}</span>
      {skill.ratingAvg != null && <span>★ {skill.ratingAvg.toFixed(1)}</span>}
    </div>
    <p className="skill-summary">{skill.summary || '暂无简介'}</p>
    {skill.tags.length > 0 && <div className="market-tags">{skill.tags.map(tag => <span key={tag} className="market-tag">{tag}</span>)}</div>}
    <div className="skill-actions">
      {card.notes.map(note => <span key={note} className="skill-note">{note}</span>)}
      <button
        className={card.key === 'blocked' || card.key === 'incompatible' || card.key === 'restricted' ? 'ghost-button danger' : 'primary small'}
        disabled={!card.enabled}
        title={card.enabled ? '' : card.notes[0] || card.label}
        onClick={() => { if (card.key === 'install') onInstall(skill) }}
      >{card.label}</button>
    </div>
  </div>
}

/** 登录引导：桩登录态下可用，真实鉴权阶段 4（3.4） */
function LoginGate({ onLogin, onGoInstalled, errorMessage }: { onLogin: (username: string, password: string) => void; onGoInstalled: () => void; errorMessage: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  return <div className="market-gate">
    <div className="gate-icon"><Icon kind="user" /></div>
    <strong>登录 SkillHub 浏览市场目录</strong>
    <p>市场目录与安装需要 SkillHub 账号；本地技能管理不受影响。</p>
    <form onSubmit={event => { event.preventDefault(); if (username && password) onLogin(username, password) }}>
      <input value={username} onChange={event => setUsername(event.target.value)} placeholder="用户名" autoComplete="username" />
      <input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" />
      <button className="primary" type="submit" disabled={!username || !password}>登录</button>
    </form>
    {errorMessage && <p className="gate-error">{errorMessage}</p>}
    <button className="inline-link" onClick={onGoInstalled}>先去看已安装的技能</button>
  </div>
}

/** 配置引导：SKILLHUB_BASE_URL 未配置（3.4） */
function ConfigGate({ onGoInstalled }: { onGoInstalled: () => void }) {
  return <div className="market-gate">
    <div className="gate-icon"><Icon kind="box" /></div>
    <strong>市场服务未配置</strong>
    <p>需要设置环境变量 <code>SKILLHUB_BASE_URL</code> 并重载窗口后才能浏览市场；开发环境可在设置中启用 <code>dicodeCodex.skillMarketStub</code> 桩数据预览。</p>
    <p className="muted">【已安装】页签不受影响，始终可用。</p>
    <button className="inline-link" onClick={onGoInstalled}>切到已安装</button>
  </div>
}

/** 市场详情抽屉：元信息 + 版本历史 + 概览（3.3），声明能力/示例空态兜底（14 #16） */
function DetailDrawer({ detail, loading, installed, onSelectVersion, onClose, onInstall, onLogout }: { detail: MarketDetailData | null; loading: boolean; installed: Set<string>; onSelectVersion: (skillId: string, version: string) => void; onClose: () => void; onInstall: (skill: MarketSkill) => void; onLogout: () => void }) {
  const html = useMemo(() => (detail ? md.render(detail.content || '_暂无概览内容_') : ''), [detail])
  if (loading) return <aside className="skill-detail"><div className="skill-detail-head"><strong>正在加载详情…</strong><button className="icon-button" onClick={onClose}><Icon kind="close" /></button></div></aside>
  if (!detail) return null
  const { skill } = detail
  const card = marketCardState(skill, { installedIds: installed, localDirs: new Set() })
  return <aside className="skill-detail" aria-label="技能详情">
    <div className="skill-detail-head">
      <div>
        <strong>{skill.name}</strong>
        <small>{skill.id}</small>
      </div>
      <button className="icon-button" aria-label="关闭详情" onClick={onClose}><Icon kind="close" /></button>
    </div>
    <div className="skill-detail-meta">
      <span>{skill.publisher || '未知发布者'}{skill.publisherDept ? ` · ${skill.publisherDept}` : ''}</span>
      <span>↓ {numberFormat(skill.downloadCount)}</span>
      {skill.ratingAvg != null && <span>★ {skill.ratingAvg.toFixed(1)}（{numberFormat(skill.ratingCount)}）</span>}
      {skill.needApiKey && <span className="skill-scope">需 API Key</span>}
    </div>
    {skill.tags.length > 0 && <div className="market-tags detail-tags">{skill.tags.map(tag => <span key={tag} className="market-tag">{tag}</span>)}</div>}
    <div className="skill-detail-body">
      <div className="market-versions">
        <h4>版本历史</h4>
        <ul className="skill-file-list">
          {detail.versions.map(version => {
            const action = versionActionLabel(version, installed, skill.id)
            return <li key={version.version} className={version.version === detail.version ? 'is-current' : ''}>
              <span>
                v{version.version}
                {version.version === detail.version && <em className="muted">（当前查看）</em>}
                <br />
                <small className="muted">{version.changelog || '无变更说明'}{version.publishedAt ? ` · ${new Date(version.publishedAt).toLocaleDateString('zh-CN')}` : ''} · {formatTotalSize(version.totalSize)}</small>
              </span>
              <button
                className={action.enabled ? 'ghost-button' : 'ghost-button'}
                disabled={!action.enabled}
                title={action.enabled ? '' : action.label}
                onClick={() => { if (action.enabled) onInstall(skill) }}
              >{action.label}</button>
            </li>
          })}
        </ul>
        <button className="inline-link" onClick={() => onSelectVersion(detail.skillId, detail.versions[0]?.version || detail.version)} title="回到最新已发布版本">查看最新版本概览</button>
      </div>
      <h4>概览</h4>
      {/* 声明能力与示例：接口无结构化字段，空态兜底不做猜测性解析（14 #16） */}
      <p className="muted">声明能力与示例暂无结构化数据，以下为 SKILL.md 概览。</p>
      <div className="markdown market-readme" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
    <div className="skill-detail-foot">
      <button
        className={card.key === 'installed' ? 'primary' : 'primary'}
        disabled={!card.enabled}
        onClick={() => { if (card.key === 'install' || card.key === 'retry') onInstall(skill) }}
      >{card.label}{detail.version ? ` v${detail.version}` : ''}</button>
      <button className="ghost-button" onClick={onLogout}>退出 SkillHub 登录</button>
    </div>
  </aside>
}

/** 【全部】页签主体：引导 → 工具栏 → 状态条 → 列表/骨架/错误/空态 + 详情抽屉 */
export default function Market(props: Props) {
  const {
    items, total, page, hasNext, labelStats, cachedAt, stale, loading, error, message, auth,
    detail, detailLoading, installedIds, localDirs, query, label, sort, onParamsChange,
    onRequest, onOpenDetail, onCloseDetail, onSelectVersion, onInstall, onLogin, onLogout, onGoInstalled,
  } = props
  // 搜索/筛选/排序变化 → 防抖 400ms 后回第 0 页；q 变化才延迟，label/sort 立即
  React.useEffect(() => {
    const timer = setTimeout(() => onRequest({ query, label, sort, page: 0 }), query ? 400 : 0)
    return () => clearTimeout(timer)
    // onRequest 稳定引用由 app 层保证
  }, [query, label, sort])

  const catalogError = error && error.scope === 'catalog' ? error : null
  const authError = error && error.scope === 'auth' ? error : null
  const blocked = !auth.baseUrlConfigured
  const needLogin = auth.baseUrlConfigured && !auth.loggedIn

  return <div className="installed-page">
    {blocked ? <ConfigGate onGoInstalled={onGoInstalled} />
      : needLogin ? <LoginGate onLogin={onLogin} onGoInstalled={onGoInstalled} errorMessage={authError?.message || ''} />
        : <>
          <div className="installed-toolbar">
            <div className="search-box"><input
              value={query}
              onChange={event => onParamsChange({ query: event.target.value })}
              placeholder="搜索名称、简介或标签"
              aria-label="搜索市场技能"
            /></div>
            <select className="market-select" value={label} onChange={event => onParamsChange({ label: event.target.value })} aria-label="按分类筛选">
              <option value="">全部分类</option>
              {labelStats.map(entry => <option key={entry.label} value={entry.label}>{entry.label}（{entry.count}）</option>)}
            </select>
            <select className="market-select" value={sort} onChange={event => onParamsChange({ sort: event.target.value })} aria-label="排序方式">
              {SORT_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>

          {(stale || message) && <div className="list-notice">
            {stale && <span className="skill-note">{formatCacheTime(cachedAt)}，正在后台刷新…</span>}
            {message && <span>{message}</span>}
          </div>}

          {catalogError && items.length === 0 ? (
            <div className="page-empty-state">
              <Icon kind="box" />
              <strong>市场目录暂时不可用</strong>
              <p>{catalogError.message}</p>
              {catalogError.retryable && <button className="ghost-button" onClick={() => onRequest({ query: query, label, sort, page: 0 })}>重试</button>}
              <button className="inline-link" onClick={onGoInstalled}>切到已安装</button>
            </div>
          ) : loading && items.length === 0 ? (
            <div className="market-skeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index} className="skeleton-card" />)}</div>
          ) : items.length === 0 ? (
            <div className="page-empty-state">
              <Icon kind="search" />
              <strong>没有匹配「{query || label || ''}」的技能</strong>
              <p>换个关键词，或清空筛选后再试。</p>
            </div>
          ) : (
            <>
              <div className="market-list">
                {items.map(skill => <MarketCard key={skill.id} skill={skill} installed={installedIds} localDirs={localDirs} onOpenDetail={onOpenDetail} onInstall={onInstall} />)}
              </div>
              {hasNext && <button className="ghost-button load-more" disabled={loading} onClick={() => onRequest({ query: query, label, sort, page: page + 1 })}>{loading ? '加载中…' : '加载更多'}</button>}
              {!hasNext && items.length > 0 && <p className="muted center">共 {numberFormat(total)} 个技能</p>}
            </>
          )}
        </>}

    <DetailDrawer
      detail={detail}
      loading={detailLoading}
      installed={installedIds}
      onSelectVersion={onSelectVersion}
      onClose={onCloseDetail}
      onInstall={onInstall}
      onLogout={onLogout}
    />
  </div>
}
