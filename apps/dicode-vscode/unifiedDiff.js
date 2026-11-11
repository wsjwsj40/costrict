function splitLines(content) {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function unifiedDiff(file, before, after) {
  const oldLines = splitLines(before || ''), newLines = splitLines(after || '')
  let prefix = 0, suffix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  if (prefix === oldLines.length && prefix === newLines.length) return ''
  const contextBefore = Math.min(3, prefix), contextAfter = Math.min(3, suffix)
  const oldStart = prefix - contextBefore, newStart = prefix - contextBefore
  const oldEnd = oldLines.length - suffix + contextAfter, newEnd = newLines.length - suffix + contextAfter
  const header = [`diff --git a/${file} b/${file}`]
  if (before === null) header.push('new file mode 100644')
  if (after === null) header.push('deleted file mode 100644')
  header.push(`--- ${before === null ? '/dev/null' : `a/${file}`}`, `+++ ${after === null ? '/dev/null' : `b/${file}`}`)
  header.push(`@@ -${oldStart + (oldEnd > oldStart ? 1 : 0)},${oldEnd - oldStart} +${newStart + (newEnd > newStart ? 1 : 0)},${newEnd - newStart} @@`)
  return [...header,
    ...oldLines.slice(oldStart, prefix).map(line => ` ${line}`),
    ...oldLines.slice(prefix, oldLines.length - suffix).map(line => `-${line}`),
    ...newLines.slice(prefix, newLines.length - suffix).map(line => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix, oldEnd).map(line => ` ${line}`),
  ].join('\n')
}

module.exports = { unifiedDiff }
