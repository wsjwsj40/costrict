const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateThreadTitle, normalizeTitle, shortRequestTitle } = require('../threadTitle')

test('short single-line requests can serve as their own titles', () => {
	assert.equal(shortRequestTitle('你好'), '你好')
	assert.equal(shortRequestTitle('修复登录接口超时。'), '修复登录接口超时')
	assert.equal(shortRequestTitle('第一行\n第二行'), null)
	assert.equal(shortRequestTitle('这是一段超过三十六个字符的请求文本，需要继续调用模型生成更合适的简短标题。'), null)
})

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
