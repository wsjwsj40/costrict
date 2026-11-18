import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownIt from 'markdown-it'
import Composer from './Composer'
import Attachments, { ImagePreview } from './Attachments'
import { HistoryList } from './Subpages'
import NavRail, { type RailPage } from './NavRail'
import Installed from './Installed'
import { Icon } from './Icon'
import Market, { type MarketErrorView, type MarketDetailData } from './Market'
import type { InstalledSkill, SkillDetail, MarketSkill } from './skills'
import { marketInstalledIds, localDirBasenames } from './skills'
import { ConversationStore, parseDiff } from '../media/conversation'
import './style.css'

declare global { interface Window { acquireVsCodeApi: () => { postMessage: (message: unknown) => void; getState?: () => any; setState?: (state: unknown) => void } } }
const vscode = window.acquireVsCodeApi()
const store = new ConversationStore()
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const validateLink = md.validateLink.bind(md)
md.validateLink = (url: string) => /^file:\/\//i.test(url) || validateLink(url)
const fileToken = /(?:(?:[A-Za-z]:)?[\\/]|\.\.?[\\/])?(?:[\p{L}\p{N}_.\-]+[\\/])*[\p{L}\p{N}_.\-]+\.[A-Za-z0-9]{1,10}(?::\d+|#L\d+)?/gu
md.core.ruler.after('inline', 'local-file-links', state => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue
    const children = [] as any[]
    let inLink = false
    for (const token of block.children) {
      if (token.type === 'link_open') inLink = true
      if (token.type !== 'text' || inLink) { children.push(token); if (token.type === 'link_close') inLink = false; continue }
      let start = 0
      for (const match of token.content.matchAll(fileToken)) {
        const index = match.index || 0
        if (index > start) { const plain = new state.Token('text', '', 0); plain.content = token.content.slice(start, index); children.push(plain) }
        const open = new state.Token('link_open', 'a', 1); open.attrSet('href', match[0]); open.attrSet('class', 'local-file-link')
        const name = new state.Token('text', '', 0); name.content = match[0]
        children.push(open, name, new state.Token('link_close', 'a', -1))
        start = index + match[0].length
      }
      if (start < token.content.length) { const plain = new state.Token('text', '', 0); plain.content = token.content.slice(start); children.push(plain) }
    }
    block.children = children
  }
})
const renderImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('tabindex', '0')
  tokens[index].attrSet('role', 'button')
  tokens[index].attrSet('aria-label', `预览图片：${tokens[index].content || '图片'}`)
  return renderImage(tokens, index, options, env, renderer)
}
const post = (type: string, data: Record<string, unknown> = {}) => vscode.postMessage({ type, ...data })
const editTools = new Set(['write_file', 'replace_file_text', 'delete_file'])
function Markdown({ text }: { text: string }) {
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null)
  const onClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    const image = target.closest('img') as HTMLImageElement | null
    if (image) { event.preventDefault(); setPreview({ src: image.currentSrc || image.src, name: image.alt || image.title || '图片预览' }); return }
    const link = target.closest('a[href]') as HTMLAnchorElement | null
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; post(link.classList.contains('local-file-link') ? 'openFile' : 'openLink', link.classList.contains('local-file-link') ? { path: href } : { href }); return }
    const code = target.closest('code')
    if (code && !code.closest('pre') && /^(?:(?:[A-Za-z]:)?[\\/]|\.\.?[\\/])?(?:[^\\/]+[\\/])*[^\\/]+\.[\w-]+(?::\d+|#L\d+)?$/.test(code.textContent || '')) post('openFile', { path: code.textContent || '' })
  }
  return <><div className="markdown" onClick={onClick} onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).tagName === 'IMG') { event.preventDefault(); const image = event.target as HTMLImageElement; setPreview({ src: image.currentSrc || image.src, name: image.alt || '图片预览' }) } }} dangerouslySetInnerHTML={{ __html: md.render(text || '') }} />{preview && <ImagePreview src={preview.src} name={preview.name} onClose={() => setPreview(null)} />}</>
}
function Diff({ diff }: { diff: string }) {
  let oldLine = 0, newLine = 0, inHunk = false
  const lines: React.ReactNode[] = []
  for (const [index, line] of diff.replace(/\n$/, '').split('\n').entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue }
    if (!inHunk || line.startsWith('\\ No newline')) continue
    const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : 'context'
    lines.push(<div key={index} className={`diff-line ${kind}`}><span className="line-no">{kind === 'added' ? '' : oldLine++}</span><span className="line-no">{kind === 'deleted' ? '' : newLine++}</span><span className="diff-code">{line.slice(1) || ' '}</span></div>)
  }
  return <div className="diff-lines">{lines}</div>
}
function FileRow({ change, status, turn, itemId, changeIndex }: { change: any; status: string; turn: any; itemId: string; changeIndex: number }) {
  const file = change.path || change.filePath || ''
  const diff = change.diff || parseDiff(turn.diff || '').find((part: any) => part.path === file)?.diff || ''
  const parsed = diff ? parseDiff(diff.startsWith('diff --git ') ? diff : `diff --git a/${file} b/${file}\n${diff}`)[0] : null
  const [open, setOpen] = useState(false)
  const kind = change.kind || change.type || 'modified'
  const openChange = () => post('openDiff', { path: file, diff, turnId: turn.id, itemId, changeIndex })
  const verb = `${status === 'inProgress' ? '正在' : status === 'failed' ? '未能' : '已'}${kind === 'added' || kind === 'created' ? '创建' : kind === 'deleted' ? '删除' : '编辑'}`
  return <div className="activity-row file-activity">
    <div className="activity-line"><button className="activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon kind="edit" /><span className="activity-title">{verb}</span></button><button className="activity-file-link" onClick={openChange}>{file || '文件'}</button><button className="activity-chevron" aria-label={open ? '折叠文件变动' : '展开文件变动'} onClick={() => setOpen(!open)}><span className={`chevron ${open ? 'expanded' : ''}`} /></button>{!open && parsed && <span className="change-count"><span className="plus">+{parsed.additions}</span> <span>-{parsed.deletions}</span></span>}</div>
    {open && <div className="activity-content"><div className="diff-panel"><div className="diff-head"><button className="file-name" onClick={openChange}>{file || '文件'}</button>{parsed && <><span className="plus">+{parsed.additions}</span><span>-{parsed.deletions}</span></>}<button className="copy" title="复制差异" onClick={() => navigator.clipboard?.writeText(diff)}><Icon kind="copy" /></button></div>{diff ? <Diff diff={diff} /> : <div className="no-diff">暂无差异内容</div>}</div></div>}
  </div>
}
function visibleCommand(raw: unknown) {
  if (typeof raw !== 'string') return ''
  // Codex can report the shell invocation in several quoting styles. Find the
  // PowerShell executable first, then display only its -Command/-File payload.
  const shell = /(?:^|[\\/\s"'`])(?:pwsh|powershell)(?:\.exe)?(?=$|[\s"'`])/i.exec(raw)
  if (!shell) return raw
  const afterShell = raw.slice(shell.index + shell[0].length)
  const option = /(?:^|\s)-(?:CommandWithArgs|Command|c|File|f)\b\s*/i.exec(afterShell)
  if (!option) return raw
  let text = afterShell.slice(option.index + option[0].length).trim()
  if (text.startsWith('"') && text.endsWith('""')) text = text.slice(0, -1)
  while (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) text = text.slice(1, -1)
  return text.replace(/\\"/g, '"') || raw
}
function CommandRow({ item }: { item: any }) {
  const [open, setOpen] = useState(false)
  const command = visibleCommand(item.raw?.command)
  const action = item.status === 'inProgress' ? '正在运行' : item.status === 'failed' || (Number.isInteger(item.raw?.exitCode) && item.raw.exitCode !== 0) ? '运行失败' : '已运行'
  return <div className="activity-row command-activity"><button className="activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon kind="command" /><span className={`activity-title ${item.status === 'inProgress' ? 'flowing' : ''}`}>{action} {command.replace(/\s+/g, ' ').trim() || '命令'}</span><span className={`chevron ${open ? 'expanded' : ''}`} /></button>{open && <div className="activity-content command-detail"><div className="detail-meta">{[item.raw?.cwd, item.raw?.exitCode !== undefined ? `退出码 ${item.raw.exitCode}` : ''].filter(Boolean).join(' · ')}</div><pre>{command}</pre>{item.output && <pre className="output">{item.output}</pre>}</div>}</div>
}
function ToolRow({ item }: { item: any }) {
  const [open, setOpen] = useState(false)
  return <div className="activity-row"><button className="activity-toggle" onClick={() => setOpen(!open)}><Icon kind="command" /><span className={`activity-title ${item.status === 'inProgress' ? 'flowing' : ''}`}>{item.raw?.tool || item.type} · {item.status === 'inProgress' ? '正在运行' : '已完成'}</span><span className={`chevron ${open ? 'expanded' : ''}`} /></button>{open && <pre className="activity-content tool-detail">{JSON.stringify(item.raw || {}, null, 2)}</pre>}</div>
}
function Activities({ items, turn }: { items: any[]; turn: any }) {
  const [open, setOpen] = useState(turn.status !== 'completed')
  const entries = items.flatMap(item => item.type === 'fileChange' && item.raw?.changes?.length ? item.raw.changes.map((change: any, index: number) => ({ item, change, changeIndex: index, key: `${item.id}:${index}` })) : [{ item, changeIndex: 0, key: item.id }])
  const visible = entries.filter(({ item }) => item.type !== 'reasoning' && !(item.type === 'dynamicToolCall' && editTools.has(item.raw?.tool)))
  if (!visible.length) return null
  const commands = visible.filter(({ item }) => item.type === 'commandExecution').length
  const edits = visible.filter(({ item }) => item.type === 'fileChange').length
  const label = <>{commands > 0 && <>已运行 <small>{commands} 条命令</small></>}{commands > 0 && edits > 0 && '、'}{edits > 0 && <>已编辑 <small>{edits} 个文件</small></>}{!commands && !edits && <>已执行 <small>{visible.length} 项操作</small></>}</>
  const rows = visible.map(({ item, change, changeIndex, key }) => <React.Fragment key={key}>{item.type === 'commandExecution' ? <CommandRow item={item} /> : item.type === 'fileChange' ? <FileRow change={change || item.raw?.changes?.[0] || {}} status={item.status} turn={turn} itemId={item.id} changeIndex={changeIndex} /> : <ToolRow item={item} />}</React.Fragment>)
  if (visible.length === 1) return <div className="activity-list">{rows}</div>
  return <div className="activity-group"><button className="group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon kind={edits ? 'edit' : 'command'} /><span>{label}</span><span className={`chevron ${open ? 'expanded' : ''}`} /></button>{open && <div className="group-content">{rows}</div>}</div>
}
function FileSummary({ turn }: { turn: any }) {
  const [expanded, setExpanded] = useState(false)
  const events = (turn.items || []).filter((item: any) => item.type === 'fileChange').flatMap((item: any) => item.raw?.changes || [])
  const byPath = new Map<string, any>()
  for (const change of events) {
    const file = change.path || change.filePath
    if (!file) continue
    const first = byPath.get(file)
    byPath.set(file, { ...change, initiallyCreated: first?.initiallyCreated ?? ['added', 'created'].includes(change.kind) })
  }
  const finalDiff = parseDiff(turn.diff || '')
  const files = finalDiff.length ? finalDiff : [...byPath.values()].filter(change => !(change.initiallyCreated && change.kind === 'deleted'))
  if (!files.length) return null
  const shown = expanded ? files : files.slice(0, 3)
  const totals = files.reduce((sum: { added: number; deleted: number }, change: any) => {
    const file = change.path || change.filePath || ''
    const diff = change.diff || ''
    const parsed = parseDiff(diff.startsWith('diff --git ') ? diff : `diff --git a/${file} b/${file}\n${diff}`)[0]
    return { added: sum.added + (parsed?.additions || 0), deleted: sum.deleted + (parsed?.deletions || 0) }
  }, { added: 0, deleted: 0 })
  const openChanges = (selectedPath?: string) => post('openChanges', { turnId: turn.id, selectedPath })
  return <div className="file-summary"><div className="summary-top" role="button" tabIndex={0} onClick={() => openChanges()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openChanges() } }}><span className="summary-icon"><Icon kind="changes" /></span><span className="summary-title"><strong>{files.length === 1 ? `编辑了 ${files[0].path || files[0].filePath}` : `编辑了 ${files.length} 个文件`}</strong><small><span className="plus">+{totals.added}</span> <span className="minus">-{totals.deleted}</span></small></span><button className="summary-undo" disabled title="暂不支持从此处撤销">撤销 ↶</button><button className="summary-view" onClick={event => { event.stopPropagation(); openChanges() }}>查看改动</button></div>{shown.map((change: any) => {
    const file = change.path || change.filePath
    const diff = change.diff || ''
    const counts = parseDiff(diff.startsWith('diff --git ') ? diff : `diff --git a/${file} b/${file}\n${diff}`)[0]
    return <button className="summary-file" key={file} onClick={() => openChanges(file)}><span className="summary-file-name">{file}</span>{diff && <span className="summary-count"><span className="plus">+{counts?.additions || 0}</span> <span className="minus">-{counts?.deletions || 0}</span></span>}</button>
  })}{files.length > 3 && <button className="summary-more" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : `显示其余 ${files.length - 3} 个文件`} <span className={`chevron ${expanded ? 'expanded' : ''}`} /></button>}</div>
}

