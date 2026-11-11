const fs = require('node:fs')
const path = require('node:path')

const ignoredDirectories = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', 'dist', 'build', 'out', 'target', 'coverage', '.cache'])
const maxFiles = 20000
const maxBytes = 128 * 1024 * 1024
const maxTextBytes = 512 * 1024

function scanWorkspace(root, previous = new Map()) {
  const files = new Map()
  const pending = [root]
  let bytes = 0
  while (pending.length) {
    const directory = pending.pop()
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(path.join(directory, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absolute = path.join(directory, entry.name)
      let stat
      try { stat = fs.statSync(absolute) } catch { continue }
      if (files.size >= maxFiles || bytes + Math.min(stat.size, maxTextBytes) > maxBytes) return { files, complete: false }
      bytes += Math.min(stat.size, maxTextBytes)
      const relative = path.relative(root, absolute).replace(/\\/g, '/')
      const prior = previous.get(relative)
      if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
        files.set(relative, prior)
        continue
      }
      let content = null
      if (stat.size <= maxTextBytes) {
        try {
          const buffer = fs.readFileSync(absolute)
          if (!buffer.includes(0)) content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        } catch { /* Binary, unreadable, or invalid UTF-8: keep the file event without an inline diff. */ }
      }
      files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, content })
    }
  }
  return { files, complete: true }
}

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

function workspaceChanges(before, after) {
  if (!before?.complete || !after?.complete) return []
  const changes = []
  const paths = new Set([...before.files.keys(), ...after.files.keys()])
  for (const file of paths) {
    const oldFile = before.files.get(file), newFile = after.files.get(file)
    if (oldFile === newFile || (oldFile && newFile && oldFile.size === newFile.size && oldFile.mtimeMs === newFile.mtimeMs)) continue
    if (oldFile?.content !== null && newFile?.content !== null && oldFile?.content === newFile?.content) continue
    const kind = !oldFile ? 'added' : !newFile ? 'deleted' : 'modified'
    const diff = oldFile?.content === null || newFile?.content === null ? '' : unifiedDiff(file, oldFile?.content ?? null, newFile?.content ?? null)
    changes.push({ path: file, kind, diff })
  }
  return changes
}

module.exports = { scanWorkspace, workspaceChanges, unifiedDiff }
