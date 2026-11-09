const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateThreadTitle, normalizeTitle } = require('../threadTitle')

test('generates a concise title from a streamed Responses result', async () => {
	const originalFetch = global.fetch
	let request
	global.fetch = async (url, options) => {
		request = { url, options }
		return { ok: true, text: async () => 'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"修复登录接口超时。"}]}]}}\n\n' }
	}
	try {
		const title = await generateThreadTitle('https://example.test/codex/v1/responses', 'token', 'model', '登录接口偶尔超时')
		assert.equal(title, '修复登录接口超时')
		assert.equal(JSON.parse(request.options.body).store, false)
		assert.equal(request.options.headers.Authorization, 'Bearer token')
	} finally { global.fetch = originalFetch }
})

test('normalizes generated titles without splitting Unicode characters', () => {
	assert.equal(normalizeTitle('“优化任务列表显示。”'), '优化任务列表显示')
	assert.equal([...normalizeTitle('😀'.repeat(40))].length, 36)
})
