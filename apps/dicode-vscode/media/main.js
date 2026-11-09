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
let busy = false, stopping = false, activeApproval = null, approvalQueue = [], scheduled = false
let activeUserInput = null, userInputQueue = []
let latestStateVersion = -1
let awaitingHostBusy = false
let followMessages = true
let recentPromptId = null
let userScrollUntil = 0
let visibleTurnLimit = 30
const openDetails = new Set()
const processPreference = new Map()
const commandGroupPreference = new Map()
let planDockExpanded = false, planDockSignature = '', planDockTurnId = null
const turnNodes = new Map(), dirtyTurns = new Set()
function post(type, extra = {}) { vscode.postMessage({ type, ...extra }) }
function element(tag, className = '', text = '') { const e = document.createElement(tag); e.className = className; e.textContent = text; return e }
function button(label, click, className = '') { const e = element('button', className, label); e.onclick = click; return e }
function setStatus(message, kind = 'idle') { $('status').textContent = message; $('statusLine').dataset.kind = kind }
function updateComposer() {
  $('send').hidden = busy
  $('stop').hidden = !busy || stopping
  $('stopping').hidden = !busy || !stopping
  $('send').disabled = !($('prompt').value.trim() && $('model').value)
  $('permissionPicker').disabled = busy
  if (busy) closePermissionMenu()
}
function resizePrompt() { const input = $('prompt'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px` }
function nearBottom() { const e = $('messages'); return e.scrollHeight - e.scrollTop - e.clientHeight < 70 }
function scrollToBottom() { const list = $('messages'); list.scrollTop = list.scrollHeight; $('backToBottom').hidden = true }
function updateRecentPrompt() {
  const list = $('messages')
  // scrollIntoView aligns the message 12px below the viewport via scroll-margin-top.
  const listTop = list.getBoundingClientRect().top + 20
  const visible = store.turns.slice(-visibleTurnLimit).filter(turn => turn.user && turnNodes.has(turn.id))
  let turn = visible[0]
  for (const candidate of visible) {
    const top = turnNodes.get(candidate.id).querySelector('.user-message')?.getBoundingClientRect().top
    if (top === undefined || top > listTop) break
    turn = candidate
  }
  recentPromptId = turn?.id || null
  const promptTop = turn ? turnNodes.get(turn.id)?.querySelector('.user-message')?.getBoundingClientRect().top : undefined
  $('recentPrompt').hidden = !turn || (promptTop !== undefined && promptTop >= listTop && promptTop < list.getBoundingClientRect().bottom)
  if (turn) {
    const preview = turn.user.replace(/\s+/g, ' ').trim()
    $('recentPromptText').textContent = preview
    $('recentPrompt').title = preview
  }
}
function updateNavigation() {
  updateRecentPrompt()
  $('backToBottom').hidden = followMessages || nearBottom()
}
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
  d.ontoggle = () => { if (d.open) openDetails.add(key); else openDetails.delete(key); requestAnimationFrame(() => { if (followMessages) scrollToBottom(); updateNavigation() }) }
  const summary = element('summary')
  const match = /^([⌘▤◇◌])\s+(.*)$/.exec(label)
  if (match) summary.append(element('span', 'activity-icon', match[1]), element('span', 'activity-label', match[2]))
  else summary.textContent = label
  d.append(summary, body)
  return d
}
function statusText(item) {
  const status = item.status || 'inProgress'
  return ({ inProgress: '运行中', completed: '完成', failed: '失败', interrupted: '已停止', declined: '已拒绝' })[status] || status
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
  const running = item.status === 'inProgress'
  const meta = element('div', 'muted', [commandTitle(raw), raw.cwd, raw.exitCode !== undefined ? `退出码 ${raw.exitCode}` : '', raw.durationMs !== undefined ? `${raw.durationMs} ms` : ''].filter(Boolean).join(' · '))
  const cmdPre = element('pre', 'command-text', cmd)
  body.append(meta, cmdPre, button('复制命令', () => navigator.clipboard.writeText(cmd), 'subtle'))
  if (item.output) {
    body.append(element('div', 'muted', '输出'), element('pre', 'command-output', stripAnsi(item.output)), button('复制输出', () => navigator.clipboard.writeText(stripAnsi(item.output)), 'subtle'))
  }
  const label = `⌘  ${running ? '正在运行' : '已运行'} ${cmd || commandTitle(raw)}`
  const card = detail(`${turn.id}:${item.id}`, label, body, `command-card status-${item.status || 'inProgress'}`)
  if (running) card.querySelector('.activity-label')?.classList.add('running-shimmer')
  return card
}
function commandGroup(items, turn) {
  const group = element('details', 'command-group')
  const key = `${turn.id}:commands:${items[0].id}`
  group.open = commandGroupPreference.get(key) || false
  group.ontoggle = () => {
    requestAnimationFrame(() => { if (followMessages) scrollToBottom(); updateNavigation() })
  }
  const summary = element('summary', 'command-group-summary')
  summary.onclick = () => { commandGroupPreference.set(key, !group.open) }
  summary.append(element('span', 'command-group-icon', '⌘'), element('span', '', '已运行命令'), element('span', 'command-group-chevron', '⌄'))
  const list = element('div', 'command-group-list')
  for (const item of items) list.append(commandView(item, turn))
  group.append(summary, list)
  return group
}
function diffLines(diff) {
  const pre = element('pre', 'diff')
  for (const line of String(diff || '').split('\n')) {
    const span = element('span', line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'deleted' : line.startsWith('@@') ? 'hunk' : '', line + '\n')
    pre.appendChild(span)
  }
  return pre
}
function changedFiles(turn) {
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
  return files
}
function fileSummary(turn, compact = false) {
  const files = changedFiles(turn)
  if (!files.length) return null
  const root = element('section', `file-summary${compact ? ' compact' : ''}`)
  const plus = files.reduce((n, f) => n + f.additions, 0), minus = files.reduce((n, f) => n + f.deletions, 0)
  const heading = element('div', 'file-summary-heading')
  const title = element('div', 'file-summary-title', `${files.length} 个文件已修改`)
  const stats = element('span', 'file-stats')
  stats.append(element('span', 'added-count', `+${plus}`), document.createTextNode(' '), element('span', 'deleted-count', `-${minus}`))
  heading.append(element('span', 'file-summary-icon', '▤'), title, stats)
  heading.append(button('查看变更', () => post('openDiff', { path: files[0].path, diff: files[0].diff }), 'view-changes'))
  root.append(heading)
  if (compact) return root
  const list = element('div', 'file-summary-list')
  for (const file of files) {
    const row = button('', () => post('openDiff', { path: file.path, diff: file.diff }), 'file-summary-row')
    row.append(element('span', 'file-summary-path', file.path))
    const count = element('span', 'file-stats')
    count.append(element('span', 'added-count', `+${file.additions}`), document.createTextNode(' '), element('span', 'deleted-count', `-${file.deletions}`))
    row.append(count)
    list.append(row)
  }
  root.append(list)
  const toggle = button('收起文件 ⌃', () => {
    list.hidden = !list.hidden
    toggle.textContent = list.hidden ? '展开文件 ⌄' : '收起文件 ⌃'
  }, 'file-summary-toggle')
  root.append(toggle)
  return root
}
function fileItem(item, turn) {
  const changes = item.raw?.changes || []
  const running = item.status === 'inProgress'
  const body = element('div', 'activity-body')
  for (const change of changes) {
    const path = change.path || change.filePath || ''
    const row = element('div', 'file-row', `${change.kind || 'modified'}  ${path}`)
    if (path) row.append(button('打开', () => post('openFile', { path }), 'subtle'))
    body.append(row)
    if (change.diff && path) body.append(button('在编辑器中比较', () => post('openDiff', { path, diff: change.diff }), 'subtle'), diffLines(change.diff))
  }
  const label = `▤  ${running ? '正在编辑文件' : '已编辑文件'}${changes.length ? ` · ${changes.map(change => change.path || change.filePath).filter(Boolean).join('、')}` : ''}`
  const card = detail(`${turn.id}:${item.id}`, label, body, `file-card status-${item.status || 'inProgress'}`)
  if (running) card.querySelector('.activity-label')?.classList.add('running-shimmer')
  return card
}
function toolView(item, turn) {
  const raw = item.raw || {}, names = { mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', webSearch: '网页搜索', imageView: '查看图片', collabToolCall: '协作任务', contextCompaction: '整理上下文' }
  const title = names[item.type] || item.type
  const descriptor = [raw.server, raw.tool, raw.query].filter(Boolean).join(' · ')
  const body = element('div', 'activity-body')
  const data = JSON.stringify(raw, null, 2)
  body.append(element('pre', 'tool-json', data), button('复制详情', () => navigator.clipboard.writeText(data), 'subtle'))
  return detail(`${turn.id}:${item.id}`, `◇  ${title} · ${statusText(item)} ${descriptor ? '· ' + descriptor : ''}`, body, `tool-card status-${item.status || 'inProgress'}`)
}
function formatDuration(turn) {
  if (!Number.isFinite(turn.startedAt) || !Number.isFinite(turn.completedAt)) return '过程'
  const seconds = Math.max(0, Math.round((turn.completedAt - turn.startedAt) / 1000))
  if (seconds < 60) return `用时${seconds}秒`
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60
  return `用时${minutes}分${String(remainder).padStart(2, '0')}秒`
}
function formatElapsed(startedAt) {
  if (!Number.isFinite(startedAt)) return '正在处理…'
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return seconds < 60 ? `正在处理 ${seconds}秒` : `正在处理 ${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`
}
function renderChangeDock() {
  const dock = $('changeDock')
  const turn = busy ? store.turns.at(-1) : null
  const summary = turn && ['starting', 'inProgress'].includes(turn.status) ? fileSummary(turn, true) : null
  dock.hidden = !summary
  if (summary) dock.replaceChildren(summary)
  else dock.replaceChildren()
}
function renderPlanDock() {
  const turn = busy ? store.turns.at(-1) : null
  const plan = turn && ['starting', 'inProgress'].includes(turn.status) ? turn.plan : null
  const host = $('planDock')
  if (!plan?.steps?.length) { host.hidden = true; planDockSignature = ''; return }
  if (planDockTurnId !== turn.id) { planDockTurnId = turn.id; planDockExpanded = false }
  host.hidden = false
  const signature = JSON.stringify([turn.id, plan, planDockExpanded])
  if (signature === planDockSignature) return
  planDockSignature = signature
  const completed = plan.steps.filter(step => step.status === 'completed').length
  const current = plan.steps.find(step => step.status === 'inProgress') || plan.steps.find(step => step.status !== 'completed')
  const heading = button('', () => { planDockExpanded = !planDockExpanded; planDockSignature = ''; renderPlanDock() }, 'plan-dock-toggle')
  heading.type = 'button'
  heading.setAttribute('aria-expanded', String(planDockExpanded))
  heading.append(element('span', 'plan-dock-icon', '☷'), element('span', `plan-dock-title${!planDockExpanded && current?.status === 'inProgress' ? ' plan-shimmer' : ''}`, planDockExpanded ? '执行计划' : current?.step || `${completed}项已完成`))
  heading.append(element('span', 'plan-dock-count', `${completed}/${plan.steps.length}`), element('span', 'plan-dock-chevron', planDockExpanded ? '⌃' : '⌄'))
  host.replaceChildren(heading)
  if (planDockExpanded) {
    const list = element('ol', 'plan-dock-steps')
    for (const step of plan.steps) {
      const status = step.status || 'pending'
      const row = element('li', `plan-dock-step ${status}`)
      row.append(element('span', 'plan-step-symbol', status === 'completed' ? '✓' : status === 'inProgress' ? '◉' : '○'), document.createTextNode('  '), element('span', status === 'inProgress' ? 'plan-step-text plan-shimmer' : 'plan-step-text', step.step || step.text || ''))
      list.append(row)
    }
    host.append(list)
  }
}
function processView(turn, active, nodes) {
  if (!nodes.length) return turn.startedAt && !active ? element('div', 'turn-duration', formatDuration(turn)) : null
  const key = `${turn.id}:process`
  const box = element('details', 'turn-process')
  box.open = processPreference.has(key) ? processPreference.get(key) : active
  const summary = element('summary', 'turn-process-summary', active ? formatElapsed(turn.startedAt) : formatDuration(turn))
  if (active && Number.isFinite(turn.startedAt)) box.dataset.startedAt = String(turn.startedAt)
  summary.onclick = () => { processPreference.set(key, !box.open) }
  box.append(summary)
  const body = element('div', 'turn-process-body')
  body.append(...nodes)
  box.append(body)
  return box
}
function itemView(item, turn, forceFinal = false) {
  if (['userMessage', 'functionCallOutput', 'plan'].includes(item.type)) return null
  if (item.type === 'agentMessage') {
    const final = forceFinal || item.raw?.phase === 'final_answer'
    const box = element('article', `agent ${final ? 'final-answer' : 'commentary-answer'}`)
    if (final) box.append(element('div', 'agent-heading', '✦  DiCode · 答复'))
    box.append(markdownView(item.text)); return box
  }
  if (item.type === 'reasoning') return null
  if (item.type === 'commandExecution') return commandView(item, turn)
  if (item.type === 'fileChange') return fileItem(item, turn)
  if (!['mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabToolCall', 'contextCompaction'].includes(item.type)) return null
  return toolView(item, turn)
}
function render() {
  const list = $('messages'), follow = followMessages
  renderPlanDock()
  renderChangeDock()
  if (!store.turns.length) { list.replaceChildren($('emptyTemplate').content.cloneNode(true)); turnNodes.clear(); updateNavigation(); return }
  list.querySelector('.empty')?.remove()
  if (!follow && turnNodes.size) {
    const firstId = turnNodes.keys().next().value
    const firstIndex = store.turns.findIndex(turn => turn.id === firstId)
    if (firstIndex >= 0) visibleTurnLimit = Math.max(visibleTurnLimit, store.turns.length - firstIndex)
  }
  const visibleTurns = store.turns.slice(-visibleTurnLimit)
  const present = new Set(visibleTurns.map(t => t.id))
  for (const [id, node] of turnNodes) if (!present.has(id)) { node.remove(); turnNodes.delete(id) }
  let older = list.querySelector('.show-earlier')
  if (visibleTurns.length < store.turns.length) {
    if (!older) { older = button('显示更早的消息', showEarlier, 'show-earlier'); list.prepend(older) }
  } else older?.remove()
  for (const turn of visibleTurns) {
    if (turnNodes.has(turn.id) && !dirtyTurns.has(turn.id)) continue
    const section = element('section', 'turn')
    section.dataset.turnId = turn.id
    if (turn.user) { const user = element('div', 'user-message'); user.append(element('div', 'speaker', '你'), markdownView(turn.user)); section.append(user) }
    const content = element('div', 'turn-content')
    const processNodes = [], finalItems = []
    const agentItems = (turn.items || []).filter(item => item.type === 'agentMessage')
    const explicitFinal = agentItems.some(item => item.raw?.phase === 'final_answer')
    const unphasedFallback = !explicitFinal && turn.status === 'completed' && agentItems.every(item => !item.raw?.phase) ? agentItems.at(-1) : null
    const active = ['starting', 'inProgress'].includes(turn.status)
    let commands = []
    const flushCommands = () => {
      if (!commands.length) return
      processNodes.push(commandGroup(commands, turn))
      commands = []
    }
    for (const item of turn.items || []) {
      if (item.type === 'commandExecution') {
        if (item.status === 'inProgress' || !item.status) { flushCommands(); processNodes.push(commandView(item, turn)) }
        else commands.push(item)
        continue
      }
      flushCommands()
      if (item.type === 'agentMessage' && (item.raw?.phase === 'final_answer' || item === unphasedFallback)) { finalItems.push(item); continue }
      const node = itemView(item, turn); if (node) processNodes.push(node)
    }
    flushCommands()
    if (active && busy && turn === store.turns.at(-1) && !processNodes.length) processNodes.push(element('div', 'working', stopping ? '◌  正在停止…' : '◌  DiCode 正在处理…'))
    const process = processView(turn, active, processNodes)
    if (process) content.append(process)
    for (const item of finalItems) content.append(itemView(item, turn, true))
    if (!active) { const files = fileSummary(turn); if (files) content.append(files) }
    if (turn.status === 'completed' && !finalItems.length) content.append(element('div', 'turn-missing-answer', '未收到最终答复'))
    if (turn.status === 'interrupted') content.append(element('div', 'turn-interrupted', '已停止 · 可以继续提问'))
    if (turn.error) content.append(element('div', 'turn-error', turn.error.message || String(turn.error)))
    section.append(content)
    const previous = turnNodes.get(turn.id)
    if (previous) previous.replaceWith(section); else list.append(section)
    turnNodes.set(turn.id, section)
  }
  dirtyTurns.clear()
  updateNavigation()
  if (follow) {
    scrollToBottom()
    requestAnimationFrame(() => { if (followMessages) scrollToBottom(); updateNavigation() })
  } else {
    requestAnimationFrame(updateNavigation)
  }
}
function showEarlier() {
  const list = $('messages'), previousHeight = list.scrollHeight, previousTop = list.scrollTop
  visibleTurnLimit += 30
  turnNodes.clear()
  list.replaceChildren()
  followMessages = false
  render()
  list.scrollTop = previousTop + Math.max(0, list.scrollHeight - previousHeight)
  requestAnimationFrame(updateNavigation)
}
function setState(state) {
  if (typeof state.version === 'number' && state.version < latestStateVersion) return
  if (typeof state.version === 'number') latestStateVersion = state.version
  $('login').hidden = state.loggedIn; $('app').hidden = !state.loggedIn
  if (state.busy) awaitingHostBusy = false
  const wasBusy = busy, wasStopping = stopping
  busy = !!state.busy || awaitingHostBusy; stopping = !!state.stopping || (awaitingHostBusy && stopping)
  const latest = store.turns.at(-1)
  const wasStatus = latest?.status, wasError = latest?.error?.message
  if (!busy && latest) {
    const terminal = state.lastTurn?.status
    if (['completed', 'interrupted', 'failed'].includes(terminal) && (!state.lastTurn.id || state.lastTurn.id === latest.id || latest.id.startsWith('local-'))) {
      latest.status = terminal
      latest.completedAt ||= Date.now()
      latest.error = state.lastTurn.error || null
    } else if (latest.status === 'starting' || latest.status === 'inProgress') {
      latest.status = 'interrupted'
      latest.completedAt ||= Date.now()
    }
    if (latest.status === 'completed') setStatus('已完成 · 可以继续提问', 'success')
    else if (latest.status === 'interrupted') setStatus('已停止 · 可以继续提问', 'warning')
    else if (latest.status === 'failed') setStatus('任务失败 · 可以重试', 'error')
  }
  if (latest && (wasBusy !== busy || wasStopping !== stopping || wasStatus !== latest.status || wasError !== latest.error?.message)) { dirtyTurns.add(latest.id); schedule() }
  updateComposer()
  if (stopping) setStatus('正在停止当前任务…', 'warning')
  $('workspace').textContent = state.workspace || '未打开工作区'
  renderPermissionPicker(state.permissionMode || 'request')
  const previous = $('model').value
  $('model').replaceChildren()
  for (const model of state.models || []) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name || model.id; $('model').append(option) }
  if ([...$('model').options].some(option => option.value === previous)) $('model').value = previous
  else if ([...$('model').options].some(option => option.value === vscode.getState?.()?.modelId)) $('model').value = vscode.getState().modelId
  renderModelPicker(state.models || [])
  updateComposer()
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
function renderModelPicker(models) {
  const selected = models.find(model => model.id === $('model').value)
  $('modelLabel').textContent = selected?.name || selected?.id || '选择模型'
  const menu = $('modelMenu')
  menu.replaceChildren(element('div', 'model-menu-heading', '选择模型'))
  if (models.length > 5) {
    const search = document.createElement('input')
    search.className = 'model-search'
    search.placeholder = '搜索模型…'
    search.setAttribute('aria-label', '搜索模型')
    search.oninput = () => {
      const query = search.value.trim().toLowerCase()
      for (const option of menu.querySelectorAll('.model-option')) option.hidden = !option.textContent.toLowerCase().includes(query)
    }
    menu.append(search)
  }
  if (!models.length) menu.append(element('div', 'model-empty', '暂无可用模型'), button('刷新模型列表', () => post('models'), 'model-refresh'))
  for (const model of models) {
    const entry = button(`${model.name || model.id}`, () => {
      $('model').value = model.id
      $('modelLabel').textContent = model.name || model.id
      vscode.setState?.({ ...(vscode.getState?.() || {}), modelId: model.id })
      renderModelPicker(models)
      menu.hidden = true
      $('modelPicker').setAttribute('aria-expanded', 'false')
      updateComposer()
    }, `model-option ${model.id === $('model').value ? 'selected' : ''}`)
    entry.setAttribute('role', 'option')
    entry.setAttribute('aria-selected', String(model.id === $('model').value))
    entry.title = model.name || model.id
    menu.append(entry)
  }
}
const permissionChoices = {
  request: { label: '请求授权', icon: '◇', detail: '只读查看；修改文件时请求授权' },
  auto: { label: '自动授权', icon: '✦', detail: '工作区内自动执行；越界时请求授权' },
  full: { label: '完全访问', icon: '⚠', detail: '不使用 Codex 沙箱和命令审批' },
}
function closePermissionMenu() {
  $('permissionMenu').hidden = true
  $('permissionPicker').setAttribute('aria-expanded', 'false')
}
function renderPermissionPicker(mode) {
  const selected = permissionChoices[mode] || permissionChoices.request
  $('permissionMode').value = mode
  $('permissionLabel').textContent = selected.label
  $('permissionGlyph').textContent = selected.icon
  $('permissionPicker').dataset.mode = mode
  $('permissionPicker').title = selected.detail
  const menu = $('permissionMenu')
  menu.replaceChildren(element('div', 'permission-menu-heading', '执行权限'))
  for (const [key, choice] of Object.entries(permissionChoices)) {
    const entry = button('', () => { closePermissionMenu(); if (key !== mode) post('setPermissionMode', { mode: key }); $('permissionPicker').focus() }, `permission-option ${key === mode ? 'selected' : ''}`)
    entry.dataset.mode = key
    entry.setAttribute('role', 'menuitemradio')
    entry.setAttribute('aria-checked', String(key === mode))
    const copy = element('span', 'permission-option-copy')
    copy.append(element('strong', '', choice.label), element('small', '', choice.detail))
    entry.append(element('span', 'permission-option-icon', choice.icon), copy)
    if (key === mode) entry.append(element('span', 'permission-option-check', '✓'))
    menu.append(entry)
  }
}
function approvalView(message) {
  if (activeApproval) { approvalQueue.push(message); return }
  activeApproval = message
  const box = $('approval'), params = message.params || {}
  box.replaceChildren()
  box.append(element('div', 'approval-heading', message.method.includes('command') ? '▣  终端' : '▤  文件变更'))
  box.append(element('div', 'approval-reason', params.reason ? `原因：${params.reason}` : 'Codex 未提供具体审批原因'))
  if (params.cwd) box.append(element('div', 'approval-meta', `工作目录：${params.cwd}`))
  box.append(element('pre', 'approval-command', params.command || JSON.stringify(params, null, 2)))
  const actions = element('div', 'approval-actions')
  const labels = { accept: '允许本次', acceptForSession: '本次会话均允许', decline: '拒绝', cancel: '取消' }
  const decisions = (params.availableDecisions || ['accept', 'decline']).map(entry => typeof entry === 'string' ? entry : entry.decision).filter(Boolean)
  for (const value of ['decline', 'cancel', 'acceptForSession', 'accept', ...decisions]) {
    if (!decisions.includes(value) || actions.querySelector(`[data-decision="${value}"]`)) continue
    const action = button(labels[value] || value, () => {
      post('approve', { id: message.id, decision: value })
      activeApproval = null; box.hidden = true
      if (approvalQueue.length) approvalView(approvalQueue.shift())
    }, value === 'accept' ? 'approval-accept' : value === 'acceptForSession' ? 'approval-session' : 'approval-deny')
    action.dataset.decision = value
    actions.append(action)
  }
  box.append(actions); box.hidden = false
  requestAnimationFrame(() => { if (followMessages) scrollToBottom(); updateNavigation() })
}
function showNextUserInput() {
  const box = $('userInput')
  box.replaceChildren()
  box.scrollTop = 0
  activeUserInput = userInputQueue.shift() || null
  if (!activeUserInput) { box.hidden = true; return }
  const request = activeUserInput, questions = request.params?.questions || []
  const heading = element('div', 'user-input-heading')
  heading.append(element('span', 'user-input-mark', '✦'), element('strong', 'user-input-title', 'DiCode 需要你的决定'))
  box.append(heading, element('p', 'user-input-hint', '请选择一个选项，或切换为自定义回答。提交后继续当前任务。'))
  const rows = []
  questions.forEach((question, index) => {
    const section = element('div', 'user-input-question')
    section.setAttribute('role', 'group')
    section.setAttribute('aria-label', question.header || `问题 ${index + 1}`)
    section.append(element('span', 'user-input-question-title', `${index + 1} / ${questions.length} · ${question.header || '问题'}`))
    section.append(element('div', 'user-input-question-text', question.question || '请选择或输入回答'))
    const radios = []
    const options = question.options || []
    for (const option of options) {
      const label = element('label', 'user-input-option')
      const radio = document.createElement('input')
      radio.type = 'radio'; radio.name = `user-input-${request.id}-${index}`; radio.value = option.label
      const copy = element('span', 'user-input-option-copy')
      copy.append(element('strong', '', option.label))
      if (option.description) copy.append(element('span', 'user-input-option-description', option.description))
      label.append(radio, copy); section.append(label); radios.push(radio)
    }
    let customRadio = null
    if (options.length) {
      const label = element('label', 'user-input-option user-input-other')
      customRadio = document.createElement('input')
      customRadio.type = 'radio'; customRadio.name = `user-input-${request.id}-${index}`; customRadio.value = '__dicode_custom__'
      const copy = element('span', 'user-input-option-copy')
      copy.append(element('strong', '', '自定义回答'), element('span', 'user-input-option-description', '替换已选项，输入自己的答案'))
      label.append(customRadio, copy); section.append(label)
    }
    const custom = document.createElement(question.isSecret ? 'input' : 'textarea')
    if (question.isSecret) custom.type = 'password'
    else custom.rows = 2
    custom.className = 'user-input-custom'
    custom.placeholder = '输入你的回答…'
    custom.setAttribute('aria-label', `${question.header || `问题 ${index + 1}`}的自定义回答`)
    const customPanel = element('div', 'user-input-field')
    customPanel.append(element('span', 'user-input-field-label', '自定义回答'), custom)
    section.append(customPanel)
    let note = null, notePanel = null
    if (options.length) {
      note = document.createElement(question.isSecret ? 'input' : 'textarea')
      if (question.isSecret) note.type = 'password'
      else note.rows = 2
      note.className = 'user-input-note'
      note.placeholder = '可选：补充你对所选选项的要求…'
      note.setAttribute('aria-label', `${question.header || `问题 ${index + 1}`}的补充说明`)
      notePanel = element('div', 'user-input-field')
      notePanel.append(element('span', 'user-input-field-label', '补充说明 · 可选'), note)
      section.append(notePanel)
      const updateFields = () => { customPanel.hidden = !customRadio.checked; notePanel.hidden = !radios.some(radio => radio.checked) }
      for (const radio of [...radios, customRadio]) radio.onchange = updateFields
      updateFields()
    }
    box.append(section)
    rows.push({ question, radios, customRadio, custom, note })
  })
  const actions = element('div', 'user-input-actions')
  const error = element('span', 'user-input-error')
  error.setAttribute('role', 'alert')
  const submit = button('继续执行', () => {
    const answers = {}
    for (const { question, radios, customRadio, custom, note } of rows) {
      const chosen = radios.find(radio => radio.checked)?.value
      const isCustom = !radios.length || !!customRadio?.checked
      const textField = isCustom ? custom : note
      const text = textField?.value.trim() || ''
      if (!chosen && !isCustom) { error.textContent = '请为每个问题选择选项或自定义回答'; radios[0]?.focus(); return }
      if (isCustom && !text) { error.textContent = '请输入自定义回答'; custom.focus(); return }
      if (text.length > 3989) { error.textContent = '回答过长，请缩短后再提交'; textField.focus(); return }
      answers[question.id] = { answers: [chosen, text && `user_note: ${text}`].filter(Boolean) }
    }
    error.textContent = ''
    submit.disabled = true; submit.textContent = '正在提交…'
    post('answerUserInput', { id: request.id, answers })
  }, 'primary')
  actions.append(error, submit); box.append(actions)
  if (request.submitted) { submit.disabled = true; submit.textContent = '已提交，正在继续…' }
  box.hidden = false
}
function enqueueUserInput(message) {
  const id = String(message.id)
  if (String(activeUserInput?.id) === id) return
  if (userInputQueue.some(request => String(request.id) === id)) return
  userInputQueue.push(message)
  if (!activeUserInput) showNextUserInput()
}
function clearUserInputs() {
  activeUserInput = null; userInputQueue.length = 0
  $('userInput').replaceChildren(); $('userInput').hidden = true
}
window.addEventListener('message', event => {
  const msg = event.data
  if (msg.type === 'state') setState(msg)
  if (msg.type === 'history') { store.restore(msg.snapshot); const latest = store.turns.at(-1); if (!busy && latest && ['starting', 'inProgress'].includes(latest.status)) { latest.status = 'interrupted'; latest.completedAt ||= Date.now(); setStatus('已停止 · 可以继续提问', 'warning') } turnNodes.clear(); $('messages').replaceChildren(); visibleTurnLimit = 30; followMessages = true; for (const turn of store.turns) dirtyTurns.add(turn.id); schedule() }
  if (msg.type === 'notice') setStatus(msg.message, 'working')
  if (msg.type === 'permissionModeRejected') renderPermissionPicker(msg.mode || 'request')
  if (msg.type === 'error') { awaitingHostBusy = false; setStatus(`错误：${msg.message}`, 'error'); const turn = store.turns.at(-1); if (turn && busy) { turn.error = { message: msg.message }; turn.status = 'failed'; turn.completedAt ||= Date.now(); dirtyTurns.add(turn.id); schedule() } }
  if (msg.type === 'stopped') { awaitingHostBusy = false; busy = false; stopping = false; updateComposer(); setStatus(msg.message || '已停止，可以继续提问', 'warning'); const turn = store.turns.at(-1); if (turn) { turn.status = 'interrupted'; turn.completedAt ||= Date.now(); dirtyTurns.add(turn.id); schedule() } }
  if (msg.type === 'approval') approvalView(msg)
  if (msg.type === 'approvalsCleared') { activeApproval = null; approvalQueue.length = 0; $('approval').hidden = true }
  if (msg.type === 'userInputRequest') enqueueUserInput(msg)
  if (msg.type === 'userInputSubmitted' && String(activeUserInput?.id) === String(msg.id)) {
    const submit = $('userInput').querySelector('.user-input-actions button')
    if (submit) submit.textContent = '已提交，正在继续…'
  }
  if (msg.type === 'userInputError' && String(activeUserInput?.id) === String(msg.id)) {
    const submit = $('userInput').querySelector('.user-input-actions button')
    if (submit) { submit.disabled = false; submit.textContent = '继续执行' }
    const error = $('userInput').querySelector('.user-input-error')
    if (error) error.textContent = msg.message || '提交失败，请重试'
  }
  if (msg.type === 'userInputsCleared') clearUserInputs()
  if (msg.type === 'rpc') {
    if (msg.method === 'serverRequest/resolved') {
      const id = String(msg.params?.requestId ?? msg.params?.id)
      for (let i = approvalQueue.length - 1; i >= 0; i--) if (String(approvalQueue[i].id) === id) approvalQueue.splice(i, 1)
      if (String(activeApproval?.id) === id) { activeApproval = null; $('approval').hidden = true; if (approvalQueue.length) approvalView(approvalQueue.shift()) }
      userInputQueue = userInputQueue.filter(request => String(request.id) !== id)
      if (String(activeUserInput?.id) === id) showNextUserInput()
    } else {
      const turn = store.receive(msg.method, msg.params)
      dirtyTurns.add(turn.id)
      if (msg.method === 'turn/started' && !stopping) setStatus('DiCode 正在处理…', 'working')
      if (msg.method === 'turn/completed') {
        awaitingHostBusy = false; busy = false; stopping = false; updateComposer()
        const status = msg.params?.turn?.status
        setStatus(status === 'completed' ? '已完成 · 可以继续提问' : status === 'interrupted' ? '已停止 · 可以继续提问' : status === 'failed' ? '任务失败 · 可以重试' : `任务${status || '结束'}`, status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning')
      }
      schedule()
    }
  }
})
$('loginButton').onclick = () => post('login')
$('logout').onclick = () => { store.reset(); visibleTurnLimit = 30; followMessages = true; render(); post('logout') }
$('newThread').onclick = () => { if (!busy) { store.reset(); visibleTurnLimit = 30; followMessages = true; render(); post('newThread') } }
$('threadsButton').onclick = () => { $('threadList').hidden = !$('threadList').hidden }
$('permissionPicker').onclick = () => {
  const menu = $('permissionMenu')
  menu.hidden = !menu.hidden
  $('permissionPicker').setAttribute('aria-expanded', String(!menu.hidden))
  if (!menu.hidden) menu.querySelector('.permission-option.selected')?.focus()
}
$('send').onclick = () => {
  const text = $('prompt').value.trim(), model = $('model').value
  if (!text || !model || busy) return
  dirtyTurns.add(store.begin(text).id); $('prompt').value = ''; awaitingHostBusy = true; busy = true; stopping = false; followMessages = true; visibleTurnLimit = 30
  resizePrompt(); updateComposer(); setStatus('正在连接 Agent…', 'working')
  render(); post('send', { text, model })
}
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('send').click() } }
$('stop').onclick = () => { if (!busy || stopping) return; stopping = true; updateComposer(); setStatus('正在停止当前任务…', 'warning'); dirtyTurns.add(store.turns.at(-1)?.id); schedule(); post('stop') }
$('prompt').addEventListener('input', () => { resizePrompt(); updateComposer() })
$('messages').addEventListener('wheel', () => { userScrollUntil = Date.now() + 1000 }, { passive: true })
$('messages').addEventListener('touchstart', () => { userScrollUntil = Date.now() + 1000 }, { passive: true })
$('messages').addEventListener('pointerdown', () => { userScrollUntil = Date.now() + 1000 })
document.addEventListener('keydown', event => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key) && !event.target.closest('textarea, input')) userScrollUntil = Date.now() + 1000 })
$('messages').addEventListener('scroll', () => { if (nearBottom()) followMessages = true; else if (Date.now() < userScrollUntil) followMessages = false; updateNavigation() })
$('recentPrompt').onclick = () => {
  const node = turnNodes.get(recentPromptId)?.querySelector('.user-message')
  if (!node) return
  followMessages = false
  node.scrollIntoView({ block: 'start', behavior: 'smooth' })
  requestAnimationFrame(updateNavigation)
}
$('backToBottom').onclick = () => { followMessages = true; visibleTurnLimit = 30; render(); scrollToBottom(); requestAnimationFrame(updateNavigation) }
$('modelPicker').onclick = () => {
  const menu = $('modelMenu')
  menu.hidden = !menu.hidden
  $('modelPicker').setAttribute('aria-expanded', String(!menu.hidden))
  if (!menu.hidden) (menu.querySelector('.model-search') || menu.querySelector('.model-option'))?.focus()
}
document.getElementById('modelMenu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const options = [...$('modelMenu').querySelectorAll('.model-option')].filter(option => !option.hidden)
  const index = options.indexOf(document.activeElement)
  options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
})
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('modelMenu').hidden = true; $('modelPicker').setAttribute('aria-expanded', 'false'); closePermissionMenu() } })
document.addEventListener('click', event => {
  if (!$('modelPicker').contains(event.target) && !$('modelMenu').contains(event.target)) { $('modelMenu').hidden = true; $('modelPicker').setAttribute('aria-expanded', 'false') }
  if (!$('permissionPicker').contains(event.target) && !$('permissionMenu').contains(event.target)) closePermissionMenu()
})
post('ready')
render()
updateComposer()
window.setInterval(() => {
  for (const process of document.querySelectorAll('.turn-process[data-started-at]')) {
    const summary = process.querySelector('.turn-process-summary')
    if (summary) summary.textContent = formatElapsed(Number(process.dataset.startedAt))
  }
}, 1000)
