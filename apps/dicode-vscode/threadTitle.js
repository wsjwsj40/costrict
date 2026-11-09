const MAX_TITLE_CHARS = 36

function normalizeTitle(value) {
	if (typeof value !== "string") return null
	const title = value.trim().replace(/^["'`“‘]+|["'`”’]+$/g, "").replace(/\s+/g, " ").replace(/[。.!！?？]+$/u, "").trim()
	return title ? [...title].slice(0, MAX_TITLE_CHARS).join("") : null
}

function responseText(response) {
	return (response?.output || []).flatMap((item) => item?.content || []).filter((part) => part?.type === "output_text").map((part) => part.text || "").join("")
}

async function generateThreadTitle(url, token, model, userText) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 30000)
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				model,
				instructions: "为代码助手会话生成一个简洁、具体的任务标题，最多36个字。使用用户的语言，优先使用动词开头。只输出标题，不要引号、标点或解释。",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText.slice(0, 1200) }] }],
				tools: [], tool_choice: "auto", parallel_tool_calls: false, include: [], store: false, stream: true,
			}),
			signal: controller.signal,
		})
		if (!response.ok) throw new Error(`Title request returned ${response.status}`)
		const body = await response.text()
		if (body.length > 256000) throw new Error("Title response too large")
		let title = ""
		for (const event of body.split(/\r?\n\r?\n/)) {
			const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
			if (!data || data === "[DONE]") continue
			let payload
			try { payload = JSON.parse(data) } catch { continue }
			if (payload.type === "response.completed") title = responseText(payload.response) || title
			if (payload.type === "response.output_text.delta") title += payload.delta || ""
		}
		return normalizeTitle(title)
	} finally {
		clearTimeout(timeout)
	}
}

module.exports = { generateThreadTitle, normalizeTitle }
