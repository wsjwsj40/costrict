import React, { useEffect, useRef, useState } from 'react'

type Props = { state: any; model: string; setModel: (value: string) => void; prompt: string; setPrompt: (value: string) => void; busy: boolean; stopping: boolean; status: string; send: (effort: string) => void; post: (type: string, data?: Record<string, unknown>) => void; persistModel: (value: string) => void }
const permissions = [
  { id: 'request', title: '请求授权', description: '修改文件和执行操作前请求授权' },
  { id: 'auto', title: '自动授权', description: '在工作区内自动执行，必要时请求授权' },
  { id: 'full', title: '完全访问', description: '允许访问文件和网络' },
]
const efforts = [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }]
const format = (value: number | null | undefined) => value == null ? '暂无数据' : value.toLocaleString('zh-CN')
function PermissionIcon({ mode }: { mode: string }) {
  const hand = 'M5 7V3a1 1 0 0 1 2 0v3-4a1 1 0 0 1 2 0v4-3a1 1 0 0 1 2 0v4-2a1 1 0 0 1 2 0v5c0 3-2 5-5 5H7c-2 0-3-1-4-3L2 9c-.4-1.3 1-2 2-1l1 1'
  const shield = 'M8 1.5 13 3v4.2c0 3.2-2 5.5-5 7.3-3-1.8-5-4.1-5-7.3V3z M8 5v3 M8 10.5v.1'
  return <svg className="permission-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={mode === 'request' ? hand : shield} /></svg>
}

