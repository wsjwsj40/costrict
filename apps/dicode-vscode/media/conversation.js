// App-server notifications become stable thread / turn / item records here.
class ConversationStore {
  constructor() { this.reset() }
  reset() { this.threadId = null; this.tokenUsage = null; this.turns = []; this.items = new Map(); this.sequence = 0; this.pendingTurn = null }
  begin(text, attachments = []) {
    const turn = { id: `local-${++this.sequence}`, user: text, attachments, status: 'starting', startedAt: Date.now(), completedAt: null, items: [], plan: null, diff: '', error: null }
    this.turns.push(turn); this.pendingTurn = turn.id; return turn
  }
  turn(id, create = true) {
    let turn = this.turns.find(t => t.id === id)
    if (!turn && this.pendingTurn && id) {
      turn = this.turns.find(t => t.id === this.pendingTurn)
      if (turn) {
        const oldId = turn.id
        turn.id = id; this.pendingTurn = null
        for (const item of turn.items) { this.items.delete(`${oldId}:${item.id}`); item.turnId = id; this.items.set(`${id}:${item.id}`, item) }
      }
    }
    if (!turn && create) { turn = { id: id || `local-${++this.sequence}`, user: '', status: 'inProgress', startedAt: Date.now(), completedAt: null, items: [], plan: null, diff: '', error: null }; this.turns.push(turn) }
    return turn
  }
  item(turn, id, type = 'unknown') {
    const key = `${turn.id}:${id}`
    let item = this.items.get(key)
    if (!item) {
      item = { id, type, status: 'inProgress', raw: {}, text: '', output: '', summary: '', order: ++this.sequence, turnId: turn.id }
      turn.items.push(item); this.items.set(key, item)
    }
    if (type !== 'unknown') item.type = type
    return item
  }
  receive(method, params = {}) {
    const turn = this.turn(params.turnId || params.turn?.id || this.turns.at(-1)?.id)
    if (method === 'turn/started') {
      turn.status = params.turn?.status || 'inProgress'
      turn.startedAt ||= Date.now()
      this.threadId = params.threadId || this.threadId
    } else if (method === 'turn/completed') {
      turn.status = params.turn?.status || 'completed'; turn.error = params.turn?.error || null
      if (typeof params.stopRequested === 'boolean') turn.stopRequested = params.stopRequested
      turn.completedAt ||= Date.now()
      for (const item of turn.items) if (item.status === 'inProgress') item.status = turn.status
    } else if (method === 'turn/plan/updated') {
      turn.plan = { explanation: params.explanation || '', steps: params.plan || [] }
    } else if (method === 'turn/diff/updated') {
      turn.diff = params.diff || '' // cumulative snapshot
    } else if (method === 'item/started' || method === 'item/completed') {
      const incoming = params.item
      if (!incoming?.id) return turn
      const item = this.item(turn, incoming.id, incoming.type)
      item.raw = { ...item.raw, ...incoming }
      if (method === 'item/completed' || item.status === 'inProgress') item.status = method === 'item/completed' ? (incoming.status || 'completed') : (incoming.status || 'inProgress')
      if (incoming.text !== undefined) item.text = typeof incoming.text === 'string' ? incoming.text : ''
      if (incoming.aggregatedOutput !== undefined) item.output = typeof incoming.aggregatedOutput === 'string' ? incoming.aggregatedOutput : ''
      if (incoming.summary !== undefined) item.summary = Array.isArray(incoming.summary) ? incoming.summary.map(p => p.text || p).join('\n') : incoming.summary
    } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta'].includes(method)) {
      const item = this.item(turn, params.itemId, deltaType(method))
      if (item.status !== 'inProgress') return turn
      const delta = params.delta || ''
      if (method === 'item/agentMessage/delta') item.text += delta
      if (method === 'item/commandExecution/outputDelta') item.output += delta
      if (method === 'item/reasoning/summaryTextDelta') item.summary += delta
    } else if (method === 'item/reasoning/summaryPartAdded') {
      const item = this.item(turn, params.itemId, 'reasoning')
      if (item.summary && !item.summary.endsWith('\n')) item.summary += '\n'
    }
    return turn
  }
  snapshot() {
    return { threadId: this.threadId, tokenUsage: this.tokenUsage, turns: this.turns.slice(-100).map(turn => ({ ...turn, items: (turn.items || []).map(item => ({ ...item, output: String(item.output || '').slice(-30000), raw: { ...item.raw, aggregatedOutput: typeof item.raw?.aggregatedOutput === 'string' ? item.raw.aggregatedOutput.slice(-30000) : item.raw?.aggregatedOutput } })) })) }
  }
  restore(snapshot) {
    this.reset()
    if (!snapshot || !Array.isArray(snapshot.turns)) return
    this.threadId = snapshot.threadId
    this.tokenUsage = snapshot.tokenUsage || null
    this.turns = snapshot.turns
    for (const turn of this.turns) for (const item of turn.items || []) this.items.set(`${turn.id}:${item.id}`, item)
  }
}
function deltaType(method) {
  if (method.includes('agentMessage')) return 'agentMessage'
  if (method.includes('commandExecution')) return 'commandExecution'
  if (method.includes('reasoning')) return 'reasoning'
  return 'unknown'
}
function parseDiff(diff) {
  const files = []; let current = null
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current)
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      current = { path: match ? match[2] : line.slice(11), oldPath: match?.[1], kind: 'modified', additions: 0, deletions: 0, lines: [line] }
    } else if (current) {
      current.lines.push(line)
      if (line.startsWith('new file mode')) current.kind = 'added'
      if (line.startsWith('deleted file mode')) current.kind = 'deleted'
      if (line.startsWith('rename from')) current.kind = 'renamed'
      if (line.startsWith('+') && !line.startsWith('+++')) current.additions++
      if (line.startsWith('-') && !line.startsWith('---')) current.deletions++
    }
  }
  if (current) files.push(current)
  return files.map(file => ({ ...file, diff: file.lines.join('\n') }))
}
module.exports = { ConversationStore, parseDiff }
