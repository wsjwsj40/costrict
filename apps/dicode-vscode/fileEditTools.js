const fs = require('node:fs')
const path = require('node:path')
const { unifiedDiff } = require('./unifiedDiff')

const dynamicTools = [
  { type: 'function', name: 'write_file', description: 'Create or overwrite a text file in the workspace. Use this for writing files instead of shell commands.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path' }, content: { type: 'string', description: 'Complete file contents' } }, required: ['path', 'content'], additionalProperties: false } },
  { type: 'function', name: 'replace_file_text', description: 'Replace one exact text occurrence in a workspace file. Use this for small edits instead of shell commands.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } },
  { type: 'function', name: 'delete_file', description: 'Delete a workspace file. Use this instead of a shell command.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
]

function resolveFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('需要工作区内的相对文件路径')
  const absolute = path.resolve(root, relative)
  const inside = path.relative(root, absolute)
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('文件不在当前工作区')
  const rootReal = fs.realpathSync(root)
  const parent = path.dirname(absolute)
  let nearest = parent
  while (!fs.existsSync(nearest)) nearest = path.dirname(nearest)
  const realNearest = fs.realpathSync(nearest)
  const realRelative = path.relative(rootReal, realNearest)
  if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new Error('文件路径经过工作区外的符号链接')
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('不支持编辑符号链接')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return { absolute, relative: inside.replace(/\\/g, '/') }
}

function editFile(root, tool, args) {
  if (!dynamicTools.some(spec => spec.name === tool)) throw new Error(`未知编辑工具：${tool}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数格式错误')
  const { absolute, relative } = resolveFile(root, args.path)
  const exists = fs.existsSync(absolute)
  if (exists && !fs.statSync(absolute).isFile()) throw new Error('目标不是普通文件')
  const buffer = exists ? fs.readFileSync(absolute) : null
  if (buffer?.includes(0)) throw new Error('不支持编辑二进制文件')
  const before = buffer ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : null
  let after
  if (tool === 'write_file') {
    if (typeof args.content !== 'string') throw new Error('content 必须是字符串')
    after = args.content
  } else if (tool === 'replace_file_text') {
    if (!exists) throw new Error('文件不存在')
    if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('替换参数不完整')
    const first = before.indexOf(args.oldText)
    if (first < 0 || before.indexOf(args.oldText, first + args.oldText.length) >= 0) throw new Error('旧文本不存在或不唯一')
    after = before.slice(0, first) + args.newText + before.slice(first + args.oldText.length)
  } else {
    if (!exists) throw new Error('文件不存在')
    after = null
  }
  if (after === before) return { path: relative, kind: 'modified', diff: '', changed: false }
  if (after === null) fs.unlinkSync(absolute)
  else {
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, after, 'utf8')
  }
  return { path: relative, kind: !exists ? 'added' : after === null ? 'deleted' : 'modified', diff: unifiedDiff(relative, before, after), changed: true }
}

module.exports = { dynamicTools, editFile }