function ChangesViewer() {
  const [payload, setPayload] = useState<{ diff: string; selectedPath?: string } | null>(null)
  useEffect(() => {
    const receive = (event: MessageEvent) => { if (event.data?.type === 'changes') setPayload(event.data) }
    window.addEventListener('message', receive)
    post('ready')
    return () => window.removeEventListener('message', receive)
  }, [])
  const files = parseDiff(payload?.diff || '')
  const total = files.reduce((sum: { added: number; deleted: number }, file: any) => ({ added: sum.added + file.additions, deleted: sum.deleted + file.deletions }), { added: 0, deleted: 0 })
  useEffect(() => { if (payload?.selectedPath) document.getElementById(`change-${files.findIndex((file: any) => file.path === payload.selectedPath)}`)?.scrollIntoView?.() }, [payload])
  return <main className="changes-viewer"><header className="changes-header">{files.length} 个文件已修改 <span className="plus">+{total.added}</span> <span className="minus">-{total.deleted}</span></header>{files.map((file: any, index: number) => <details className="changes-file" id={`change-${index}`} key={file.path} open={file.path === payload?.selectedPath}><summary className="changes-file-title"><span className="changes-path">{file.path}</span><span className="chevron" aria-hidden="true"/><span className="changes-count"><span className="plus">+{file.additions}</span> <span className="minus">-{file.deletions}</span></span></summary><Diff diff={file.diff} /></details>)}</main>
}
function TurnView({ turn }: { turn: any }) {
  const [processOpen, setProcessOpen] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!['starting', 'inProgress'].includes(turn.status)) return
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [turn.status])
  const items = turn.items || []
  const finalIndex = items.findIndex((item: any) => item.type === 'agentMessage' && item.raw?.phase === 'final_answer')
  const fallbackFinal = finalIndex >= 0 ? finalIndex : turn.status === 'completed' ? items.findLastIndex((item: any) => item.type === 'agentMessage') : -1
  const process: React.ReactNode[] = []
  let activities: any[] = []
  const flush = () => { if (activities.length) { process.push(<Activities key={`a${process.length}`} items={activities} turn={turn} />); activities = [] } }
  items.forEach((item: any, index: number) => {
    if (index === fallbackFinal) return
    if (item.type === 'contextCompaction') { flush(); process.push(<div key={item.id} className="compact-event"><Icon kind="compact" />{item.status === 'inProgress' ? '正在压缩上下文 · 可能需要几分钟' : item.status === 'failed' ? '上下文压缩失败' : item.status === 'interrupted' ? '上下文压缩已中断' : '已压缩上下文'}</div>); return }
    if (['commandExecution', 'fileChange', 'reasoning', 'dynamicToolCall', 'mcpToolCall', 'webSearch'].includes(item.type)) { activities.push(item); return }
    if (item.type === 'agentMessage' && item.text?.trim()) { flush(); process.push(<article key={item.id} className="assistant-comment"><Markdown text={item.text} /></article>) }
  })
  flush()
  const active = ['starting', 'inProgress'].includes(turn.status)
  if (active && !items.some((item: any) => item.type === 'contextCompaction' && item.status === 'inProgress')) process.push(<div key="thinking" className="thinking flowing">正在思考</div>)
  const final = items[fallbackFinal]
  const seconds = Math.max(0, Math.round(((turn.completedAt || Date.now()) - (turn.startedAt || Date.now())) / 1000))
  const elapsed = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
  const duration = `用时${elapsed}`
  const compactOnly = turn.status === 'completed' && !turn.user && items.some((item: any) => item.type === 'contextCompaction') && items.every((item: any) => ['contextCompaction', 'reasoning'].includes(item.type))
  const terminal = turn.status === 'interrupted' ? (turn.stopRequested === true ? `你在${elapsed}后停止了任务` : `任务在${elapsed}后${turn.stopRequested === false ? '意外' : ''}中断`) : turn.status === 'failed' ? `任务在${elapsed}后未能完成${turn.error?.message ? `：${turn.error.message}` : ''}` : duration
  return <section className="turn" data-turn-id={turn.id}>{(turn.user || turn.attachments?.length > 0) && <div className="user-message"><Attachments files={turn.attachments || []} post={post} />{turn.user && <Markdown text={turn.user} />}</div>}<div className="turn-content">{active ? <div className="process-section"><div className="process-toggle">正在处理 · {duration}</div><div className="process-content">{process}</div></div> : compactOnly ? <div className="process-content">{process}</div> : (process.length > 0 || ['interrupted', 'failed'].includes(turn.status)) && <div className="process-section"><button className="process-toggle" onClick={() => setProcessOpen(!processOpen)} disabled={!process.length}>{terminal}{process.length > 0 && <span className={`chevron ${processOpen ? 'expanded' : ''}`} />}</button>{processOpen && <div className="process-content">{process}</div>}</div>}{final?.text?.trim() && <article className="final-answer"><Markdown text={final.text} /></article>}{!active && <FileSummary turn={turn} />}</div></section>
}

