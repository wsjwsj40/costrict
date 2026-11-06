const vscode = require("vscode")
const { spawn } = require("node:child_process")
const crypto = require("node:crypto")
const path = require("node:path")
const fs = require("node:fs")
const { ensureCodexInstalled } = require("./codexInstaller")
const { ensurePowerShellInstalled, powerShellEnv } = require("./powerShellInstaller")
const { beforeFromUnifiedDiff } = require("./diff")
const { ConversationStore } = require("./media/conversation")
const EXTENSION_VERSION = require("./package.json").version

const TOKEN_KEY = "dicodeCodex.tokens"
const CLIENT_KEY = "dicodeCodex.machineId"
const THREAD_KEY = "dicodeCodex.thread"
const HISTORY_KEY = "dicodeCodex.history"
const THREADS_KEY = "dicodeCodex.threads"

class CodexClient {
	constructor(binary, baseUrl, token, instructionsPath, onEvent, powerShellPath) {
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
				`model_instructions_file=${JSON.stringify(instructionsPath)}`,
				"-c",
				"features.default_mode_request_user_input=true",
				"-c",
				"tools.update_plan.enabled=true",
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
			{ env: { ...(powerShellPath ? powerShellEnv(powerShellPath) : process.env), DICODE_ACCESS_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] },
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
		if (this.closed) return
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
		if (this.closed || this.proc.exitCode !== null || this.proc.killed) return Promise.reject(new Error("Codex is unavailable"))
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
		if (this.closed) return
		this.proc.stdin.write(JSON.stringify({ method, params }) + "\n")
	}
	respond(id, result) {
		if (this.closed) return
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
		if (this.closed) return
		this.closed = true
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer)
			pending.reject(new Error("Codex connection closed"))
		}
		this.pending.clear()
		this.proc.kill()
	}
}

