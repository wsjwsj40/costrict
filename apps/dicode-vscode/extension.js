const vscode = require("vscode")
const { spawn } = require("node:child_process")
const crypto = require("node:crypto")
const path = require("node:path")
const fs = require("node:fs")
const { ensureCodexInstalled } = require("./codexInstaller")
const EXTENSION_VERSION = require("./package.json").version

const TOKEN_KEY = "dicodeCodex.tokens"
const CLIENT_KEY = "dicodeCodex.machineId"
const THREAD_KEY = "dicodeCodex.thread"

class CodexClient {
	constructor(binary, baseUrl, token, onEvent) {
		this.onEvent = onEvent
		this.nextId = 1
		this.pending = new Map()
		this.buffer = ""
		this.proc = spawn(
			binary,
			[
				"app-server",
				"--listen",
				"stdio://",
				"-c",
				'model_provider="dicode"',
				"-c",
				'model_providers.dicode.name="DiCode"',
				"-c",
				`model_providers.dicode.base_url=${JSON.stringify(baseUrl)}`,
				"-c",
				'model_providers.dicode.env_key="DICODE_ACCESS_TOKEN"',
				"-c",
				'model_providers.dicode.wire_api="responses"',
				"-c",
				"model_providers.dicode.requires_openai_auth=false",
				"-c",
				"model_providers.dicode.supports_websockets=false",
			],
			{ env: { ...process.env, DICODE_ACCESS_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] },
		)
		this.proc.stdout.setEncoding("utf8")
		this.proc.stdout.on("data", (chunk) => this.consume(chunk))
		this.proc.stderr.on("data", (chunk) => onEvent({ type: "diagnostic", message: String(chunk).slice(0, 1000) }))
		this.proc.on("error", (error) =>
			this.fail(
				error.code === "ENOENT"
					? new Error("未找到 Codex CLI；请在扩展宿主安装 codex，或设置 dicodeCodex.codexPath 为完整路径")
					: error,
			),
		)
		this.proc.on("exit", (code) => this.fail(new Error(`Codex exited (${code})`)))
	}
	consume(chunk) {
		this.buffer += chunk
		if (this.buffer.length > 8 * 1024 * 1024) return this.fail(new Error("Codex message too large"))
		let newline
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline)
			this.buffer = this.buffer.slice(newline + 1)
			if (!line.trim()) continue
			let message
			try {
				message = JSON.parse(line)
			} catch {
				continue
			}
			if (message.id !== undefined && !message.method) {
				const pending = this.pending.get(message.id)
				if (pending) {
					this.pending.delete(message.id)
					clearTimeout(pending.timer)
					message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
				}
			} else if (message.method) {
				this.onEvent({ type: "rpc", message })
			}
		}
	}
	request(method, params = {}) {
		if (this.proc.exitCode !== null || this.proc.killed) return Promise.reject(new Error("Codex is unavailable"))
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${method} timed out`))
			}, 30000)
			this.pending.set(id, { resolve, reject, timer })
			this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
				if (error) {
					clearTimeout(timer)
					this.pending.delete(id)
					reject(error)
				}
			})
		})
	}
	notify(method, params = {}) {
		this.proc.stdin.write(JSON.stringify({ method, params }) + "\n")
	}
	respond(id, result) {
		this.proc.stdin.write(JSON.stringify({ id, result }) + "\n")
	}
	async initialize(version) {
		await this.request("initialize", { clientInfo: { name: "dicode", title: "DiCode", version } })
		this.notify("initialized")
	}
	fail(error) {
		if (this.closed) return
		this.closed = true
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer)
			pending.reject(error)
		}
		this.pending.clear()
		this.onEvent({ type: "error", message: error.message })
	}
	dispose() {
		this.closed = true
		this.proc.kill()
	}
}

class DicodeView {
	constructor(context) {
		this.context = context
		const savedThread = context.globalState.get(THREAD_KEY)
		this.threadId = savedThread?.cwd === this.workspace ? savedThread.id : null
		this.busy = false
		this.approvals = new Map()
		this.output = vscode.window.createOutputChannel("DiCode Codex")
	}
	get serverUrl() {
		return vscode.workspace.getConfiguration("dicodeCodex").get("serverUrl").replace(/\/$/, "")
	}
	get workspace() {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	}
	post(message) {
		this.view?.webview.postMessage(message)
	}
	resolveWebviewView(view) {
		this.view = view
		const nonce = crypto.randomBytes(16).toString("base64")
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
		}
		const media = (name) =>
			view.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", name)))
		const html = fs.readFileSync(path.join(this.context.extensionPath, "media", "index.html"), "utf8")
		view.webview.html = html
			.replaceAll("{{NONCE}}", nonce)
			.replaceAll("{{CSP}}", view.webview.cspSource)
			.replaceAll("{{CSS}}", media("style.css").toString())
			.replaceAll("{{JS}}", media("main.js").toString())
		view.webview.onDidReceiveMessage((message) =>
			this.handle(message).catch((error) => this.post({ type: "error", message: error.message })),
		)
		this.postState()
		this.tokens()
			.then((tokens) => tokens?.access_token && this.loadModels())
			.catch((error) => this.post({ type: "error", message: error.message }))
		this.ensureBinary().catch((error) => this.post({ type: "error", message: error.message }))
	}
	async tokens() {
		return this.context.secrets.get(TOKEN_KEY).then((raw) => (raw ? JSON.parse(raw) : null))
	}
	async saveTokens(tokens) {
		await this.context.secrets.store(TOKEN_KEY, JSON.stringify(tokens))
		this.postState()
	}
	async postState() {
		this.post({
			type: "state",
			loggedIn: !!(await this.tokens())?.access_token,
			busy: this.busy,
			threadId: this.threadId,
			workspace: this.workspace || "",
			models: this.models || [],
		})
	}
	params(state, machineId) {
		return new URLSearchParams({
			machine_code: machineId,
			state,
			provider: "casdoor",
			plugin_version: EXTENSION_VERSION,
			vscode_version: vscode.version,
			uri_scheme: vscode.env.uriScheme,
		})
	}
	async json(url, token) {
		const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
		if (!response.ok) throw new Error(`DiCode API returned ${response.status}`)
		return response.json()
	}
	async login() {
		const state = crypto.randomBytes(20).toString("hex")
		let machineId = this.context.globalState.get(CLIENT_KEY)
		if (!machineId) {
			machineId = vscode.env.machineId || crypto.randomUUID()
			await this.context.globalState.update(CLIENT_KEY, machineId)
		}
		const params = this.params(state, machineId)
		await vscode.env.openExternal(vscode.Uri.parse(`${this.serverUrl}/oidc-auth/api/v1/plugin/login?${params}`))
		this.post({ type: "notice", message: "请在浏览器完成登录…" })
		let tokens
		for (let attempt = 0; attempt < 60; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 3000))
			try {
				tokens = (await this.json(`${this.serverUrl}/oidc-auth/api/v1/plugin/login/token?${params}`)).data
			} catch {
				continue
			}
			if (tokens?.access_token && tokens?.refresh_token && tokens.state === state) break
		}
		if (!tokens?.access_token || tokens.state !== state) throw new Error("登录令牌获取超时")
		const statusParams = this.params(state, machineId)
		statusParams.delete("machine_code")
		for (let attempt = 0; attempt < 60; attempt++) {
			let status
			try {
				status = await this.json(
					`${this.serverUrl}/oidc-auth/api/v1/plugin/login/status?${statusParams}`,
					tokens.access_token,
				)
			} catch {
				/* retry */
			}
			if (status?.success && status.data?.status === "logged_in" && status.data.state === state) {
				await this.saveTokens(tokens)
				await this.loadModels()
				return
			}
			await new Promise((resolve) => setTimeout(resolve, 5000))
		}
		throw new Error("登录超时")
	}
	async accessToken() {
		const tokens = await this.tokens()
		if (!tokens?.access_token) throw new Error("请先登录")
		const payload = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"))
		if (payload.exp * 1000 > Date.now() + 5 * 60 * 1000) return tokens.access_token
		const machineId = this.context.globalState.get(CLIENT_KEY)
		const params = this.params(tokens.state, machineId)
		params.delete("machine_code")
		const refreshed = await this.json(
			`${this.serverUrl}/oidc-auth/api/v1/plugin/login/token?${params}`,
			tokens.refresh_token,
		)
		if (!refreshed.data?.access_token || refreshed.data.state !== tokens.state)
			throw new Error("登录已过期，请重新登录")
		await this.saveTokens(refreshed.data)
		this.client?.dispose()
		this.client = null
		this.loadedThreadId = null
		return refreshed.data.access_token
	}
	async loadModels() {
		const token = await this.accessToken()
		const response = await this.json(`${this.serverUrl}/ai-gateway/api/v1/models`, token)
		this.models = (response.data || []).filter((item) => item.id && item.id.toLowerCase() !== "auto")
		await this.postState()
	}
	async ensureClient() {
		const token = await this.accessToken()
		if (this.client) return this.client
		const binary = await this.ensureBinary()
		const client = new CodexClient(binary, `${this.serverUrl}/codex/v1`, token, (event) => this.onCodexEvent(event))
		this.client = client
		try {
			await client.initialize(EXTENSION_VERSION)
		} catch (error) {
			client.dispose()
			this.client = null
			throw error
		}
		return client
	}
	async ensureBinary() {
		const override = vscode.workspace.getConfiguration("dicodeCodex").get("codexPath")
		if (override && override !== "codex") return override
		if (!this.installPromise) {
			this.installPromise = ensureCodexInstalled(
				this.serverUrl,
				this.context.globalStorageUri.fsPath,
				(progress) => {
					this.post({
						type: "notice",
						message: progress === null ? "正在下载 Codex CLI…" : `正在安装 Codex CLI：${progress}%`,
					})
				},
			)
				.then((binary) => {
					this.post({ type: "notice", message: "Codex CLI 已就绪" })
					return binary
				})
				.catch((error) => {
					this.installPromise = null
					throw error
				})
		}
		return this.installPromise
	}
	onCodexEvent(event) {
		if (event.type === "diagnostic") {
			this.output.appendLine(event.message)
			return
		}
		if (event.type === "error") {
			this.client = null
			this.loadedThreadId = null
			this.busy = false
			this.post(event)
			this.postState()
			return
		}
		const { message } = event
		if (message.method?.endsWith("/requestApproval") && message.id !== undefined) {
			this.approvals.set(String(message.id), message.id)
			this.post({ type: "approval", id: String(message.id), method: message.method, params: message.params })
		} else if (message.method === "item/agentMessage/delta") {
			this.post({ type: "delta", itemId: message.params.itemId, text: message.params.delta })
		} else if (message.method === "item/started" || message.method === "item/completed") {
			this.post({ type: "item", method: message.method, item: message.params.item })
		} else if (message.method === "turn/completed") {
			this.busy = false
			this.turnId = null
			this.post({ type: "completed", status: message.params.turn?.status, error: message.params.turn?.error })
			this.postState()
		} else if (message.method === "error") {
			this.post({ type: "error", message: message.params.error?.message || "Codex error" })
		}
	}
	async send(text, model) {
		if (this.busy) throw new Error("当前任务仍在执行")
		if (!text) throw new Error("请输入任务")
		if (!this.workspace) throw new Error("请先打开工作区")
		if (!this.models?.some((item) => item.id === model)) throw new Error("请选择可用模型")
		const client = await this.ensureClient()
		if (this.threadId && this.loadedThreadId !== this.threadId) {
			try {
				await client.request("thread/resume", { threadId: this.threadId, excludeTurns: true })
			} catch {
				this.threadId = null
			}
			this.loadedThreadId = this.threadId
		}
		if (!this.threadId) {
			const result = await client.request("thread/start", {
				model,
				cwd: this.workspace,
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
			})
			this.threadId = result.thread.id
			this.loadedThreadId = this.threadId
			await this.context.globalState.update(THREAD_KEY, { id: this.threadId, cwd: this.workspace })
		}
		this.busy = true
		this.postState()
		try {
			const result = await client.request("turn/start", {
				threadId: this.threadId,
				cwd: this.workspace,
				model,
				input: [{ type: "text", text }],
			})
			this.turnId = result.turn.id
		} catch (error) {
			this.busy = false
			this.postState()
			throw error
		}
	}
	async handle(message) {
		if (message.type === "ready") {
			await this.postState()
			return
		}
		if (message.type === "login") {
			await this.login()
			return
		}
		if (message.type === "models") {
			await this.loadModels()
			return
		}
		if (message.type === "logout") {
			this.client?.dispose()
			this.client = null
			this.threadId = null
			this.loadedThreadId = null
			this.models = []
			await this.context.secrets.delete(TOKEN_KEY)
			await this.context.globalState.update(THREAD_KEY, undefined)
			await this.postState()
			return
		}
		if (message.type === "newThread") {
			if (this.busy) throw new Error("请先停止当前任务")
			this.threadId = null
			this.loadedThreadId = null
			await this.context.globalState.update(THREAD_KEY, undefined)
			await this.postState()
			return
		}
		if (message.type === "send") {
			await this.send(String(message.text || "").trim(), message.model)
			return
		}
		if (message.type === "stop" && this.busy && this.turnId) {
			await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
			return
		}
		if (message.type === "approve") {
			const id = this.approvals.get(String(message.id))
			if (id === undefined) return
			this.approvals.delete(String(message.id))
			this.client.respond(id, { decision: message.decision === "accept" ? "accept" : "decline" })
		}
	}
	dispose() {
		this.client?.dispose()
		this.output.dispose()
	}
}

function activate(context) {
	const provider = new DicodeView(context)
	context.subscriptions.push(vscode.window.registerWebviewViewProvider("dicodeCodex.sidebar", provider), provider)
}
module.exports = { activate, CodexClient }
