const vscode = acquireVsCodeApi()
const $ = (id) => document.getElementById(id)
const messages = $("messages")
const items = new Map()
let busy = false
let activeApproval = null
const approvalQueue = []

function post(type, extra = {}) {
	vscode.postMessage({ type, ...extra })
}
function clearEmpty() {
	messages.querySelector(".empty")?.remove()
}
function append(className, text) {
	clearEmpty()
	const element = document.createElement("div")
	element.className = className
	element.textContent = text
	messages.appendChild(element)
	messages.scrollTop = messages.scrollHeight
	return element
}
function resetThread() {
	messages.replaceChildren()
	items.clear()
	$("status").textContent = "新会话"
}
function setState(state) {
	$("login").hidden = state.loggedIn
	$("app").hidden = !state.loggedIn
	busy = state.busy
	$("send").hidden = busy
	$("stop").hidden = !busy
	$("workspace").textContent = state.workspace || "未打开工作区"
	const selected = $("model").value
	$("model").replaceChildren()
	for (const model of state.models || []) {
		const option = document.createElement("option")
		option.value = model.id
		option.textContent = model.name || model.id
		$("model").appendChild(option)
	}
	if ([...$("model").options].some((option) => option.value === selected)) $("model").value = selected
}
function showApproval(message) {
	if (activeApproval !== null) {
		approvalQueue.push(message)
		return
	}
	activeApproval = message.id
	const box = $("approval")
	box.replaceChildren()
	const title = document.createElement("strong")
	title.textContent = message.method.includes("command") ? "批准执行命令？" : "批准修改文件？"
	const details = document.createElement("pre")
	details.textContent =
		message.params.reason || message.params.command || message.params.cwd || JSON.stringify(message.params, null, 2)
	const yes = document.createElement("button")
	yes.className = "primary"
	yes.textContent = "允许"
	yes.onclick = () => decide("accept")
	const no = document.createElement("button")
	no.textContent = "拒绝"
	no.onclick = () => decide("decline")
	box.append(title, details, yes, no)
	box.hidden = false
}
function decide(decision) {
	if (activeApproval === null) return
	post("approve", { id: activeApproval, decision })
	activeApproval = null
	$("approval").hidden = true
	if (approvalQueue.length) showApproval(approvalQueue.shift())
}
window.addEventListener("message", (event) => {
	const message = event.data
	if (message.type === "state") setState(message)
	if (message.type === "notice") $("status").textContent = message.message
	if (message.type === "error") $("status").textContent = `错误：${message.message}`
	if (message.type === "approval") showApproval(message)
	if (message.type === "delta") {
		let item = items.get(message.itemId)
		if (!item) {
			item = append("message agent", "")
			items.set(message.itemId, item)
		}
		item.textContent += message.text || ""
		messages.scrollTop = messages.scrollHeight
	}
	if (message.type === "item") {
		const item = message.item
		if (!item) return
		if (item.type === "agentMessage" && message.method === "item/completed") {
			let element = items.get(item.id)
			if (!element) {
				element = append("message agent", "")
				items.set(item.id, element)
			}
			element.textContent = item.text || element.textContent
		} else if (["commandExecution", "fileChange"].includes(item.type) && message.method === "item/completed") {
			append(
				"event",
				`${item.type === "commandExecution" ? "命令" : "文件变更"} · ${item.status}\n${item.command || item.changes?.map((c) => c.path).join(", ") || ""}`,
			)
		}
	}
	if (message.type === "completed")
		$("status").textContent = message.status === "completed" ? "已完成" : `任务${message.status || "结束"}`
})
$("loginButton").onclick = () => post("login")
$("logout").onclick = () => {
	resetThread()
	post("logout")
}
$("newThread").onclick = () => {
	if (!busy) {
		resetThread()
		post("newThread")
	}
}
$("send").onclick = () => {
	const text = $("prompt").value.trim()
	const model = $("model").value
	if (!text || !model || busy) return
	append("message user", text)
	$("prompt").value = ""
	$("status").textContent = "正在执行…"
	post("send", { text, model })
}
$("prompt").onkeydown = (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault()
		$("send").click()
	}
}
$("stop").onclick = () => post("stop")
post("ready")
