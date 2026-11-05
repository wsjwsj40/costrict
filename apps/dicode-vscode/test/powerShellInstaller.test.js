const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { ensurePowerShellInstalled, powerShellEnv } = require('../powerShellInstaller')

test('PowerShell env selects portable pwsh ahead of existing Windows shell', () => {
  const env = powerShellEnv('/storage/powershell/package/pwsh.exe', { Path: '/windows/system32', OTHER: 'value' })
  assert.equal(env.Path, `/storage/powershell/package${path.delimiter}/windows/system32`)
  assert.equal(env.OTHER, 'value')
})

test('PowerShell installer verifies, extracts, probes, and reuses the portal package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-pwsh-test-'))
  const source = path.join(dir, 'source')
  fs.mkdirSync(path.join(source, 'package'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package', 'pwsh.exe'), 'stub')
  const archive = 'powershell-7.6.6-win32-x64.tgz'
  execFileSync('tar', ['-czf', path.join(dir, archive), '-C', source, 'package'])
  const bytes = fs.readFileSync(path.join(dir, archive))
  const manifest = { version: '7.6.6', archive, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/manifest.json')) return res.end(JSON.stringify(manifest))
    if (req.url.endsWith(`/${archive}`)) return res.end(bytes)
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    let probes = 0
    const opts = { platform: 'win32', arch: 'x64', probe: async () => { probes++ } }
    const url = `http://127.0.0.1:${server.address().port}`
    const first = await ensurePowerShellInstalled(url, path.join(dir, 'storage'), null, opts)
    assert.equal(fs.readFileSync(first, 'utf8'), 'stub')
    const second = await ensurePowerShellInstalled(url, path.join(dir, 'storage'), null, opts)
    assert.equal(first, second)
    assert.equal(probes, 2)
    manifest.sha256 = '0'.repeat(64)
    await assert.rejects(ensurePowerShellInstalled(url, path.join(dir, 'other'), null, opts), /SHA-256/)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