export default function Composer({ state, model, setModel, prompt, setPrompt, busy, stopping, status, send, post, persistModel }: Props) {
  const [menu, setMenu] = useState<'permission' | 'effort' | 'model' | 'context' | null>(null)
  const [effort, setEffort] = useState('medium')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { const activePicker = root.current?.querySelector('.picker-menu')?.closest('.picker-wrap'); if (activePicker && !activePicker.contains(event.target as Node)) setMenu(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [])
  const selected = (state.models || []).find((entry: any) => entry.id === model)
  const otherModel = Boolean(state.tokenUsage?.modelId && state.tokenUsage.modelId !== model)
  const usage = state.tokenUsage && (!state.tokenUsage.modelId || state.tokenUsage.modelId === model) ? state.tokenUsage : null
  const used = typeof usage?.last?.totalTokens === 'number' ? usage.last.totalTokens : null
  const limit = selected?.contextWindow || usage?.modelContextWindow || null
  const percent = used != null && limit > 0 ? Math.max(0, used / limit * 100) : null
  const displayedPercent = percent == null ? null : Math.round(percent)
  const band = displayedPercent == null ? 'unknown' : displayedPercent < 25 ? 'blue' : displayedPercent < 50 ? 'green' : displayedPercent < 75 ? 'yellow' : displayedPercent < 90 ? 'orange' : 'red'
  const colors: Record<string, string> = { unknown: 'var(--vscode-descriptionForeground)', blue: 'var(--vscode-charts-blue, #3794ff)', green: 'var(--vscode-charts-green, #89d185)', yellow: 'var(--vscode-charts-yellow, #cca700)', orange: 'var(--vscode-charts-orange, #d18616)', red: 'var(--vscode-charts-red, #f14c4c)' }
  const color = colors[band]
  const toggle = (value: typeof menu) => setMenu(current => current === value ? null : value)
  return <div className="composer-shell" ref={root}>
    <div className="composer">
      <textarea value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(effort) } }} placeholder="询问后续修改…" rows={2} />
      <div className="composer-bottom">
        <div className="picker-wrap"><button className="picker-trigger permission-trigger" disabled={busy} onClick={() => toggle('permission')} aria-expanded={menu === 'permission'}><PermissionIcon mode={state.permissionMode || 'request'} /> {permissions.find(entry => entry.id === state.permissionMode)?.title || '请求授权'}</button>
          {menu === 'permission' && <div className="picker-menu permission-menu">{permissions.map(entry => <button key={entry.id} className="picker-option" onClick={() => { post('setPermissionMode', { mode: entry.id }); setMenu(null) }}><PermissionIcon mode={entry.id} /><span><strong>{entry.title}</strong><small>{entry.description}</small></span>{state.permissionMode === entry.id && <span className="picker-check">✓</span>}</button>)}</div>}
        </div>
        <div className="composer-spacer" />
        <div className="picker-wrap"><button className="picker-trigger model-trigger" onClick={() => toggle(menu === 'effort' || menu === 'model' ? menu : state.models?.length ? 'effort' : 'model')} aria-expanded={menu === 'effort' || menu === 'model'}><span className="model-name">{selected?.name || selected?.id || (state.modelsLoading ? '正在加载模型' : '选择模型')}</span><span>{efforts.find(entry => entry.id === effort)?.label}</span><span aria-hidden="true" className={`chevron model-chevron ${menu === 'effort' || menu === 'model' ? 'expanded' : ''}`} /></button>
          {menu === 'effort' && <div className="picker-menu effort-menu"><div className="effort-current">{efforts.find(entry => entry.id === effort)?.label}</div><button className="effort-model" onClick={() => setMenu('model')}>{selected?.name || model || '选择模型'} ›</button><div className="effort-options">{efforts.map(entry => <button key={entry.id} className={effort === entry.id ? 'selected' : ''} onClick={() => setEffort(entry.id)}>{entry.label}</button>)}</div></div>}
          {menu === 'model' && <div className="picker-menu model-menu"><div className="picker-heading">选择模型</div>{(state.models || []).map((entry: any) => <button key={entry.id} className="model-option" onClick={() => { setModel(entry.id); persistModel(entry.id); setMenu('effort') }}>{entry.name || entry.id}{entry.id === model && <span>✓</span>}</button>)}{state.modelsLoading ? <div className="picker-heading">正在加载模型…</div> : state.modelsError && <><div className="picker-heading">{state.modelsError}</div><button className="model-option" onClick={() => post('models')}>重新加载</button></>}</div>}
        </div>
        <div className="picker-wrap"><button className="context-trigger" title="上下文用量" onClick={() => toggle('context')} aria-label="上下文用量"><span className="context-ring" data-level={band} style={{ background: `conic-gradient(${color} ${Math.min(percent || 0, 100)}%, var(--vscode-widget-border, #555) 0)` }} /><span>{displayedPercent == null ? '—' : `${displayedPercent}%`}</span></button>
          {menu === 'context' && <div className="picker-menu context-menu"><strong>上下文</strong>{!usage && <div className="picker-heading">发送消息后显示实际用量</div>}<div className="context-stat"><span>当前使用</span><span>{format(used)} / {format(limit)}</span></div><div className="context-stat"><span>CLI 可用窗口</span><span>{format(usage?.modelContextWindow)}</span></div><div className="context-stat"><span>输入 token</span><span>{format(usage?.last?.inputTokens)}</span></div><div className="context-stat"><span>输出 token</span><span>{format(usage?.last?.outputTokens)}</span></div><div className="context-stat"><span>缓存输入</span><span>{format(usage?.last?.cachedInputTokens)}</span></div><div className="context-stat"><span>模型最大输出</span><span>{format(selected?.maxTokens)}</span></div><button className="compact-button" disabled={busy || !state.threadId || otherModel} title={otherModel ? '请先使用所选模型发送消息' : '压缩当前会话上下文'} onClick={() => { setMenu(null); post('compactContext', { model }) }}>压缩上下文</button></div>}
        </div>
        {busy ? <button className="send-button" disabled={stopping} onClick={() => post('stop')}>{stopping ? '···' : '■'}</button> : <button className="send-button" disabled={!prompt.trim() || !selected} onClick={() => send(effort)}>↑</button>}
      </div>
    </div><div className="status-line">{status}</div>
  </div>
}
