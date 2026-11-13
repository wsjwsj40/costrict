import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownIt from 'markdown-it'
import Composer from './Composer'
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
const post = (type: string, data: Record<string, unknown> = {}) => vscode.postMessage({ type, ...data })
const editTools = new Set(['write_file', 'replace_file_text', 'delete_file'])
const iconPaths: Record<string, string> = {
  brand: 'M3.2 17.7 9 5.8c.8-1.7 2.5-2.1 3.7-.7l3.1 3.7 M3.2 17.7c-.8 1.7.3 3 2.3 2.4l10-3.7c2.1-.8 3.5-.4 4.4 1.1 M20 9.2v7.9c0 3.1-2.8 3.7-4.5 1.9 M20 4.2h.01',
  edit: 'M3 11.5 2.5 14l2.5-.5 8.1-8.1-2-2L3 11.5Zm7.2-8.1 1.4-1.4a1.4 1.4 0 0 1 2 2l-1.4 1.4',
  command: 'M2 3.2h12v9.6H2zM4.5 6l2.2 2-2.2 2M8.5 10h3',
  copy: 'M5 4h8v10H5zM3 11H2V2h8v1',
  changes: 'M3 2.5h7l3 3v8H3zM9.5 2.5v3H13M5.5 9h5M5.5 11.5h4',
  history: 'M8 2a6 6 0 1 1-5.7 4M8 4v4l2.5 1.5M2 3v3h3',
  new: 'M2.5 2.5h11v11h-11zM8 5v6M5 8h6',
  compact: 'M4 2h8M4 14h8M3 3v10M6 5h6M6 8h5M6 11h6M1.5 5h2M1.5 11h2',
}
function Icon({ kind }: { kind: string }) { if (kind === 'brand') return <svg className="icon" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="M5 47 23 13c3-6 8-7 12-2l11 13c2 3-1 7-4 5l-10-6c-2-1-4-1-5 1l-9 14 21-6c6-2 10 0 12 4V24c0-4 3-6 6-6s5 3 5 7v23c0 9-8 12-14 7l-5-5c-2-2-4-2-7-1L14 58C5 61 1 55 5 47Z"/><circle cx="56" cy="9" r="6"/></svg>; return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[kind] || iconPaths.command} /></svg> }
function Markdown({ text }: { text: string }) {
  const onClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement
    const link = target.closest('a[href]') as HTMLAnchorElement | null
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; post(link.classList.contains('local-file-link') ? 'openFile' : 'openLink', link.classList.contains('local-file-link') ? { path: href } : { href }); return }
    const code = target.closest('code')
    if (code && !code.closest('pre') && /^(?:(?:[A-Za-z]:)?[\\/]|\.\.?[\\/])?(?:[^\\/]+[\\/])*[^\\/]+\.[\w-]+(?::\d+|#L\d+)?$/.test(code.textContent || '')) post('openFile', { path: code.textContent || '' })
  }
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: md.render(text || '') }} />
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
  return <main className="changes-viewer"><header className="changes-header">{files.length} 个文件已修改 <span className="plus">+{total.added}</span> <span className="minus">-{total.deleted}</span></header>{files.map((file: any, index: number) => <details className="changes-file" id={`change-${index}`} key={file.path} open={file.path === payload?.selectedPath}><summary className="changes-file-title">{file.path}<span><span className="plus">+{file.additions}</span> <span className="minus">-{file.deletions}</span></span></summary><Diff diff={file.diff} /></details>)}</main>
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
    if (item.type === 'contextCompaction') { flush(); process.push(<div key={item.id} className="compact-event"><Icon kind="compact" />{item.status === 'inProgress' ? '正在压缩上下文 · 可能需要几分钟' : item.status === 'failed' ? '上下文压缩失败' : '已压缩上下文'}</div>); return }
    if (['commandExecution', 'fileChange', 'reasoning', 'dynamicToolCall', 'mcpToolCall', 'webSearch'].includes(item.type)) { activities.push(item); return }
    if (item.type === 'agentMessage' && item.text?.trim()) { flush(); process.push(<article key={item.id} className="assistant-comment"><Markdown text={item.text} /></article>) }
  })
  flush()
  const active = ['starting', 'inProgress'].includes(turn.status)
  if (active && !items.some((item: any) => item.type === 'contextCompaction' && item.status === 'inProgress')) process.push(<div key="thinking" className="thinking flowing">正在思考</div>)
  const final = items[fallbackFinal]
  const seconds = Math.max(0, Math.round(((turn.completedAt || Date.now()) - (turn.startedAt || Date.now())) / 1000))
  const duration = seconds < 60 ? `用时${seconds}秒` : `用时${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
  return <section className="turn" data-turn-id={turn.id}>{turn.user && <div className="user-message"><Markdown text={turn.user} /></div>}<div className="turn-content">{active ? <div className="process-section"><div className="process-toggle">正在处理 · {duration}</div><div className="process-content">{process}</div></div> : process.length > 0 && <div className="process-section"><button className="process-toggle" onClick={() => setProcessOpen(!processOpen)}>{duration}<span className={`chevron ${processOpen ? 'expanded' : ''}`} /></button>{processOpen && <div className="process-content">{process}</div>}</div>}{final?.text?.trim() && <article className="final-answer"><Markdown text={final.text} /></article>}{!active && <FileSummary turn={turn} />}</div></section>
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

function App() {
  const [state, setState] = useState<any>({ loggedIn: false, busy: false, models: [], threads: [], permissionMode: 'request' })
  const [revision, setRevision] = useState(0)
  const [model, setModel] = useState(vscode.getState?.()?.modelId || '')
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState('准备就绪')
  const [approval, setApproval] = useState<any>(null)
  const [question, setQuestion] = useState<any>(null)
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [visibleLimit, setVisibleLimit] = useState(30)
  const [stopping, setStopping] = useState(false)
  const messages = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const busy = state.busy || (store.turns.at(-1)?.status === 'starting' && state.busy !== false)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'state') { setState((old: any) => ({ ...old, ...msg })); if (msg.models?.length) setModel(current => msg.models.some((entry: any) => entry.id === current) ? current : msg.models[0].id); if (!msg.busy) { setStopping(false); const turn = store.turns.at(-1); if (turn && turn.id === msg.lastTurn?.id && ['starting', 'inProgress'].includes(turn.status) && ['failed', 'interrupted', 'completed'].includes(msg.lastTurn.status)) { turn.status = msg.lastTurn.status; turn.completedAt = Date.now(); setRevision(n => n + 1) } } }
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
      if (msg.type === 'error') { setStatus(`错误：${msg.message}`); if (msg.requestType === 'send') { const turn = store.turns.at(-1); if (turn?.status === 'starting') { turn.status = 'failed'; turn.completedAt = Date.now(); setRevision(n => n + 1) } } }
      if (msg.type === 'stopped') { setStopping(false); setStatus(msg.message || '已停止') }
    }
    window.addEventListener('message', receive)
    post('ready')
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => { if (follow.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight }, [revision, state.busy])
  const send = (effort: string) => { const text = prompt.trim(); if (!text || !state.models?.some((entry: any) => entry.id === model) || busy) return; store.begin(text); setRevision(n => n + 1); setPrompt(''); setState((old: any) => ({ ...old, busy: true })); setStatus('正在连接 Agent…'); follow.current = true; post('send', { text, model, effort }) }
  const latest = store.turns.at(-1)
  const plan = busy && latest?.plan?.steps?.length ? latest.plan : null
  return <><header className="topbar"><span className="brand"><Icon kind="brand" /><strong>DiCode</strong></span><div className="top-actions"><button title="最近会话" onClick={() => setThreadsOpen(!threadsOpen)}><Icon kind="history" /></button><button title="新会话" onClick={() => { if (!busy) { store.reset(); setRevision(n => n + 1); post('newThread') } }}><Icon kind="new" /></button></div></header>{!state.loggedIn ? <div className="login"><h2>让想法成为代码。</h2><p>登录后，在当前工作区和 DiCode 一起完成任务。</p><button className="primary" onClick={() => post('login')}>登录 DiCode</button></div> : <main className="app"><div className="toolbar"><span className="workspace">{state.workspace || '未打开工作区'}</span><button onClick={() => { store.reset(); setRevision(n => n + 1); post('logout') }}>退出</button></div>{threadsOpen && <nav className="thread-list">{(state.threads || []).map((thread: any) => <button key={thread.id} onClick={() => { if (!busy) { setThreadsOpen(false); post('switchThread', { threadId: thread.id }) } }}>{thread.title || '新会话'}</button>)}</nav>}<div className="conversation-area"><div className="messages" ref={messages} onScroll={() => { const node = messages.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>{store.turns.length > visibleLimit && <button className="earlier" onClick={() => setVisibleLimit(n => n + 30)}>显示更早的消息</button>}{store.turns.length ? store.turns.slice(-visibleLimit).map((turn: any) => <TurnView key={turn.id} turn={turn} />) : <div className="empty"><div><Icon kind="brand" /></div><h2>从一个问题开始</h2><p>描述任务，DiCode 会在工作区中逐步完成。</p></div>}</div></div>{approval && <div className="approval"><strong>需要授权</strong><p>{approval.params?.reason || approval.params?.command || approval.params?.path || '继续执行此操作？'}</p><div className="approval-actions">{(approval.params?.availableDecisions || ['accept', 'decline']).map((decision: any) => { const value = typeof decision === 'string' ? decision : decision.decision; return <button key={value} onClick={() => post('approve', { id: approval.id, decision: value })}>{value === 'accept' ? '允许' : value === 'decline' ? '拒绝' : value}</button> })}</div></div>}{question && <UserInputCard key={question.id} request={question} />}{plan && <div className="plan-dock"><button onClick={() => setPlanOpen(!planOpen)}>执行计划 · {plan.steps.filter((step: any) => step.status === 'completed').length}/{plan.steps.length} <span className={`chevron ${planOpen ? 'up' : ''}`} /></button>{planOpen && <ol>{plan.steps.map((step: any, i: number) => <li key={i}>{step.step || step.text}</li>)}</ol>}</div>}<Composer state={state} model={model} setModel={setModel} prompt={prompt} setPrompt={setPrompt} busy={busy} stopping={stopping} status={status} send={send} post={(type, data) => { if (type === "stop") setStopping(true); post(type, data) }} persistModel={modelId => vscode.setState?.({ modelId })} /></main>}</>
}

createRoot(document.getElementById('root')!).render(document.querySelector('meta[name="dicode-view"][content="changes"]') ? <ChangesViewer /> : <App />)
