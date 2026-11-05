const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js/lib/core')
hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'))
hljs.registerLanguage('typescript', require('highlight.js/lib/languages/typescript'))
hljs.registerLanguage('python', require('highlight.js/lib/languages/python'))
hljs.registerLanguage('java', require('highlight.js/lib/languages/java'))
hljs.registerLanguage('go', require('highlight.js/lib/languages/go'))
hljs.registerLanguage('rust', require('highlight.js/lib/languages/rust'))
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'))
hljs.registerLanguage('json', require('highlight.js/lib/languages/json'))
hljs.registerLanguage('yaml', require('highlight.js/lib/languages/yaml'))
hljs.registerLanguage('sql', require('highlight.js/lib/languages/sql'))
const { ConversationStore, parseDiff } = require('./conversation')
const vscode = acquireVsCodeApi()
const $ = id => document.getElementById(id)
const store = new ConversationStore()
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx], lang = token.info.trim().split(/\s+/)[0].toLowerCase()
  const alias = { ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', yml: 'yaml', rs: 'rust' }[lang] || lang
  const code = token.content
  const highlighted = hljs.getLanguage(alias) ? hljs.highlight(code, { language: alias, ignoreIllegals: true }).value : markdown.utils.escapeHtml(code)
  return `<div class="code-block"><div class="code-head"><span>${markdown.utils.escapeHtml(lang || 'text')}</span><button class="copy-code" data-code="${idx}" title="复制代码">复制</button></div><pre><code>${highlighted}</code></pre></div>`
}
const oldLinkOpen = markdown.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
markdown.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return oldLinkOpen(tokens, idx, opts, env, self)
}
let busy = false, activeApproval = null, approvalQueue = [], scheduled = false
const openDetails = new Set()
const turnNodes = new Map(), dirtyTurns = new Set()
function post(type, extra = {}) { vscode.postMessage({ type, ...extra }) }
function element(tag, className = '', text = '') { const e = document.createElement(tag); e.className = className; e.textContent = text; return e }
function button(label, click, className = '') { const e = element('button', className, label); e.onclick = click; return e }
function nearBottom() { const e = $('messages'); return e.scrollHeight - e.scrollTop - e.clientHeight < 70 }
function schedule() { if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; render() }, 32) }
function markdownView(text) {
  const div = element('div', 'markdown')
  div.innerHTML = markdown.render(text || '')
  const fences = [...div.querySelectorAll('.code-block')]
  const tokens = markdown.parse(text || '', {})
  const code = tokens.filter(t => t.type === 'fence')
  fences.forEach((block, i) => { block.querySelector('button').onclick = () => navigator.clipboard.writeText(code[i]?.content || '') })
  div.querySelectorAll('a[href]').forEach(a => { a.onclick = ev => { ev.preventDefault(); post('openLink', { href: a.getAttribute('href') }) } })
  div.querySelectorAll('code').forEach(code => {
    if (code.closest('pre')) return
    if (/^(?:[\w.\-]+[\\/])+[\w.\-]+(?::\d+|#L\d+)?$/.test(code.textContent)) {
      code.classList.add('file-ref')
      code.onclick = () => post('openFile', { path: code.textContent })
    }
  })
  return div
}
function detail(key, label, body, className = '') {
  const d = element('details', `activity ${className}`)
  d.open = openDetails.has(key)
  d.ontoggle = () => { if (d.open) openDetails.add(key); else openDetails.delete(key) }
  const summary = element('summary', '', label)
  d.append(summary, body)
  return d
}
function statusText(item) {
  const status = item.status || 'inProgress'
  return ({ inProgress: '运行中', completed: '完成', failed: '失败', declined: '已拒绝' })[status] || status
}
function commandTitle(raw) {
  const actions = raw.commandActions || []
  const types = actions.map(a => typeof a === 'string' ? a : a.type || a.kind)
  if (types.some(x => /read/i.test(x))) return '读取文件'
  if (types.some(x => /search/i.test(x))) return '搜索代码'
  if (types.some(x => /list/i.test(x))) return '列出文件'
  return '执行命令'
}
function stripAnsi(text) { return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') }
function commandView(item, turn) {
  const raw = item.raw || {}, body = element('div', 'activity-body')
  const cmd = raw.command || ''
  const meta = element('div', 'muted', [raw.cwd, raw.exitCode !== undefined ? `退出码 ${raw.exitCode}` : '', raw.durationMs !== undefined ? `${raw.durationMs} ms` : ''].filter(Boolean).join(' · '))
  const cmdPre = element('pre', 'command-text', cmd)
  body.append(meta, cmdPre, button('复制命令', () => navigator.clipboard.writeText(cmd), 'subtle'))
  if (item.output) {
    body.append(element('div', 'muted', '输出'), element('pre', 'command-output', stripAnsi(item.output)), button('复制输出', () => navigator.clipboard.writeText(stripAnsi(item.output)), 'subtle'))
  }
  const label = `⌘  ${commandTitle(raw)}  ·  ${statusText(item)}  ${cmd ? '· ' + cmd.slice(0, 65) : ''}`
  return detail(`${turn.id}:${item.id}`, label, body, item.status === 'failed' ? 'failed' : '')
}
function diffLines(diff) {
  const pre = element('pre', 'diff')
  for (const line of String(diff || '').split('\n')) {
    const span = element('span', line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'deleted' : line.startsWith('@@') ? 'hunk' : '', line + '\n')
    pre.appendChild(span)
  }
  return pre
}
function fileSummary(turn) {
  let files = parseDiff(turn.diff)
  if (!files.length) {
    files = (turn.items || []).filter(item => item.type === 'fileChange').flatMap(item => (item.raw?.changes || []).flatMap(change => {
      const filePath = change.path || change.filePath
      if (!filePath || !change.diff) return []
      const patch = change.diff.startsWith('diff --git ') ? change.diff : `diff --git a/${filePath} b/${filePath}\n${change.diff}`
      return parseDiff(patch)
    }))
    files = [...new Map(files.map(file => [file.path, file])).values()]
  }
  if (!files.length) return null
  const root = element('section', 'file-summary')
  const plus = files.reduce((n, f) => n + f.additions, 0), minus = files.reduce((n, f) => n + f.deletions, 0)
  root.append(element('div', 'file-heading', `${files.length} 个文件变更  +${plus}  -${minus}`))
  for (const file of files) {
    const body = element('div', 'file-body')
    body.append(button('打开文件', () => post('openFile', { path: file.path }), 'subtle'), button('在编辑器中比较', () => post('openDiff', { path: file.path, diff: file.diff }), 'subtle'), button('复制 Diff', () => navigator.clipboard.writeText(file.diff), 'subtle'), diffLines(file.diff))
    root.append(detail(`${turn.id}:diff:${file.path}`, `▤  ${file.path}  ·  ${file.kind}  +${file.additions} -${file.deletions}`, body, 'file-card'))
  }
  return root
}
function fileItem(item, turn) {
  const changes = item.raw?.changes || []
  const body = element('div', 'activity-body')
  for (const change of changes) {
    const path = change.path || change.filePath || ''
    const row = element('div', 'file-row', `${change.kind || 'modified'}  ${path}`)
    if (path) row.append(button('打开', () => post('openFile', { path }), 'subtle'))
    body.append(row)
    if (change.diff) body.append(diffLines(change.diff))
  }
  return detail(`${turn.id}:${item.id}`, `▤  修改文件 · ${statusText(item)} · ${changes.length} 个文件`, body)
}
function toolView(item, turn) {
  const raw = item.raw || {}, names = { mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', webSearch: '网页搜索', imageView: '查看图片', collabToolCall: '协作任务', contextCompaction: '整理上下文' }
  const title = names[item.type] || item.type
  const descriptor = [raw.server, raw.tool, raw.query].filter(Boolean).join(' · ')
  const body = element('div', 'activity-body')
  const data = JSON.stringify(raw, null, 2)
  body.append(element('pre', 'tool-json', data), button('复制详情', () => navigator.clipboard.writeText(data), 'subtle'))
  return detail(`${turn.id}:${item.id}`, `◇  ${title} · ${statusText(item)} ${descriptor ? '· ' + descriptor : ''}`, body)
}
function planView(plan) {
  if (!plan?.steps?.length) return null
  const box = element('section', 'plan')
  box.append(element('div', 'section-title', '执行计划'))
  if (plan.explanation) box.append(element('p', 'muted', plan.explanation))
  for (const step of plan.steps) {
    const status = step.status || 'pending'
    box.append(element('div', `plan-step ${status}`, `${status === 'completed' ? '✓' : status === 'inProgress' ? '◉' : '○'}  ${step.step || step.text || ''}`))
  }
  return box
}
function itemView(item, turn) {
  if (item.type === 'agentMessage') { const box = element('article', `agent ${item.raw?.phase === 'final_answer' ? 'final-answer' : ''}`); box.append(markdownView(item.text)); return box }
  if (item.type === 'reasoning') return item.summary ? detail(`${turn.id}:${item.id}`, '◌  思考摘要', markdownView(item.summary), 'reasoning') : null
  if (item.type === 'commandExecution') return commandView(item, turn)
  if (item.type === 'fileChange') return fileItem(item, turn)
  return toolView(item, turn)
}
function render() {
  const list = $('messages'), follow = nearBottom()
  if (!store.turns.length) { list.replaceChildren($('emptyTemplate').content.cloneNode(true)); turnNodes.clear(); return }
  list.querySelector('.empty')?.remove()
  const present = new Set(store.turns.map(t => t.id))
  for (const [id, node] of turnNodes) if (!present.has(id)) { node.remove(); turnNodes.delete(id) }
  for (const turn of store.turns) {
    if (turnNodes.has(turn.id) && !dirtyTurns.has(turn.id)) continue
    const section = element('section', 'turn')
    if (turn.user) { const user = element('div', 'user-message'); user.append(element('div', 'speaker', '你'), markdownView(turn.user)); section.append(user) }
    const content = element('div', 'turn-content')
    const finalItems = []
    for (const item of turn.items || []) {
      if (item.type === 'agentMessage' && item.raw?.phase === 'final_answer') { finalItems.push(item); continue }
      const node = itemView(item, turn); if (node) content.append(node)
    }
    const plan = planView(turn.plan)
    if (plan) content.append(plan)
    const files = fileSummary(turn)
    if (files) content.append(files)
    for (const item of finalItems) content.append(itemView(item, turn))
    if (turn.status === 'inProgress' || turn.status === 'starting') content.append(element('div', 'working', '◌  DiCode 正在处理…'))
    if (turn.error) content.append(element('div', 'turn-error', turn.error.message || String(turn.error)))
    section.append(content)
    const previous = turnNodes.get(turn.id)
    if (previous) previous.replaceWith(section); else list.append(section)
    turnNodes.set(turn.id, section)
  }
  dirtyTurns.clear()
  if (follow) list.scrollTop = list.scrollHeight
}
function setState(state) {
  $('login').hidden = state.loggedIn; $('app').hidden = !state.loggedIn
  busy = state.busy; $('send').hidden = busy; $('stop').hidden = !busy
  $('workspace').textContent = state.workspace || '未打开工作区'
  const previous = $('model').value
  $('model').replaceChildren()
  for (const model of state.models || []) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name || model.id; $('model').append(option) }
  if ([...$('model').options].some(option => option.value === previous)) $('model').value = previous
  store.threadId = state.threadId || null
  const list = $('threadList')
  list.replaceChildren()
  if (!(state.threads || []).length) list.append(element('div', 'thread-empty', '还没有历史会话'))
  for (const thread of state.threads || []) {
    const entry = button(thread.title || '新会话', () => {
      list.hidden = true
      if (thread.id !== store.threadId && !busy) post('switchThread', { threadId: thread.id })
    }, `thread-entry ${thread.id === store.threadId ? 'selected' : ''}`)
    entry.title = thread.title || '新会话'
    list.append(entry)
  }
}
function approvalView(message) {
  if (activeApproval) { approvalQueue.push(message); return }
  activeApproval = message
  const box = $('approval'), params = message.params || {}
  box.replaceChildren()
  box.append(element('strong', '', message.method.includes('command') ? '批准执行命令' : '批准修改文件'))
  box.append(element('pre', '', params.command || params.reason || JSON.stringify(params, null, 2)))
  const actions = element('div', 'approval-actions')
  const labels = { accept: '允许本次', acceptForSession: '允许本次会话', decline: '拒绝', cancel: '取消' }
  for (const decision of params.availableDecisions || ['accept', 'decline']) {
    const value = typeof decision === 'string' ? decision : decision.decision
    if (!value) continue
    actions.append(button(labels[value] || value, () => {
      post('approve', { id: message.id, decision: value })
      activeApproval = null; box.hidden = true
      if (approvalQueue.length) approvalView(approvalQueue.shift())
    }, value.startsWith('accept') ? 'primary' : ''))
  }
  box.append(actions); box.hidden = false
}
window.addEventListener('message', event => {
  const msg = event.data
  if (msg.type === 'state') setState(msg)
  if (msg.type === 'history') { store.restore(msg.snapshot); turnNodes.clear(); $('messages').replaceChildren(); for (const turn of store.turns) dirtyTurns.add(turn.id); schedule() }
  if (msg.type === 'notice') $('status').textContent = msg.message
  if (msg.type === 'error') { $('status').textContent = `错误：${msg.message}`; const turn = store.turns.at(-1); if (turn && busy) { turn.error = { message: msg.message }; turn.status = 'failed'; dirtyTurns.add(turn.id); schedule() } }
  if (msg.type === 'approval') approvalView(msg)
  if (msg.type === 'rpc') {
    if (msg.method === 'serverRequest/resolved') {
      const id = String(msg.params?.requestId ?? msg.params?.id)
      for (let i = approvalQueue.length - 1; i >= 0; i--) if (String(approvalQueue[i].id) === id) approvalQueue.splice(i, 1)
      if (String(activeApproval?.id) === id) { activeApproval = null; $('approval').hidden = true; if (approvalQueue.length) approvalView(approvalQueue.shift()) }
    } else {
      const turn = store.receive(msg.method, msg.params)
      dirtyTurns.add(turn.id)
      if (msg.method === 'turn/completed') {
        $('status').textContent = msg.params?.turn?.status === 'completed' ? '已完成' : `任务${msg.params?.turn?.status || '结束'}`
      }
      schedule()
    }
  }
})
$('loginButton').onclick = () => post('login')
$('logout').onclick = () => { store.reset(); render(); post('logout') }
$('newThread').onclick = () => { if (!busy) { store.reset(); render(); post('newThread') } }
$('threadsButton').onclick = () => { $('threadList').hidden = !$('threadList').hidden }
$('send').onclick = () => {
  const text = $('prompt').value.trim(), model = $('model').value
  if (!text || !model || busy) return
  dirtyTurns.add(store.begin(text).id); $('prompt').value = ''; $('status').textContent = '正在执行…'; busy = true
  render(); post('send', { text, model })
}
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('send').click() } }
$('stop').onclick = () => post('stop')
post('ready')
render()
