// Reconstruct the pre-change content only when the on-disk file still matches
// the real unified diff snapshot. This avoids showing a misleading comparison.
function beforeFromUnifiedDiff(current, diff) {
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const trailing = current.endsWith('\n')
  const lines = current.replace(/\r\n/g, '\n').split('\n')
  if (trailing) lines.pop()
  const hunks = []
  let hunk = null
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match) {
      hunk = { start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]), old: [], next: [] }
      hunks.push(hunk)
    } else if (hunk && line.startsWith('diff --git ')) hunk = null
    else if (hunk && line.startsWith('\\ No newline')) continue
    else if (hunk && line.length) {
      if (line[0] === ' ' || line[0] === '-') hunk.old.push(line.slice(1))
      if (line[0] === ' ' || line[0] === '+') hunk.next.push(line.slice(1))
    }
  }
  if (!hunks.length) throw new Error('Diff 中没有可比较的文本变更')
  for (const h of hunks.reverse()) {
    const index = h.start === 0 ? 0 : h.start - 1
    if (h.count !== h.next.length || lines.slice(index, index + h.next.length).join('\n') !== h.next.join('\n'))
      throw new Error('文件内容已变化，无法准确还原修改前版本；请查看内联 Diff')
    lines.splice(index, h.next.length, ...h.old)
  }
  return lines.join(newline) + (trailing ? newline : '')
}
module.exports = { beforeFromUnifiedDiff }