class DicodeView {
	constructor(context) {
		this.context = context
		const savedThread = context.globalState.get(THREAD_KEY)
		this.threadId = savedThread?.cwd === this.workspace ? savedThread.id : null
		this.busy = false
		this.stopping = false
		this.interruptSent = false
		this.runSequence = 0
		this.activeRunId = null
		this.approvals = new Map()
		this.inputRequests = new Map()
		this.instructionsPath = path.join(context.extensionPath, "dicode-instructions.md")
		this.instructions = fs.readFileSync(this.instructionsPath, "utf8")
		this.conversation = new ConversationStore()
		this.threads = context.globalState.get(THREADS_KEY, [])
		const savedHistory = context.globalState.get(HISTORY_KEY)
		if (!this.threads.length && savedHistory?.threadId)
			this.threads = [{ id: savedHistory.threadId, cwd: savedHistory.cwd, title: savedHistory.snapshot?.turns?.[0]?.user || "历史会话", updatedAt: Date.now(), snapshot: savedHistory.snapshot }]
		const current = this.threads.find((thread) => thread.id === this.threadId && thread.cwd === this.workspace)
		if (current?.snapshot) this.conversation.restore(current.snapshot)
		this.output = vscode.window.createOutputChannel("DiCode Codex")
		this.beforeDocuments = new Map()
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
			.replaceAll("{{JS}}", media("bundle.js").toString())
		view.webview.onDidReceiveMessage((message) =>
			this.handle(message).catch((error) => { this.post({ type: "error", message: error.message }); this.postState() }),
		)
		this.postState()
		this.tokens()
			.then((tokens) => tokens?.access_token && this.loadModels())
			.catch((error) => this.post({ type: "error", message: error.message }))
		this.ensureBinary().catch((error) => this.post({ type: "error", message: error.message }))
		if (process.platform === "win32") this.ensurePowerShell().catch((error) => this.post({ type: "error", message: error.message }))
	}
	async tokens() {
		return this.context.secrets.get(TOKEN_KEY).then((raw) => (raw ? JSON.parse(raw) : null))
	}
	async saveTokens(tokens) {
		await this.context.secrets.store(TOKEN_KEY, JSON.stringify(tokens))
		this.postState()
	}
	async postState() {
		const version = (this.stateVersion = (this.stateVersion || 0) + 1)
		const lastTurn = this.conversation.turns.at(-1)
		const state = {
			type: "state",
			version,
			busy: this.busy,
			stopping: this.stopping,
			lastTurn: lastTurn ? { id: lastTurn.id, status: lastTurn.status, error: lastTurn.error } : null,
			threadId: this.threadId,
			workspace: this.workspace || "",
			models: this.models || [],
			threads: this.threads.filter((thread) => thread.cwd === this.workspace).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
		}
		state.loggedIn = !!(await this.tokens())?.access_token
		this.post(state)
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
		if (this.clientPromise) return this.clientPromise
		if (this.client) return this.client
		const pending = (async () => {
			const [binary, powerShellPath] = await Promise.all([this.ensureBinary(), process.platform === "win32" ? this.ensurePowerShell() : Promise.resolve(null)])
			const client = new CodexClient(binary, `${this.serverUrl}/codex/v1`, token, this.instructionsPath, (event) => {
				if (this.client === client) this.onCodexEvent(event)
			}, powerShellPath)
			this.client = client
			try {
				await client.initialize(EXTENSION_VERSION)
			} catch (error) {
				client.dispose()
				if (this.client === client) this.client = null
				throw error
			}
			return client
		})()
		this.clientPromise = pending
		try { return await pending } finally { if (this.clientPromise === pending) this.clientPromise = null }
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
	async ensurePowerShell() {
		if (!this.powerShellPromise) {
			this.powerShellPromise = ensurePowerShellInstalled(this.serverUrl, this.context.globalStorageUri.fsPath, (progress) => {
				this.post({ type: "notice", message: progress === null ? "正在下载 PowerShell 7…" : `正在安装 PowerShell 7：${progress}%` })
			}).then((executable) => {
				this.post({ type: "notice", message: "PowerShell 7 已就绪" })
				return executable
			}).catch((error) => { this.powerShellPromise = null; throw error })
		}
		return this.powerShellPromise
	}
	onCodexEvent(event) {
		if (event.type === "diagnostic") {
			this.output.appendLine(event.message)
			return
		}
		if (event.type === "error") {
			clearTimeout(this.stopTimer)
			this.client = null
			this.loadedThreadId = null
			this.busy = false
			this.stopping = false
			this.interruptSent = false
			this.activeRunId = null
			this.turnId = null
			this.approvals.clear()
			this.post({ type: "approvalsCleared" })
			this.clearInputRequests()
			const turn = this.conversation.turns.at(-1)
			if (turn && ["starting", "inProgress"].includes(turn.status)) { turn.status = "failed"; turn.error = { message: event.message }; this.persistHistory() }
			this.post(event)
			this.postState()
			return
		}
		const { message } = event
		if (message.method?.endsWith("/requestApproval") && message.id !== undefined) {
			const decisions = (message.params?.availableDecisions || ["accept", "decline"]).map((entry) => typeof entry === "string" ? entry : entry.decision).filter(Boolean)
			this.approvals.set(String(message.id), { id: message.id, decisions, method: message.method, params: message.params })
			this.post({ type: "approval", id: String(message.id), method: message.method, params: message.params })
		} else if (message.method === "item/tool/requestUserInput" && message.id !== undefined) {
			this.inputRequests.set(String(message.id), { id: message.id, params: message.params, submitted: false })
			this.post({ type: "userInputRequest", id: String(message.id), params: message.params })
		} else if (message.method === "serverRequest/resolved") {
			const requestId = String(message.params?.requestId ?? message.params?.id)
			this.approvals.delete(requestId)
			this.inputRequests.delete(requestId)
			this.post({ type: "rpc", method: message.method, params: message.params })
		} else if (message.method === "turn/completed") {
			clearTimeout(this.stopTimer)
			this.stopping = false
			this.interruptSent = false
			this.activeRunId = null
			this.conversation.receive(message.method, message.params)
			if (message.params?.turn?.status === "interrupted" || message.params?.turn?.status === "failed") {
				this.approvals.clear()
				this.post({ type: "approvalsCleared" })
			}
			this.clearInputRequests()
			this.persistHistory()
			this.busy = false
			this.turnId = null
			this.post({ type: "rpc", method: message.method, params: message.params })
			this.postState()
		} else if (message.method === "error") {
			this.post({ type: "error", message: message.params.error?.message || "Codex error" })
		} else if (/^(turn\/|item\/)/.test(message.method || "")) {
			if (message.method === "turn/started" && this.busy) {
				this.turnId = message.params?.turn?.id || this.turnId
				if (this.stopping) this.interruptCurrentTurn()
			}
			const params = message.params?.item?.type === "reasoning"
				? { ...message.params, item: { ...message.params.item, content: undefined } }
				: message.params
			this.conversation.receive(message.method, params)
			this.scheduleHistory()
			this.post({ type: "rpc", method: message.method, params })
		}
	}
	clearInputRequests() {
		if (!this.inputRequests.size) return
		this.inputRequests.clear()
		this.post({ type: "userInputsCleared" })
	}
	answerUserInput(message) {
		const request = this.inputRequests.get(String(message.id))
		if (!request || request.submitted || !this.client || this.client.closed) return
		const questions = request.params?.questions
		if (!Array.isArray(questions) || !questions.length || questions.length > 3) throw new Error("用户输入请求格式无效")
		const submitted = message.answers
		if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) || Object.keys(submitted).length !== questions.length) throw new Error("请回答所有问题")
		const answers = {}
		for (const question of questions) {
			if (typeof question.id !== "string" || !question.id) throw new Error("问题编号无效")
			const entries = submitted[question.id]?.answers
			const options = (question.options || []).map((option) => option.label)
			if (!Array.isArray(entries) || !entries.length || entries.length > 2 || entries.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 4000)) throw new Error("回答格式无效")
			if (entries.filter((entry) => options.includes(entry)).length > 1 || entries.some((entry) => !options.includes(entry) && !/^user_note: \S/.test(entry))) throw new Error("回答不在可选范围内")
			answers[question.id] = { answers: entries }
		}
		request.submitted = true
		this.client.respond(request.id, { answers })
		this.post({ type: "userInputSubmitted", id: String(message.id) })
	}
	async interruptCurrentTurn() {
		if (!this.busy || !this.stopping || !this.turnId || this.interruptSent || !this.client) return
		this.interruptSent = true
		try {
			await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
			if (this.busy && this.stopping) {
				clearTimeout(this.stopTimer)
				this.stopTimer = setTimeout(() => this.recoverStoppedTurn(), 8000)
			}
		} catch (error) {
			if (this.busy && this.stopping) this.recoverStoppedTurn(`停止确认失败：${error.message}`)
		}
	}
	async stop() {
		if (!this.busy || this.stopping) return
		this.stopping = true
		this.postState()
		this.stopTimer = setTimeout(() => this.recoverStoppedTurn(), 15000)
		this.interruptCurrentTurn()
	}
	recoverStoppedTurn(reason = "未收到结束通知，已重连 Agent") {
		if (!this.busy || !this.stopping) return
		clearTimeout(this.stopTimer)
		this.busy = false
		this.stopping = false
		this.interruptSent = false
		this.activeRunId = null
		this.turnId = null
		this.client?.dispose()
		this.client = null
		this.loadedThreadId = null
		this.approvals.clear()
		this.post({ type: "approvalsCleared" })
		this.clearInputRequests()
		const turn = this.conversation.turns.at(-1)
		if (turn && ["starting", "inProgress"].includes(turn.status))
			this.conversation.receive("turn/completed", { turnId: turn.id, turn: { id: turn.id, status: "interrupted" } })
		this.persistHistory()
		this.post({ type: "stopped", message: reason })
		this.postState()
	}
	scheduleHistory() {
		if (this.historyTimer) return
		this.historyTimer = setTimeout(() => { this.historyTimer = null; this.persistHistory() }, 1500)
	}
	persistHistory() {
		if (!this.threadId) return
		const snapshot = this.conversation.snapshot()
		while (snapshot.turns.length > 1 && JSON.stringify(snapshot).length > 2_000_000) snapshot.turns.shift()
		const previous = this.threads.find((thread) => thread.id === this.threadId && thread.cwd === this.workspace)
		const title = previous?.title || (typeof snapshot.turns?.[0]?.user === "string" ? snapshot.turns[0].user.slice(0, 60) || "新会话" : "新会话")
		this.threads = [{ id: this.threadId, cwd: this.workspace, title, updatedAt: Date.now(), snapshot }, ...this.threads.filter((thread) => thread.id !== this.threadId || thread.cwd !== this.workspace)].slice(0, 20)
		this.context.globalState.update(THREADS_KEY, this.threads)
		this.postState()
	}
	async send(text, model) {
		if (this.busy) throw new Error("当前任务仍在执行")
		if (!text) throw new Error("请输入任务")
		if (!this.workspace) throw new Error("请先打开工作区")
		if (!this.models?.some((item) => item.id === model)) throw new Error("请选择可用模型")
		this.busy = true
		const runId = ++this.runSequence
		this.activeRunId = runId
		this.stopping = false
		this.interruptSent = false
		this.turnId = null
		this.conversation.begin(text)
		this.postState()
		try {
			const client = await this.ensureClient()
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			if (this.threadId && this.loadedThreadId !== this.threadId) {
				try {
					await client.request("thread/resume", { threadId: this.threadId, excludeTurns: true, baseInstructions: this.instructions })
				} catch (error) {
					throw new Error(`无法恢复当前会话：${error.message}`)
				}
				this.loadedThreadId = this.threadId
			}
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			if (!this.threadId) {
				const started = await client.request("thread/start", {
					model,
					cwd: this.workspace,
					approvalPolicy: "on-request",
					sandbox: "workspace-write",
					baseInstructions: this.instructions,
				})
				this.threadId = started.thread.id
				this.loadedThreadId = this.threadId
				await this.context.globalState.update(THREAD_KEY, { id: this.threadId, cwd: this.workspace })
			}
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			this.conversation.threadId = this.threadId
			this.persistHistory()
			const result = await client.request("turn/start", {
				threadId: this.threadId,
				cwd: this.workspace,
				model,
				input: [{ type: "text", text }],
			})
			if (this.activeRunId === runId && this.busy) {
				this.turnId = this.turnId || result.turn.id
				if (this.stopping) this.interruptCurrentTurn()
			}
		} catch (error) {
			if (this.activeRunId !== runId) return
			clearTimeout(this.stopTimer)
			this.busy = false
			this.stopping = false
			this.activeRunId = null
			const turn = this.conversation.turns.at(-1)
			if (turn?.status === "starting") { turn.status = "failed"; turn.error = { message: error.message }; this.persistHistory() }
			this.postState()
			throw error
		}
	}
	async handle(message) {
		if (message.type === "ready") {
			await this.postState()
			if (this.conversation.turns.length) this.post({ type: "history", snapshot: this.conversation.snapshot() })
			for (const [id, approval] of this.approvals) this.post({ type: "approval", id, method: approval.method, params: approval.params })
			for (const [id, input] of this.inputRequests) this.post({ type: "userInputRequest", id, params: input.params, submitted: input.submitted })
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
			clearTimeout(this.stopTimer)
			clearTimeout(this.historyTimer)
			this.client?.dispose()
			this.client = null
			this.busy = false
			this.stopping = false
			this.activeRunId = null
			this.turnId = null
			this.approvals.clear()
			this.clearInputRequests()
			this.threadId = null
			this.loadedThreadId = null
			this.models = []
			this.conversation.reset()
			this.threads = []
			await this.context.secrets.delete(TOKEN_KEY)
			await this.context.globalState.update(THREAD_KEY, undefined)
			await this.context.globalState.update(HISTORY_KEY, undefined)
			await this.context.globalState.update(THREADS_KEY, undefined)
			await this.postState()
			return
		}
		if (message.type === "newThread") {
			if (this.busy) throw new Error("请先停止当前任务")
			this.threadId = null
			this.loadedThreadId = null
			this.conversation.reset()
			await this.context.globalState.update(THREAD_KEY, undefined)
			await this.postState()
			return
		}
		if (message.type === "switchThread") {
			if (this.busy) throw new Error("请先停止当前任务")
			const selected = this.threads.find((thread) => thread.id === message.threadId && thread.cwd === this.workspace)
			if (!selected) throw new Error("会话不存在")
			this.threadId = selected.id
			this.loadedThreadId = null
			this.conversation.restore(selected.snapshot)
			await this.context.globalState.update(THREAD_KEY, { id: this.threadId, cwd: this.workspace })
			await this.postState()
			this.post({ type: "history", snapshot: this.conversation.snapshot() })
			return
		}
		if (message.type === "send") {
			await this.send(String(message.text || "").trim(), message.model)
			return
		}
		if (message.type === "openFile" || message.type === "openLink" || message.type === "openDiff") {
			const target = String(message.path || message.href || "")
			if (message.type === "openLink" && /^https?:\/\//i.test(target)) {
				await vscode.env.openExternal(vscode.Uri.parse(target))
				return
			}
			if (!this.workspace) return
			const location = /(?:#L|:)(\d+)$/.exec(target)
			const file = path.resolve(this.workspace, location ? target.slice(0, location.index) : target)
			const relative = path.relative(this.workspace, file)
			if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("文件不在当前工作区")
			if (message.type === "openDiff") {
				const current = fs.readFileSync(file, "utf8")
				const before = beforeFromUnifiedDiff(current, String(message.diff || ""))
				const id = crypto.randomUUID()
				this.beforeDocuments.set(id, before)
				if (this.beforeDocuments.size > 20) this.beforeDocuments.delete(this.beforeDocuments.keys().next().value)
				const beforeUri = vscode.Uri.from({ scheme: "dicode-before", path: `/${relative}`, query: id })
				await vscode.commands.executeCommand("vscode.diff", beforeUri, vscode.Uri.file(file), `${relative} · DiCode 变更`)
				return
			}
			const document = await vscode.workspace.openTextDocument(file)
			await vscode.window.showTextDocument(document, location ? { selection: new vscode.Range(Number(location[1]) - 1, 0, Number(location[1]) - 1, 0) } : undefined)
			return
		}
		if (message.type === "stop") {
			await this.stop()
			return
		}
		if (message.type === "approve") {
			const approval = this.approvals.get(String(message.id))
			if (!approval || !approval.decisions.includes(message.decision)) return
			this.approvals.delete(String(message.id))
			this.client.respond(approval.id, { decision: message.decision })
			return
		}
		if (message.type === "answerUserInput") {
			try { this.answerUserInput(message) }
			catch (error) { this.post({ type: "userInputError", id: String(message.id), message: error.message }) }
		}
	}
	dispose() {
		clearTimeout(this.stopTimer)
		clearTimeout(this.historyTimer)
		this.persistHistory()
		this.client?.dispose()
		this.output.dispose()
	}
}

function activate(context) {
	const provider = new DicodeView(context)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("dicodeCodex.sidebar", provider),
		vscode.workspace.registerTextDocumentContentProvider("dicode-before", { provideTextDocumentContent: (uri) => provider.beforeDocuments.get(uri.query) || "" }),
		provider,
	)
}
module.exports = { activate, CodexClient, DicodeView }
