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
  $('recentPrompt').hidden = !turn
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
  const meta = element('div', 'muted', [raw.cwd, raw.exitCode !== undefined ? `退出码 ${raw.exitCode}` : '', raw.durationMs !== undefined ? `${raw.durationMs} ms` : ''].filter(Boolean).join(' · '))
  const cmdPre = element('pre', 'command-text', cmd)
  body.append(meta, cmdPre, button('复制命令', () => navigator.clipboard.writeText(cmd), 'subtle'))
  if (item.output) {
    body.append(element('div', 'muted', '输出'), element('pre', 'command-output', stripAnsi(item.output)), button('复制输出', () => navigator.clipboard.writeText(stripAnsi(item.output)), 'subtle'))
  }
  const label = `⌘  ${commandTitle(raw)}  ·  ${statusText(item)}  ${cmd ? '· ' + cmd.slice(0, 65) : ''}`
  return detail(`${turn.id}:${item.id}`, label, body, `command-card status-${item.status || 'inProgress'}`)
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
    root.append(detail(`${turn.id}:diff:${file.path}`, `▤  ${file.path}  ·  ${file.kind}  +${file.additions} -${file.deletions}`, body, 'file-card status-completed'))
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
  return detail(`${turn.id}:${item.id}`, `▤  修改文件 · ${statusText(item)} · ${changes.length} 个文件`, body, `file-card status-${item.status || 'inProgress'}`)
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
  if (item.type === 'agentMessage') {
    const final = item.raw?.phase === 'final_answer'
    const box = element('article', `agent ${final ? 'final-answer' : 'commentary-answer'}`)
    if (final) box.append(element('div', 'agent-heading', '✦  DiCode · 答复'))
    box.append(markdownView(item.text)); return box
  }
  if (item.type === 'reasoning') return item.summary ? detail(`${turn.id}:${item.id}`, '◌  思考摘要', markdownView(item.summary), 'reasoning status-completed') : null
  if (item.type === 'commandExecution') return commandView(item, turn)
  if (item.type === 'fileChange') return fileItem(item, turn)
  return toolView(item, turn)
}
function render() {
  const list = $('messages'), follow = followMessages
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
    if ((turn.status === 'inProgress' || turn.status === 'starting') && busy && turn === store.turns.at(-1)) content.append(element('div', 'working', stopping ? '◌  正在停止…' : '◌  DiCode 正在处理…'))
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
      latest.error = state.lastTurn.error || null
    } else if (latest.status === 'starting' || latest.status === 'inProgress') {
      latest.status = 'interrupted'
    }
    if (latest.status === 'completed') setStatus('已完成 · 可以继续提问', 'success')
    else if (latest.status === 'interrupted') setStatus('已停止 · 可以继续提问', 'warning')
    else if (latest.status === 'failed') setStatus('任务失败 · 可以重试', 'error')
  }
  if (latest && (wasBusy !== busy || wasStopping !== stopping || wasStatus !== latest.status || wasError !== latest.error?.message)) { dirtyTurns.add(latest.id); schedule() }
  updateComposer()
  if (stopping) setStatus('正在停止当前任务…', 'warning')
  $('workspace').textContent = state.workspace || '未打开工作区'
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
  if (msg.type === 'history') { store.restore(msg.snapshot); const latest = store.turns.at(-1); if (!busy && latest && ['starting', 'inProgress'].includes(latest.status)) { latest.status = 'interrupted'; setStatus('已停止 · 可以继续提问', 'warning') } turnNodes.clear(); $('messages').replaceChildren(); visibleTurnLimit = 30; followMessages = true; for (const turn of store.turns) dirtyTurns.add(turn.id); schedule() }
  if (msg.type === 'notice') setStatus(msg.message, 'working')
  if (msg.type === 'error') { awaitingHostBusy = false; setStatus(`错误：${msg.message}`, 'error'); const turn = store.turns.at(-1); if (turn && busy) { turn.error = { message: msg.message }; turn.status = 'failed'; dirtyTurns.add(turn.id); schedule() } }
  if (msg.type === 'stopped') { awaitingHostBusy = false; busy = false; stopping = false; updateComposer(); setStatus(msg.message || '已停止，可以继续提问', 'warning'); const turn = store.turns.at(-1); if (turn) { turn.status = 'interrupted'; dirtyTurns.add(turn.id); schedule() } }
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
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('modelMenu').hidden = true; $('modelPicker').setAttribute('aria-expanded', 'false') } })
document.addEventListener('click', event => { if (!$('modelPicker').contains(event.target) && !$('modelMenu').contains(event.target)) { $('modelMenu').hidden = true; $('modelPicker').setAttribute('aria-expanded', 'false') } })
post('ready')
render()
updateComposer()