function UserInputCard({ request }: { request: any }) {
  const questions = request.params?.questions || []
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {}
    for (const entry of questions) {
      const chosen = selection[entry.id]
      const text = (custom[entry.id] || '').trim()
      if (!chosen || chosen === '__custom__') {
        if (!text) { setError(`请输入“${entry.header || entry.question}”的回答`); return }
        answers[entry.id] = { answers: [`user_note: ${text}`] }
      } else {
        const note = (notes[entry.id] || '').trim()
        answers[entry.id] = { answers: note ? [chosen, `user_note: ${note}`] : [chosen] }
      }
    }
    setError('')
    post('answerUserInput', { id: request.id, answers })
  }
  return <div className="approval user-input-card"><strong>DiCode 需要你的回答</strong>
    {questions.map((entry: any) => <div className="user-input-question" key={entry.id}>
      <div className="question-title">{entry.question || entry.header}</div>
      {(entry.options || []).map((option: any) => <label className="user-input-option" key={option.label}>
        <input type="radio" name={entry.id} checked={selection[entry.id] === option.label} onChange={() => setSelection(previous => ({ ...previous, [entry.id]: option.label }))} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {!!entry.options?.length && <label className="user-input-option"><input type="radio" name={entry.id} checked={selection[entry.id] === '__custom__'} onChange={() => setSelection(previous => ({ ...previous, [entry.id]: '__custom__' }))} /><span>自定义回答</span></label>}
      {(!entry.options?.length || !selection[entry.id] || selection[entry.id] === '__custom__') ? <textarea className="user-input-custom" value={custom[entry.id] || ''} onChange={event => { setCustom(previous => ({ ...previous, [entry.id]: event.target.value })); if (entry.options?.length) setSelection(previous => ({ ...previous, [entry.id]: '__custom__' })) }} /> : <input className="user-input-note" placeholder="补充说明（可选）" value={notes[entry.id] || ''} onChange={event => setNotes(previous => ({ ...previous, [entry.id]: event.target.value }))} />}
    </div>)}
    {error && <div className="user-input-error" role="alert">{error}</div>}
    <div className="approval-actions"><button onClick={submit}>继续执行</button></div>
  </div>
}

function PageHeader({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  return <div className="subpage-header"><button className="back-button" title="返回首页" aria-label="返回首页" onClick={onBack}><Icon kind="back" /></button><h2>{title}</h2>{action && <div className="subpage-action">{action}</div>}</div>
}
function PageSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="search-box"><Icon kind="search" /><input className="page-search" placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /></label>
}
function ProfileAvatar({ picture }: { picture?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [picture])
  return <div className="profile-avatar">{picture && /^https:\/\//i.test(picture) && !failed ? <img src={picture} alt="头像" onError={() => setFailed(true)} /> : <Icon kind="user" />}</div>
}
function App() {
  const [state, setState] = useState<any>({ loggedIn: false, busy: false, models: [], threads: [], permissionMode: 'request' })
  const [revision, setRevision] = useState(0)
  const [model, setModel] = useState(vscode.getState?.()?.modelId || '')
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState('准备就绪')
  const [approval, setApproval] = useState<any>(null)
  const [question, setQuestion] = useState<any>(null)
  const [page, setPage] = useState<'home' | 'skills' | 'history' | 'notices' | 'profile'>('home')
  const [skillsTab, setSkillsTab] = useState<'installed' | 'all'>('installed')
  // 【全部】市场页签状态：数据源独立于【已安装】，互不请求（3.2）
  const [marketItems, setMarketItems] = useState<MarketSkill[]>([])
  const [marketPage, setMarketPage] = useState(0)
  const [marketTotal, setMarketTotal] = useState(0)
  const [marketHasNext, setMarketHasNext] = useState(false)
  const [marketLabelStats, setMarketLabelStats] = useState<Array<{ label: string; count: number }>>([])
  const [marketCachedAt, setMarketCachedAt] = useState<number | undefined>(undefined)
  const [marketStale, setMarketStale] = useState(false)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<MarketErrorView | null>(null)
  const [marketAuth, setMarketAuth] = useState({ loggedIn: false, baseUrlConfigured: true })
  const [marketDetail, setMarketDetail] = useState<MarketDetailData | null>(null)
  const [marketDetailLoading, setMarketDetailLoading] = useState(false)
  const [marketMessage, setMarketMessage] = useState('')
  const marketRequestRef = useRef({ query: '', label: '', sort: 'newest', page: 0 })
  const [marketParams, setMarketParams] = useState({ query: '', label: '', sort: 'newest' })
  const changeMarketParams = (partial: { query?: string; label?: string; sort?: string }) => setMarketParams(old => ({ ...old, ...partial }))
  const [search, setSearch] = useState('')
  const [images, setImages] = useState<any[]>([])
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [indexAvailable, setIndexAvailable] = useState(true)
  const [registryIgnored, setRegistryIgnored] = useState(true)
  const [registryRecovered, setRegistryRecovered] = useState(false)
  const marketInstalled = useMemo(() => marketInstalledIds(installed), [installed])
  const marketLocalDirs = useMemo(() => localDirBasenames(installed), [installed])
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null)
  const [pendingSkills, setPendingSkills] = useState<Record<string, boolean>>({})
  const [skillsMessage, setSkillsMessage] = useState('')
  const [notices, setNotices] = useState<Array<{ id: string; title: string; detail: string; at: number }>>([])
  const [planOpen, setPlanOpen] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(30)
  const [stopping, setStopping] = useState(false)
  const autoLanded = useRef(false)
  const messages = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const busy = state.busy || (store.turns.at(-1)?.status === 'starting' && state.busy !== false)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'state') {
        if (!autoLanded.current) { autoLanded.current = true; if (!msg.loggedIn) setPage('skills') }
        setState((old: any) => ({ ...old, ...msg })); if (msg.models?.length) setModel(current => msg.models.some((entry: any) => entry.id === current) ? current : msg.models[0].id); if (!msg.busy) { setStopping(false); const turn = store.turns.at(-1); if (turn && turn.id === msg.lastTurn?.id && ['starting', 'inProgress'].includes(turn.status) && ['failed', 'interrupted', 'completed'].includes(msg.lastTurn.status)) { turn.status = msg.lastTurn.status; turn.error = msg.lastTurn.error; turn.stopRequested = msg.lastTurn.stopRequested; turn.completedAt = Date.now(); setRevision(n => n + 1) } } }
      if (msg.type === 'skills') setSkillsMessage(msg.errors?.length ? '部分技能加载失败' : '')
      if (msg.type === 'installedSkills') {
        setInstalled(msg.skills || [])
        setIndexAvailable(msg.indexAvailable !== false)
        setRegistryIgnored(msg.registryIgnored !== false)
        setRegistryRecovered(msg.registryRecovered === true)
        setSkillsMessage(msg.indexAvailable === false ? `索引不可用：${msg.indexError || 'Codex CLI 未就绪'}` : '')
        setPendingSkills({})
      }
      if (msg.type === 'marketCatalog') {
        // 回带查询条件与最近一次请求不一致 → 过期响应，直接丢弃（第 6 节）
        const req = marketRequestRef.current
        if (msg.query !== req.query || msg.label !== req.label || msg.sort !== req.sort) return
        setMarketItems(prev => (msg.page > 0 && msg.page === req.page) ? [...prev, ...(msg.items || [])] : (msg.items || []))
        setMarketPage(msg.page || 0)
        setMarketTotal(msg.total || 0)
        setMarketHasNext(msg.hasNext === true)
        setMarketLabelStats(msg.labelStats || [])
        setMarketCachedAt(msg.cachedAt)
        setMarketStale(msg.stale === true)
        setMarketLoading(false)
        setMarketError(null)
      }
      if (msg.type === 'marketDetailResult') {
        setMarketDetail({ skillId: msg.skillId, skill: msg.skill, content: msg.content, versions: msg.versions, version: msg.version })
        setMarketDetailLoading(false)
        // 打开详情后把 publishedVersion 回填到列表卡片（3.2：列表接口不返回版本，14 #15）
        if (msg.skill?.version) setMarketItems(prev => prev.map(item => item.id === msg.skillId && !item.version ? { ...item, version: msg.skill.version } : item))
      }
      if (msg.type === 'marketAuthState') {
        setMarketAuth({ loggedIn: msg.loggedIn === true, baseUrlConfigured: msg.baseUrlConfigured !== false })
        if (msg.loggedIn === true) requestMarket({ query: '', label: '', sort: 'newest', page: 0 })
      }
      if (msg.type === 'marketError') {
        setMarketError({ scope: msg.scope, code: msg.code, message: msg.message, retryable: msg.retryable !== false, requiresLogin: msg.requiresLogin === true, captchaRequired: msg.captchaRequired === true })
        if (msg.scope === 'detail') setMarketDetailLoading(false)
        if (msg.scope === 'auth' || msg.code === 'UNAUTHORIZED') setMarketAuth(old => ({ ...old, loggedIn: false }))
        if (msg.scope === 'catalog') setMarketLoading(false)
      }
      if (msg.type === 'skillsNotice') setMarketMessage(msg.message || '')
      if (msg.type === 'skillDetail') setSkillDetail(msg.detail || null)
      if (msg.type === 'skillImported') { setSkillsMessage(`已导入 ${msg.dir}`); setSkillDetail(null) }
      if (msg.type === 'skillDeleted') { setSkillsMessage(`已删除 ${msg.dir}`); setSkillDetail(current => current?.dir === msg.dir ? null : current) }
      if (msg.type === 'skillsError') {
        setSkillsMessage(msg.message)
        if (msg.action === 'toggle' && msg.dir) setPendingSkills(current => { const next = { ...current }; delete next[msg.dir]; return next })
      }
      if (msg.type === 'imagesSelected' || msg.type === 'filesSelected') setImages(old => [...old, ...msg.images.filter((image: any) => !old.some(item => item.path === image.path))])
      if (msg.type === 'history') { store.restore(msg.snapshot); setRevision(n => n + 1) }
      if (msg.type === 'tokenUsage') setState((old: any) => ({ ...old, tokenUsage: msg.tokenUsage }))
      if (msg.type === 'rpc') {
        if (msg.method !== 'serverRequest/resolved') { store.receive(msg.method, msg.params); setRevision(n => n + 1) }
        else { setApproval((old: any) => String(old?.id) === String(msg.params?.requestId) ? null : old); setQuestion((old: any) => String(old?.id) === String(msg.params?.requestId) ? null : old) }
        if (msg.method === 'turn/started') setStatus('正在处理…')
        if (msg.method === 'turn/completed') setStatus(msg.params?.turn?.status === 'completed' ? '已完成 · 可以继续提问' : '任务已结束')
      }
      if (msg.type === 'approval') setApproval(msg)
      if (msg.type === 'approvalsCleared') setApproval(null)
      if (msg.type === 'userInputRequest') { setQuestion(msg) }
      if (msg.type === 'userInputsCleared') setQuestion(null)
      if (msg.type === 'notice') setStatus(msg.message)
      if (msg.type === 'error') { setStatus(`错误：${msg.message}`); if (msg.requestType === 'send') { const turn = store.turns.at(-1); if (turn?.status === 'starting') { turn.status = 'failed'; turn.error = { message: msg.message }; turn.completedAt = Date.now(); setRevision(n => n + 1) } } }
      if (msg.type === 'stopped') { setStopping(false); setStatus(msg.message || '已停止') }
    }
    window.addEventListener('message', receive)
    post('ready')
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => { if (follow.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight }, [revision, state.busy])
  const send = (effort: string) => { const text = prompt.trim(); if ((!text && !images.length) || !state.models?.some((entry: any) => entry.id === model) || busy) return; store.begin(text, images); setRevision(n => n + 1); setPrompt(''); setState((old: any) => ({ ...old, busy: true })); setStatus('正在连接 Agent…'); follow.current = true; post('send', { text, model, effort, images: images.filter(image => !image.id).map(image => image.data), attachments: images.filter(image => image.id).map(image => image.id) }); setImages([]) }
  const navigate = (next: RailPage) => {
    setPage(next)
    setSkillDetail(null)
    if (next === 'skills') { setSkillsTab('installed'); setSkillsMessage('正在加载…'); post('installedSkills') }
  }
  const toggleSkill = (skill: InstalledSkill) => {
    // 乐观更新 + 逐项 pending，失败由 skillsError 回滚并提示（9.4）
    setPendingSkills(current => ({ ...current, [skill.dir]: true }))
    setInstalled(current => current.map(item => item.dir === skill.dir ? { ...item, enabled: !item.enabled } : item))
    post('setSkillEnabled', { dir: skill.dir, path: skill.path, enabled: skill.enabled !== true })
  }
  const requestMarket = (params: { query?: string; label?: string; sort?: string; page?: number }) => {
    marketRequestRef.current = { query: params.query || '', label: params.label || '', sort: params.sort || 'newest', page: params.page || 0 }
    if ((params.page || 0) === 0) { setMarketLoading(true); setMarketError(null) }
    post('marketList', params)
  }
  const openMarketDetail = (skillId: string) => { setMarketDetailLoading(true); post('marketDetail', { skillId }) }
  const selectMarketVersion = (skillId: string, version: string) => { if (version) { setMarketDetailLoading(true); post('marketDetail', { skillId, version }) } }
  const latest = store.turns.at(-1)
  const plan = busy && latest?.plan?.steps?.length ? latest.plan : null
  const matchingThreads = (state.threads || []).filter((thread: any) => !search.trim() || [thread.title, ...(thread.turns || []).flatMap((turn: any) => [turn.user, turn.answer])].some(value => String(value || '').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  return <div className="workspace-shell">
    <NavRail page={page} onNavigate={navigate} onProfile={() => setPage('profile')} onSettings={() => post('openSettings')} historyUnread={state.historyUnread} noticesUnread={notices.length > 0} />
    <div className="workspace-main">
      {page === 'history' ? <main className="subpage"><PageHeader title="历史会话" onBack={() => setPage('home')} /><PageSearch placeholder="搜索标题、输入和回答" value={search} onChange={setSearch} /><HistoryList onRename={(threadId, title) => post('renameThread', { threadId, title })} threads={matchingThreads} query={search} currentId={state.threadId} Icon={Icon} onSelect={threadId => { post('switchThread', { threadId }); setPage('home') }} /></main>
      : page === 'skills' ? <main className="subpage skill-hub">
          <PageHeader title="Skill 市场" onBack={() => setPage('home')} action={<button className="ghost-button" onClick={() => post('installedSkills')}><Icon kind="refresh" />刷新</button>} />
          <div className="list-tabs skill-tabs" aria-label="技能页签">
            <button aria-pressed={skillsTab === 'all'} className={skillsTab === 'all' ? 'active' : ''} onClick={() => setSkillsTab('all')}>全部</button>
            <button aria-pressed={skillsTab === 'installed'} className={skillsTab === 'installed' ? 'active' : ''} onClick={() => setSkillsTab('installed')}>已安装<span>{installed.length}</span></button>
          </div>
          {skillsTab === 'installed'
            ? <Installed
                skills={installed}
                indexAvailable={indexAvailable}
                message={skillsMessage}
                detail={skillDetail}
                pending={pendingSkills}
                showIgnoreHint={!registryIgnored}
                onImport={mode => { setSkillsMessage(''); post('importSkill', { mode }) }}
                onToggle={toggleSkill}
                onDelete={skill => post('deleteSkill', { dir: skill.dir })}
                onReimport={skill => { setSkillsMessage(''); post('reimportSkill', { dir: skill.dir }) }}
                onUnregister={skill => post('unregisterSkill', { dir: skill.dir })}
                onDetail={skill => post('getSkillDetail', { dir: skill.dir })}
                onCloseDetail={() => setSkillDetail(null)}
                onIgnoreRegistry={() => post('ignoreRegistry')}
              />
            : <Market
                items={marketItems}
                total={marketTotal}
                page={marketPage}
                hasNext={marketHasNext}
                labelStats={marketLabelStats}
                cachedAt={marketCachedAt}
                stale={marketStale}
                loading={marketLoading}
                error={marketError}
                message={marketMessage}
                auth={marketAuth}
                detail={marketDetail}
                detailLoading={marketDetailLoading}
                installedIds={marketInstalled}
                localDirs={marketLocalDirs}
                query={marketParams.query}
                label={marketParams.label}
                sort={marketParams.sort}
                onParamsChange={changeMarketParams}
                onRequest={requestMarket}
                onOpenDetail={openMarketDetail}
                onCloseDetail={() => setMarketDetail(null)}
                onSelectVersion={selectMarketVersion}
                onInstall={() => post('marketInstall')}
                onLogin={(username, password) => post('marketLogin', { username, password })}
                onLogout={() => post('marketLogout')}
                onGoInstalled={() => setSkillsTab('installed')}
              />}
        </main>
      : page === 'notices' ? <main className="subpage"><PageHeader title="消息提醒" onBack={() => setPage('home')} /><div className="page-empty-state"><Icon kind="bell" /><strong>暂无消息</strong><p>任务与待决策的提醒会出现在这里。</p></div></main>
      : page === 'profile' ? <main className="subpage"><PageHeader title="个人信息" onBack={() => setPage('home')} /><div className="account-panel"><div className="account-identity"><ProfileAvatar picture={state.user?.picture} /><strong>{state.user?.name || (state.loggedIn ? '姓名未提供' : '未登录')}</strong><span className="account-status"><i />{state.loggedIn ? '已连接 DiCode' : '尚未连接'}</span></div><div className="account-details"><div><span>姓名</span><strong>{state.user?.name || '—'}</strong></div><div><span>邮箱</span><strong>{state.user?.email || '—'}</strong></div></div><button className="account-login" onClick={() => post('login')}><Icon kind="user" />{state.loggedIn ? '重新登录' : '登录 DiCode'}<Icon kind="right" /></button>{registryRecovered && <p className="muted">安装登记文件曾损坏，已备份为 .bak 并继续使用空登记。</p>}</div></main>
      : !state.loggedIn ? <div className="login"><h2>让想法成为代码。</h2><p>登录后，在当前工作区和 DiCode 一起完成任务。</p><button className="primary" onClick={() => post('login')}>登录 DiCode</button></div> : <main className="app"><div className="toolbar"><span className="workspace">{state.workspace || '未打开工作区'}</span></div><div className="conversation-area"><div className="messages" ref={messages} onScroll={() => { const node = messages.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>{store.turns.length > visibleLimit && <button className="earlier" onClick={() => setVisibleLimit(n => n + 30)}>显示更早的消息</button>}{store.turns.length ? store.turns.slice(-visibleLimit).map((turn: any) => <TurnView key={turn.id} turn={turn} />) : <div className="empty"><div><Icon kind="brand" /></div><h2>从一个问题开始</h2><p>描述任务，DiCode 会在工作区中逐步完成。</p></div>}</div></div>{approval && <div className="approval"><strong>需要授权</strong><p>{approval.params?.reason || approval.params?.command || approval.params?.path || '继续执行此操作？'}</p><div className="approval-actions">{(approval.params?.availableDecisions || ['accept', 'decline']).map((decision: any) => { const value = typeof decision === 'string' ? decision : decision.decision; return <button key={value} onClick={() => post('approve', { id: approval.id, decision: value })}>{value === 'accept' ? '允许' : value === 'decline' ? '拒绝' : value}</button> })}</div></div>}{question && <UserInputCard key={question.id} request={question} />}{plan && <div className="plan-dock"><button onClick={() => setPlanOpen(!planOpen)}>执行计划 · {plan.steps.filter((step: any) => step.status === 'completed').length}/{plan.steps.length} <span className={`chevron ${planOpen ? 'up' : ''}`} /></button>{planOpen && <ol>{plan.steps.map((step: any, i: number) => <li key={i}>{step.step || step.text}</li>)}</ol>}</div>}<Composer images={images} setImages={setImages} state={state} model={model} setModel={setModel} prompt={prompt} setPrompt={setPrompt} busy={busy} stopping={stopping} status={status} send={send} post={(type, data) => { if (type === "stop") setStopping(true); post(type, data) }} persistModel={modelId => vscode.setState?.({ modelId })} /></main>}
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(document.querySelector<HTMLMetaElement>('meta[name="dicode-view"][content="changes"]') ? <ChangesViewer /> : <App />)
