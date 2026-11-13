const vscode = require("vscode")
const { spawn, execFile } = require("node:child_process")
const { promisify } = require("node:util")
const crypto = require("node:crypto")
const path = require("node:path")
const { fileURLToPath } = require("node:url")
const fs = require("node:fs")
const { ensureCodexInstalled } = require("./codexInstaller")
const { ensurePowerShellInstalled, powerShellEnv } = require("./powerShellInstaller")
const { beforeFromUnifiedDiff, historicalDiff } = require("./diff")
const { unifiedDiff } = require("./unifiedDiff")
const { dynamicTools, editFile } = require("./fileEditTools")
const { ConversationStore } = require("./media/conversation")
const { generateThreadTitle } = require("./threadTitle")
const EXTENSION_VERSION = require("./package.json").version
const FILE_EDIT_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, "file-edit-instructions.md"), "utf8").trim()

const TOKEN_KEY = "dicodeCodex.tokens"
const CLIENT_KEY = "dicodeCodex.machineId"
const THREAD_KEY = "dicodeCodex.thread"
const HISTORY_KEY = "dicodeCodex.history"
const THREADS_KEY = "dicodeCodex.threads"
const PERMISSION_KEY = "dicodeCodex.permissionMode"
const PERMISSION_MODES = {
	request: { sandbox: "read-only", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "on-request" },
	auto: { sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalPolicy: "on-request" },
	full: { sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" },
}

async function importLocalSkill(source, workspace) {
	const sourcePath = await fs.promises.realpath(source)
	const stat = await fs.promises.stat(sourcePath)
	if (!stat.isDirectory()) throw new Error("请选择技能文件夹")
	let contents
	try { contents = await fs.promises.readFile(path.join(sourcePath, "SKILL.md"), "utf8") }
	catch { throw new Error("所选文件夹中没有 SKILL.md") }
	const frontmatter = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/.exec(contents)?.[1]
	if (!frontmatter || !/^name:\s*\S/m.test(frontmatter) || !/^description:\s*\S/m.test(frontmatter))
		throw new Error("SKILL.md 需要包含 name 和 description 元数据")
	const root = path.join(workspace, ".agents", "skills")
	const destination = path.join(root, path.basename(sourcePath))
	const relative = path.relative(sourcePath, destination)
	if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
		throw new Error("请选择工作区技能目录之外的文件夹")
	await fs.promises.mkdir(root, { recursive: true })
	try { await fs.promises.mkdir(destination) }
	catch (error) { if (error.code === "EEXIST") throw new Error(`技能目录已存在：${path.basename(destination)}`); throw error }
	try {
		for (const entry of await fs.promises.readdir(sourcePath)) {
			await fs.promises.cp(path.join(sourcePath, entry), path.join(destination, entry), { recursive: true, force: false, errorOnExist: true, filter: async item => {
				if ((await fs.promises.lstat(item)).isSymbolicLink()) throw new Error("技能文件夹不能包含符号链接")
				return true
			} })
		}
	} catch (error) {
		await fs.promises.rm(destination, { recursive: true, force: true })
		throw error
	}
	return destination
}

async function bundledModels(binary) {
	let stdout
	try {
		const result = await promisify(execFile)(binary, ["debug", "models", "--bundled"], { maxBuffer: 16 * 1024 * 1024 })
		stdout = result.stdout
	} catch (error) {
		throw new Error(`无法读取 Codex CLI 内置模型指令：${error.message}`)
	}
	let catalog
	try { catalog = JSON.parse(stdout) } catch { throw new Error("Codex CLI 内置模型目录不是有效 JSON") }
	if (!Array.isArray(catalog.models)) throw new Error("Codex CLI 内置模型目录缺少 models")
	return catalog.models
}

function nativeInstructions(model) {
	return model?.model_messages?.instructions_template || model?.base_instructions || ""
}

function modelCatalog(models, nativeModels, platform = process.platform) {
	// Codex rejects custom model entries without a base template, so reuse the
	// template bundled with the exact CLI binary that will run this catalog.
	const candidates = nativeModels.filter((model) => nativeInstructions(model))
	const fallback = candidates.reduce((best, model) => !best || (model.priority ?? Infinity) < (best.priority ?? Infinity) ? model : best, null)
	if (!fallback) throw new Error("Codex CLI 内置模型目录没有可用的基础指令")
	return { models: models.map((item, priority) => {
		const native = candidates.find((model) => model.slug === item.id) || fallback
		const instructions = nativeInstructions(native)
		return {
			slug: item.id,
			display_name: item.name || item.id,
			description: null,
			supported_reasoning_levels: ["low", "medium", "high"].map(effort => ({ effort, description: effort })),
			default_reasoning_level: "medium",
			...(Number.isFinite(item.contextWindow) && item.contextWindow > 0 ? { context_window: item.contextWindow, effective_context_window_percent: native.effective_context_window_percent ?? 95 } : {}),
			shell_type: "unified_exec",
			visibility: "list",
			supported_in_api: true,
			priority,
			availability_nux: null,
			upgrade: null,
			model_messages: {
				...native.model_messages,
				instructions_template: instructions,
				tools: {
					...native.model_messages?.tools,
					functions_namespace_functions_description_prefixes: { ...native.model_messages?.tools?.functions_namespace_functions_description_prefixes },
				},
			},
			base_instructions: instructions,
			supports_reasoning_summaries: false,
			supports_parallel_tool_calls: false,
			support_verbosity: false,
			default_verbosity: null,
			apply_patch_tool_type: null,
			truncation_policy: { mode: "bytes", limit: 10000 },
			experimental_supported_tools: [],
		}
	}) }
}

class CodexClient {
	constructor(binary, baseUrl, token, identity, catalogPath, onEvent, powerShellPath, platform = process.platform, windowsSandboxFallback = "unelevated") {
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
			`developer_instructions=${JSON.stringify(`${identity}\n\n${FILE_EDIT_INSTRUCTIONS}`)}`,
				"-c",
				`model_catalog_json=${JSON.stringify(catalogPath)}`,
				"-c",
				"features.default_mode_request_user_input=true",
				"-c",
				"tools.update_plan.enabled=true",
				// MXC is preferred when available; the legacy sandbox prevents every
				// ordinary command from requiring approval on older Windows hosts.
				...(platform === "win32" ? ["-c", "features.prefer_mxc=true", "-c", `windows.sandbox=${JSON.stringify(windowsSandboxFallback)}`] : []),
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
			{ env: { ...(powerShellPath ? powerShellEnv(powerShellPath, process.env, binary) : process.env), DICODE_ACCESS_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] },
		)
		this.proc.stdout.setEncoding("utf8")
		this.proc.stdout.on("data", (chunk) => this.consume(chunk))
		this.proc.stderr.on("data", (chunk) => onEvent({ type: "diagnostic", message: String(chunk).slice(0, 1000) }))
		this.proc.stdin.on("error", (error) => this.fail(error))
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
	respond(id, result, onWritten) {
		if (this.closed || !this.proc?.stdin?.writable) {
			onWritten?.(new Error("Codex CLI 连接已断开"))
			return
		}
		try { this.proc.stdin.write(JSON.stringify({ id, result }) + "\n", onWritten) }
		catch (error) { onWritten?.(error) }
	}
	async initialize(version) {
		await this.request("initialize", { clientInfo: { name: "dicode", title: "DiCode", version }, capabilities: { experimentalApi: true } })
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
		if (!this.proc.killed) this.proc.kill()
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
		this.attachmentRecords = new Map()
		this.identityPath = path.join(context.extensionPath, "dicode-instructions.md")
		this.identity = fs.readFileSync(this.identityPath, "utf8").trim()
		this.conversation = new ConversationStore()
		this.threads = context.globalState.get(THREADS_KEY, [])
		const savedPermission = context.workspaceState?.get(PERMISSION_KEY)
		this.permissionMode = savedPermission === "auto" ? "auto" : "request"
		this.fullAccessWorkspace = null
		this.titleJobs = new Set()
		const savedHistory = context.globalState.get(HISTORY_KEY)
		if (!this.threads.length && savedHistory?.threadId)
			this.threads = [{ id: savedHistory.threadId, cwd: savedHistory.cwd, title: savedHistory.snapshot?.turns?.[0]?.user ? "正在生成标题…" : "历史会话", updatedAt: Date.now(), snapshot: savedHistory.snapshot }]
		const current = this.threads.find((thread) => thread.id === this.threadId && thread.cwd === this.workspace)
		this.dynamicToolsEnabled = Boolean(savedThread?.dynamicToolsEnabled || current?.dynamicToolsEnabled)
		if (current?.snapshot) this.conversation.restore(current.snapshot)
		this.activeModel = this.conversation.tokenUsage?.modelId || null
		this.output = vscode.window.createOutputChannel("DiCode Codex")
		this.beforeDocuments = new Map()
		this.afterDocuments = new Map()
		this.editSequence = 0
	}
	get serverUrl() {
		return vscode.workspace.getConfiguration("dicodeCodex").get("serverUrl").replace(/\/$/, "")
	}
	get workspace() {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	}
	summaryDiff(turn) {
		if (turn.diff?.trim()) return turn.diff
		const files = new Map()
		for (const item of turn.items || []) {
			if (item.type !== "fileChange") continue
			for (const [index, change] of (item.raw?.changes || []).entries()) {
				const file = change.path || change.filePath
				if (!file) continue
				const marker = { turnId: turn.id, itemId: item.id, changeIndex: index, path: file }
				const found = files.get(file)
				files.set(file, { first: found?.first || marker, last: marker, fallback: change.diff || found?.fallback })
			}
		}
		const diffs = []
		for (const [file, entry] of files) {
			try {
				const absolute = path.resolve(this.workspace, file)
				const relative = path.relative(this.workspace, absolute)
				if (relative.startsWith("..") || path.isAbsolute(relative)) continue
				const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : ""
				const before = historicalDiff(current, this.conversation.turns, entry.first).before
				const after = historicalDiff(current, this.conversation.turns, entry.last).after
				const diff = unifiedDiff(file, before, after)
				if (diff) diffs.push(diff)
			} catch {
				if (entry.fallback) diffs.push(entry.fallback)
			}
		}
		return diffs.join("\n")
	}
	openChanges(turnId, selectedPath) {
		const turn = this.conversation.turns.find((entry) => entry.id === turnId)
		if (!turn) throw new Error("找不到这轮修改")
		const diff = this.summaryDiff(turn)
		if (!diff) throw new Error("这轮没有可显示的文件差异")
		const panel = vscode.window.createWebviewPanel("dicodeChanges", "DiCode 改动", vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))],
		})
		const nonce = crypto.randomBytes(16).toString("base64")
		const media = (name) => panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", name)))
		panel.webview.onDidReceiveMessage((message) => {
			if (message.type === "ready") panel.webview.postMessage({ type: "changes", diff, selectedPath })
			else this.handle(message).catch((error) => vscode.window.showErrorMessage(error.message))
		})
		panel.webview.html = fs.readFileSync(path.join(this.context.extensionPath, "media", "index.html"), "utf8")
			.replace("</head>", '<meta name="dicode-view" content="changes"></head>')
			.replaceAll("{{NONCE}}", nonce)
			.replaceAll("{{CSP}}", panel.webview.cspSource)
			.replaceAll("{{CSS}}", media("style.css").toString())
			.replaceAll("{{BRAND}}", media("brand.svg").toString())
			.replaceAll("{{JS}}", media("bundle.js").toString())
	}
	post(message) {
		this.view?.webview.postMessage(message)
	}
	resolveWebviewView(view) {
		this.view = view
		const nonce = crypto.randomBytes(16).toString("base64")
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media")), ...(this.workspace ? [vscode.Uri.file(path.join(this.workspace, ".dicode", "attachments"))] : [])],
		}
		const media = (name) =>
			view.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", name)))
		const html = fs.readFileSync(path.join(this.context.extensionPath, "media", "index.html"), "utf8")
		view.webview.html = html
			.replaceAll("{{NONCE}}", nonce)
			.replaceAll("{{CSP}}", view.webview.cspSource)
			.replaceAll("{{CSS}}", media("style.css").toString())
			.replaceAll("{{BRAND}}", media("brand.svg").toString())
			.replaceAll("{{JS}}", media("bundle.js").toString())
		this.coordinator ||= new ConversationCoordinator(this)
		view.webview.onDidReceiveMessage((message) =>
			this.coordinator.handle(message).catch((error) => { this.coordinator.active.post({ type: "error", message: error.message, requestType: message.type }); this.coordinator.active.postState() }),
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
		if (this.permissionMode === "full" && this.fullAccessWorkspace !== this.workspace) this.permissionMode = "request"
		const version = (this.stateVersion = (this.stateVersion || 0) + 1)
		const lastTurn = this.conversation.turns.at(-1)
		const state = {
			type: "state",
			version,
			busy: this.busy,
			stopping: this.stopping,
			lastTurn: lastTurn ? { id: lastTurn.id, status: lastTurn.status, error: lastTurn.error, ...(typeof lastTurn.stopRequested === "boolean" ? { stopRequested: lastTurn.stopRequested } : {}) } : null,
			threadId: this.threadId,
			permissionMode: this.permissionMode,
			workspace: this.workspace || "",
			models: this.models || [],
			modelsLoading: !!this.modelsLoading,
			modelsError: this.modelsError || null,
			tokenUsage: this.conversation.tokenUsage || null,
			threads: this.threads.filter((thread) => thread.cwd === this.workspace).map(({ id, title, updatedAt, snapshot }) => ({ id, title, updatedAt, waiting: id === this.threadId && (this.inputRequests.size > 0 || this.approvals.size > 0), turns: (snapshot?.turns || []).map(turn => ({ user: turn.user, status: turn.status, completedAt: turn.completedAt, answer: (turn.items || []).filter(item => item.type === "agentMessage").at(-1)?.text || "" })) })),
		}
		if (this.coordinator) {
			state.historyUnread = this.coordinator.unread.size > 0
			for (const thread of state.threads) {
				const session = this.coordinator.sessions.find(item => item.threadId === thread.id)
				if (session) thread.waiting = session.inputRequests.size > 0 || session.approvals.size > 0
			}
		}
		const tokens = await this.tokens()
		state.loggedIn = !!tokens?.access_token
		const claims = []
		for (const token of [tokens?.access_token, tokens?.id_token, tokens?.refresh_token]) {
			try { claims.push(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))) } catch { /* Missing or opaque token. */ }
		}
		const first = values => values.find(value => typeof value === "string" && value.trim())?.trim()
		const identifiers = new Set(claims.flatMap(jwt => [jwt.id, jwt.sub, jwt.preferred_username, jwt.properties?.oauth_GitHub_username]).filter(value => typeof value === "string" && value.trim()).map(value => value.trim().toLowerCase()))
		const name = first(claims.flatMap(jwt => [jwt.displayName, jwt.display_name, jwt.realName, jwt.real_name, jwt.name, jwt.properties?.displayName, jwt.properties?.display_name, jwt.properties?.realName, jwt.properties?.real_name]).filter(value => typeof value === "string" && !/^\d+$/.test(value.trim()) && !identifiers.has(value.trim().toLowerCase())))
		state.user = { name, email: first(claims.flatMap(jwt => [jwt.email, jwt.properties?.oauth_GitHub_email])), picture: first(claims.flatMap(jwt => [jwt.picture, jwt.avatar])) }
		if (version === this.stateVersion) this.post(state)
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
		if (!response.ok) {
			const error = new Error(`DiCode API ${new URL(url).pathname} 返回 ${response.status}`)
			error.status = response.status
			throw error
		}
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
	async accessToken(forceRefresh = false) {
		const tokens = await this.tokens()
		if (!tokens?.access_token) throw new Error("请先登录")
		const payload = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"))
		if (!forceRefresh && payload.exp * 1000 > Date.now() + 5 * 60 * 1000) return tokens.access_token
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
		if (this.modelsPromise) return this.modelsPromise
		this.modelsLoading = true
		this.modelsError = null
		this.postState()
		const pending = (async () => {
			try {
				const token = await this.accessToken()
				const url = `${this.serverUrl}/ai-gateway/api/v1/models`
				let response
				try { response = await this.json(url, token) } catch (error) {
					if (error.status !== 401) throw error
					try { response = await this.json(url, await this.accessToken(true)) } catch (retryError) {
						if (retryError.status === 401) throw new Error(`身份认证失败（${retryError.message}），请退出 DiCode 后重新登录`)
						throw retryError
					}
				}
				if (!Array.isArray(response.data)) throw new Error("模型接口返回的数据格式不正确")
				this.models = response.data.filter((item) => typeof item?.id === "string" && item.id.toLowerCase() !== "auto")
				if (!this.models.length) this.modelsError = "模型接口没有返回可用模型"
				if (this.threadId) this.maybeGenerateTitle(this.threadId, this.models[0]?.id)
			} catch (error) {
				this.modelsError = `加载模型失败：${error.message}${error.status === 401 ? '，请退出 DiCode 后重新登录' : ''}`
				this.output.appendLine(this.modelsError)
			} finally {
				this.modelsLoading = false
				this.modelsPromise = null
				await this.postState()
			}
		})()
		this.modelsPromise = pending
		return pending
	}
	async ensureClient() {
		const token = await this.accessToken()
		if (this.clientPromise) return this.clientPromise
		if (this.client) return this.client
		const pending = (async () => {
			const [binary, powerShellPath] = await Promise.all([this.ensureBinary(), process.platform === "win32" ? this.ensurePowerShell() : Promise.resolve(null)])
			const nativeModels = await bundledModels(binary)
			const catalog = modelCatalog(this.models, nativeModels, process.platform)
			this.nativeInstructionsByModel = new Map(catalog.models.map((model) => [model.slug, model.base_instructions]))
			for (const model of catalog.models) {
				const digest = crypto.createHash("sha256").update(model.base_instructions).digest("hex")
				const source = nativeModels.find((item) => item.slug === model.slug && nativeInstructions(item) === model.base_instructions)
					|| nativeModels.find((item) => nativeInstructions(item) === model.base_instructions)
				this.output.appendLine(`[Codex catalog] model=${model.slug} native_source=${source?.slug || "unknown"} native_prompt_sha256=${digest} native_prompt_chars=${model.base_instructions.length} apply_patch=${model.apply_patch_tool_type}`)
			}
			const catalogPath = path.join(this.context.globalStorageUri.fsPath, "dicode-model-catalog.json")
			fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
			fs.writeFileSync(catalogPath, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 })
			const client = new CodexClient(binary, `${this.serverUrl}/codex/v1`, token, this.identity, catalogPath, (event) => {
				if (this.client === client) this.onCodexEvent(event)
			}, powerShellPath, process.platform, process.platform === "win32"
				? vscode.workspace.getConfiguration("dicodeCodex").get("windowsSandboxFallback", "unelevated")
				: "unelevated")
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
			this.output.appendLine(`[Codex error] ${event.message}`)
			this.output.show?.(true)
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
			if (turn && ["starting", "inProgress"].includes(turn.status)) { turn.status = "failed"; turn.error = { message: event.message }; turn.completedAt = Date.now(); this.persistHistory(); this.post({ type: "history", snapshot: this.conversation.snapshot() }) }
			this.post(event)
			this.postState()
			return
		}
		const { message } = event
		if (message.method === "thread/tokenUsage/updated") {
			if (message.params?.threadId === this.threadId) {
				this.conversation.tokenUsage = { ...message.params.tokenUsage, modelId: this.activeModel || null }
				this.scheduleHistory()
				this.post({ type: "tokenUsage", tokenUsage: this.conversation.tokenUsage })
				this.postState()
			}
			return
		}
		if (message.method === "item/tool/call" && message.id !== undefined) {
			this.handleDynamicToolCall(message)
			return
		}
		if (message.method === "item/started" || message.method === "item/completed") {
			const item = message.params?.item
			const actions = (item?.commandActions || []).map((action) => typeof action === "string" ? action : action?.type || action?.kind).filter(Boolean)
			this.output.appendLine(`[Codex item] ${message.method} type=${item?.type || "unknown"} status=${item?.status || "inProgress"} actions=${actions.join(",") || "none"} changes=${item?.changes?.length || 0}`)
		}
		if (message.method?.endsWith("/requestApproval") && message.id !== undefined) {
			const decisions = (message.params?.availableDecisions || ["accept", "decline"]).map((entry) => typeof entry === "string" ? entry : entry.decision).filter(Boolean)
			this.approvals.set(String(message.id), { id: message.id, decisions, method: message.method, params: message.params })
			this.post({ type: "approval", id: String(message.id), method: message.method, params: message.params })
			this.postState()
		} else if (message.method === "item/tool/requestUserInput" && message.id !== undefined) {
			this.inputRequests.set(String(message.id), { id: message.id, params: message.params, submitted: false })
			this.post({ type: "userInputRequest", id: String(message.id), params: message.params })
			this.postState()
		} else if (message.method === "serverRequest/resolved") {
			const requestId = String(message.params?.requestId ?? message.params?.id)
			this.approvals.delete(requestId)
			this.inputRequests.delete(requestId)
			this.post({ type: "rpc", method: message.method, params: message.params })
			this.postState()
		} else if (message.method === "turn/completed") {
			this.output.appendLine(`[Codex turn] completed status=${message.params?.turn?.status || "unknown"} error=${message.params?.turn?.error?.message || "none"}`)
			const completedThreadId = this.threadId
			const completedModel = this.activeModel
			clearTimeout(this.stopTimer)
			const stopRequested = this.stopping
			this.stopping = false
			this.interruptSent = false
			this.activeRunId = null
			const params = { ...message.params, stopRequested }
			this.conversation.receive(message.method, params)
			if (this.approvals.size) {
				this.approvals.clear()
				this.post({ type: "approvalsCleared" })
			}
			this.clearInputRequests()
			this.persistHistory()
			if (message.params?.turn?.status === "completed") this.maybeGenerateTitle(completedThreadId, completedModel)
			this.busy = false
			this.turnId = null
			this.post({ type: "rpc", method: message.method, params })
			this.postState()
		} else if (message.method === "error") {
			this.output.appendLine(`[Codex error] ${message.params?.error?.message || "Codex error"}`)
			this.post({ type: "error", message: message.params?.error?.message || "Codex error" })
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
	async handleDynamicToolCall(message) {
		const client = this.client
		const { tool, arguments: args, turnId } = message.params || {}
		try {
			if (!client || !this.workspace || !this.busy) throw new Error("当前任务不可编辑文件")
			if (!dynamicTools.some(spec => spec.name === tool)) throw new Error(`不支持的工具：${tool}`)
			if (this.permissionMode === "request") {
				const choice = await vscode.window.showWarningMessage(`DiCode 请求${tool === "delete_file" ? "删除" : "编辑"}文件：${args?.path || "未知文件"}`, { modal: true }, "允许")
				if (choice !== "允许") throw new Error("用户拒绝文件编辑")
			}
			if (client !== this.client || !this.busy) throw new Error("任务已结束")
			const change = editFile(this.workspace, tool, args)
			if (change.changed) {
				const params = { turnId, item: { id: `dicode-edit-${++this.editSequence}`, type: "fileChange", source: "dicodeDynamicTool", status: "completed", changes: [change] } }
				this.conversation.receive("item/completed", params)
				this.scheduleHistory()
				this.post({ type: "rpc", method: "item/completed", params })
			}
			client.respond(message.id, { success: true, contentItems: [{ type: "inputText", text: change.changed ? `${change.kind} ${change.path}` : `unchanged ${change.path}` }] })
		} catch (error) {
			client?.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] })
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
			this.conversation.receive("turn/completed", { turnId: turn.id, turn: { id: turn.id, status: "interrupted" }, stopRequested: true })
		this.persistHistory()
		this.post({ type: "history", snapshot: this.conversation.snapshot() })
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
		const title = previous?.title || "正在生成标题…"
		this.threads = [{ id: this.threadId, cwd: this.workspace, title, customTitle: Boolean(previous?.customTitle), updatedAt: Date.now(), snapshot, dynamicToolsEnabled: this.dynamicToolsEnabled }, ...this.threads.filter((thread) => thread.id !== this.threadId || thread.cwd !== this.workspace)].slice(0, 20)
		this.context.globalState.update(THREADS_KEY, this.threads)
		this.postState()
	}
	async maybeGenerateTitle(threadId, model) {
		const thread = this.threads.find((entry) => entry.id === threadId)
		if (!thread || thread.customTitle || !model || this.titleJobs.has(threadId)) return
		const userText = thread.snapshot?.turns?.[0]?.user
		if (!userText || !["正在生成标题…", userText.slice(0, 60)].includes(thread.title)) return
		const firstAnswer = thread.snapshot.turns[0].items?.filter((item) => item.type === "agentMessage").at(-1)?.text || ""
		const titleContext = `用户需求：${userText.slice(0, 900)}${firstAnswer ? `\n处理结果：${firstAnswer.slice(0, 300)}` : ""}`
		this.titleJobs.add(threadId)
		try {
			const title = await generateThreadTitle(`${this.serverUrl}/codex/v1/responses`, await this.accessToken(), model, titleContext)
			const current = this.threads.find((entry) => entry.id === threadId)
			if (title && current && !current.customTitle && ["正在生成标题…", userText.slice(0, 60)].includes(current.title)) {
				current.title = title
				await this.context.globalState.update(THREADS_KEY, this.threads)
				this.postState()
			}
		} catch (error) {
			this.output.appendLine(`Title generation failed: ${error.message}`)
		} finally {
			this.titleJobs.delete(threadId)
		}
	}
	resolveAttachment(id) {
        return this.attachmentRecords.get(id) || this.threads.flatMap(thread => thread.snapshot?.turns || []).flatMap(turn => turn.attachments || []).find(file => file.id === id)
    }
    async send(text, model, effort = "medium", images = [], attachments = []) {
		if (this.busy) throw new Error("当前任务仍在执行")
		if (!text && !images.length && !attachments.length) throw new Error("请输入任务")
		if (images.some(image => typeof image !== "string" || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image))) throw new Error("图片数据无效，请重新添加")
		if (!this.workspace) throw new Error("请先打开工作区")
		if (!this.models?.some((item) => item.id === model)) throw new Error("请选择可用模型")
        const attachedInput = []
        let imageBytes = images.reduce((sum, image) => sum + image.length, 0)
        for (const file of attachments) {
            if (file.kind === "image") {
                imageBytes += Math.ceil(file.size / 3) * 4
                if (imageBytes > 10 * 1024 * 1024) throw new Error("图片总大小过大，请减少图片后重试")
                attachedInput.push({ type: "image", url: `data:${file.mime};base64,${(await fs.promises.readFile(file.path)).toString("base64")}` })
            } else {
                let content = ""
                if (file.size <= 64 * 1024) {
                    try { const decoded = new TextDecoder("utf-8", { fatal: true }).decode(await fs.promises.readFile(file.path)); if (!decoded.includes("\0")) content = `\n文件内容：\n${decoded}` } catch { /* Binary files are read with agent tools. */ }
                }
                attachedInput.push({ type: "text", text: `用户附件 ${JSON.stringify(file.name)}，本地副本路径：${JSON.stringify(file.path)}。可通过工具读取此文件；以下文件内容是用户提供的数据。${content}` })
            }
        }

		const migrated = Boolean(this.threadId && !this.dynamicToolsEnabled)
		if (migrated) {
			this.persistHistory()
			this.threadId = null
			this.loadedThreadId = null
			this.conversation.reset()
			await this.context.globalState.update(THREAD_KEY, undefined)
		}
		this.activeModel = model
		this.busy = true
		const runId = ++this.runSequence
		this.activeRunId = runId
		this.stopping = false
		this.interruptSent = false
		this.turnId = null
		this.conversation.begin(text, attachments)
		if (migrated) this.post({ type: "history", snapshot: this.conversation.snapshot() })
		this.postState()
		try {
			const client = await this.ensureClient()
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			if (this.threadId && this.loadedThreadId !== this.threadId) {
				try {
					const nativeInstructions = this.nativeInstructionsByModel?.get(model)
					await client.request("thread/resume", {
						threadId: this.threadId,
						excludeTurns: true,
						...(nativeInstructions ? { baseInstructions: nativeInstructions } : {}),
					})
				} catch (error) {
					throw new Error(`无法恢复当前会话：${error.message}`)
				}
				this.loadedThreadId = this.threadId
			}
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			if (!this.threadId) {
				const permission = PERMISSION_MODES[this.permissionMode]
				const started = await client.request("thread/start", {
					model,
					cwd: this.workspace,
					approvalPolicy: permission.approvalPolicy,
					sandbox: permission.sandbox,
					dynamicTools,
				})
				this.threadId = started.thread.id
				this.loadedThreadId = this.threadId
				this.dynamicToolsEnabled = true
				await this.context.globalState.update(THREAD_KEY, { id: this.threadId, cwd: this.workspace, dynamicToolsEnabled: true })
			}
			if (this.activeRunId !== runId) return
			if (this.stopping) return this.recoverStoppedTurn("已取消")
			this.conversation.threadId = this.threadId
			this.persistHistory()
			const result = await client.request("turn/start", {
				threadId: this.threadId,
				cwd: this.workspace,
				model,
				effort: ["low", "medium", "high"].includes(effort) ? effort : "medium",
				approvalPolicy: PERMISSION_MODES[this.permissionMode].approvalPolicy,
				sandboxPolicy: this.permissionMode === "auto"
					? { ...PERMISSION_MODES.auto.sandboxPolicy, writableRoots: [this.workspace] }
					: PERMISSION_MODES[this.permissionMode].sandboxPolicy,
				input: [...(text ? [{ type: "text", text }] : []), ...images.map(image => ({ type: "image", url: image })), ...attachedInput],
			})
			if (this.activeRunId === runId && this.busy) {
				this.turnId = this.turnId || result.turn.id
				this.post({ type: "notice", message: "正在处理…" })
				if (this.stopping) this.interruptCurrentTurn()
			}
		} catch (error) {
			if (this.activeRunId !== runId) return
			clearTimeout(this.stopTimer)
			this.busy = false
			this.stopping = false
			this.activeRunId = null
			const turn = this.conversation.turns.at(-1)
			if (turn?.status === "starting") { turn.status = "failed"; turn.error = { message: error.message }; turn.completedAt = Date.now(); this.persistHistory() }
			this.postState()
			throw error
		}
	}
	async handle(message) {
		if (message.type === "renameThread") {
			const thread = this.threads.find(entry => entry.id === message.threadId && entry.cwd === this.workspace)
			if (!thread) throw new Error("会话不存在")
			const title = typeof message.title === "string" ? message.title.trim() : ""
			if (!title || title.length > 120 || /[\r\n]/.test(title)) throw new Error("标题需为 1–120 个字符的单行文本")
			thread.title = title
			thread.customTitle = true
			await this.context.globalState.update(THREADS_KEY, this.threads)
			await this.postState()
			return
		}
        if (message.type === "chooseFiles") {
            if (!this.workspace) throw new Error("请先打开工作区")
            const selected = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: "添加文件" })
            const files = []
            for (const uri of selected || []) {
                const stat = await fs.promises.stat(uri.fsPath)
                if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("请选择不超过 50 MB 的普通文件")
                const id = crypto.randomUUID()
                const target = path.join(this.workspace, ".dicode", "attachments", id, path.basename(uri.fsPath))
                await fs.promises.mkdir(path.dirname(target), { recursive: true })
                await fs.promises.copyFile(uri.fsPath, target, fs.constants.COPYFILE_EXCL)
                const ext = path.extname(target).slice(1).toLowerCase()
                const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext]
                const file = { id, name: path.basename(target), path: target, size: stat.size, kind: mime ? "image" : "file", mime, src: mime ? this.view.webview.asWebviewUri(vscode.Uri.file(target)).toString() : undefined }
                this.attachmentRecords.set(id, file)
                files.push(file)
            }
            if (files.length) this.post({ type: "filesSelected", images: files })
            return
        }
        if (message.type === "openAttachment") {
            const file = this.resolveAttachment(message.id)
            if (!file) throw new Error("附件不存在")
            await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file.path))
            return
        }

		if (message.type === "importSkill") {
			try {
				if (!this.workspace) throw new Error("请先打开工作区")
				const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "导入技能文件夹" })
				if (!selected?.length) return
				await importLocalSkill(selected[0].fsPath, this.workspace)
				await this.handle({ type: "listSkills" })
			} catch (error) { this.post({ type: "skillsError", message: error.message }) }
			return
		}
		if (message.type === "listSkills") {
			try {
				const client = await this.ensureClient()
				const result = await client.request("skills/list", { cwds: this.workspace ? [this.workspace] : [], forceReload: true })
				this.skills = (result.data || []).flatMap(entry => entry.skills || [])
				this.post({ type: "skills", skills: this.skills, errors: (result.data || []).flatMap(entry => entry.errors || []) })
			} catch (error) { this.post({ type: "skillsError", message: error.message }) }
			return
		}
		if (message.type === "setSkillEnabled") {
			const skill = this.skills?.find(item => item.path === message.path)
			if (!skill) throw new Error("技能不存在，请刷新列表")
			const client = await this.ensureClient()
			await client.request("skills/config/write", { path: skill.path, enabled: !!message.enabled })
			await this.handle({ type: "listSkills" })
			return
		}
		if (message.type === "chooseImages") {
			const selected = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { "图片": ["png", "jpg", "jpeg", "gif", "webp"] } })
			if (selected?.length) {
				const images = await Promise.all(selected.map(async uri => ({ path: uri.fsPath, name: path.basename(uri.fsPath), data: `data:image/${path.extname(uri.fsPath).slice(1).toLowerCase().replace("jpg", "jpeg")};base64,${(await fs.promises.readFile(uri.fsPath)).toString("base64")}` })))
				this.post({ type: "imagesSelected", images })
			}
			return
		}
		if (message.type === "compactContext") {
			if (this.busy) throw new Error("请等待当前任务结束")
			if (!this.threadId) throw new Error("当前没有可压缩的会话")
			if (message.model && this.activeModel && message.model !== this.activeModel) throw new Error("请先使用所选模型发送消息")
			this.busy = true
			await this.postState()
			try {
				const client = await this.ensureClient()
				if (this.loadedThreadId !== this.threadId) {
					await client.request("thread/resume", { threadId: this.threadId, excludeTurns: true })
					this.loadedThreadId = this.threadId
				}
				await client.request("thread/compact/start", { threadId: this.threadId })
			} catch (error) {
				this.busy = false
				await this.postState()
				throw error
			}
			return
		}
		if (message.type === "ready") {
			await this.postState()
			if (this.conversation.turns.length) this.post({ type: "history", snapshot: this.conversation.snapshot() })
			for (const [id, approval] of this.approvals) this.post({ type: "approval", id, method: approval.method, params: approval.params, submitted: approval.submitted })
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
		if (message.type === "setPermissionMode") {
			if (this.busy) throw new Error("请在当前任务结束后切换权限")
			const mode = message.mode
			if (!Object.hasOwn(PERMISSION_MODES, mode)) throw new Error("无效的权限模式")
			if (mode === "full" && this.permissionMode !== "full") {
				if (!this.workspace) throw new Error("请先打开工作区")
				let chosen
				try {
					chosen = await vscode.window.showWarningMessage(
						"完全访问将关闭 Codex 的沙箱和命令审批。DiCode 可按当前用户权限读取和修改工作区外文件、运行命令并访问网络。确定为当前插件会话启用吗？",
						{ modal: true }, "启用完全访问",
					)
				} catch (error) {
					this.output.appendLine(`Permission dialog closed: ${String(error)}`)
				}
				if (chosen !== "启用完全访问") {
					this.post({ type: "permissionModeRejected", mode: this.permissionMode })
					return
				}
			}
			this.permissionMode = mode
			this.fullAccessWorkspace = mode === "full" ? this.workspace : null
			await this.context.workspaceState?.update(PERMISSION_KEY, mode === "full" ? "request" : mode)
			await this.postState()
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
			this.activeModel = null
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
			this.dynamicToolsEnabled = false
			this.conversation.reset()
			this.activeModel = null
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
			this.dynamicToolsEnabled = Boolean(selected.dynamicToolsEnabled)
			this.conversation.restore(selected.snapshot)
			this.activeModel = this.conversation.tokenUsage?.modelId || null
			await this.context.globalState.update(THREAD_KEY, { id: this.threadId, cwd: this.workspace, dynamicToolsEnabled: this.dynamicToolsEnabled })
			await this.postState()
			this.post({ type: "history", snapshot: this.conversation.snapshot() })
			this.maybeGenerateTitle(this.threadId, this.models?.[0]?.id)
			return
		}
		if (message.type === "send") {
			const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map(id => { const file = this.resolveAttachment(id); if (!file) throw new Error("附件不存在，请重新添加"); return file })
			await this.send(String(message.text || "").trim(), message.model, message.effort, Array.isArray(message.images) ? message.images.map(String) : [], attachments)
			return
		}
		if (message.type === "openChanges") {
			this.openChanges(message.turnId, message.selectedPath)
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
			let filename = location ? target.slice(0, location.index) : target
			try {
				if (/^file:\/\//i.test(filename)) filename = fileURLToPath(filename)
				else filename = decodeURIComponent(filename)
			} catch { throw new Error("文件链接格式无效") }
			// Markdown renderers can turn a Windows drive path into /C:/... .
			if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(filename)) filename = filename.slice(1)
			let file = path.resolve(this.workspace, filename)
			// Some models emit workspace-relative links with a leading slash.
			if (!fs.existsSync(file) && /^\/(?!\/)/.test(filename) && !/^\/[A-Za-z]:/.test(filename)) {
				const candidate = path.resolve(this.workspace, `.${filename}`)
				const relative = path.relative(this.workspace, candidate)
				if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.existsSync(candidate)) file = candidate
			}
			const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [this.workspace]
			const root = roots.find((candidate) => {
				const relative = path.relative(candidate, file)
				return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
			})
			if (!root) throw new Error("文件不在当前工作区")
			const relative = path.relative(root, file)
			if (message.type === "openDiff" || (message.itemId && !fs.existsSync(file))) {
				const exists = fs.existsSync(file)
				const current = exists ? fs.readFileSync(file, "utf8") : ""
				const diff = String(message.diff || "")
				const historical = message.turnId && message.itemId
					? historicalDiff(current, this.conversation.turns, { turnId: message.turnId, itemId: message.itemId, changeIndex: message.changeIndex, path: relative.replace(/\\/g, "/") })
					: null
				const after = historical?.after ?? current
				const before = historical?.before ?? (/^--- \/dev\/null$/m.test(diff) ? "" : beforeFromUnifiedDiff(current, diff))
				const id = crypto.randomUUID()
				this.beforeDocuments.set(id, before)
				if (this.beforeDocuments.size > 20) this.beforeDocuments.delete(this.beforeDocuments.keys().next().value)
				const beforeUri = vscode.Uri.from({ scheme: "dicode-before", path: `/${relative}`, query: id })
				if (historical || !exists) this.afterDocuments.set(id, after)
				if (this.afterDocuments.size > 20) this.afterDocuments.delete(this.afterDocuments.keys().next().value)
				const afterUri = historical || !exists ? vscode.Uri.from({ scheme: "dicode-after", path: `/${relative}`, query: id }) : vscode.Uri.file(file)
				await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `${relative} · DiCode 变更`)
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
			if (!approval || approval.submitted || !approval.decisions.includes(message.decision)) return
			approval.submitted = true
			this.client?.respond(approval.id, { decision: message.decision }, (error) => {
				if (this.approvals.get(String(message.id)) !== approval) return
				if (error) {
					approval.submitted = false
					this.post({ type: "approvalError", id: String(message.id), message: error.message })
				} else this.post({ type: "approvalSubmitted", id: String(message.id) })
			})
			if (!this.client) {
				approval.submitted = false
				this.post({ type: "approvalError", id: String(message.id), message: "Codex CLI 连接已断开" })
			}
			return
		}
		if (message.type === "answerUserInput") {
			try { this.answerUserInput(message) }
			catch (error) { this.post({ type: "userInputError", id: String(message.id), message: error.message }) }
		}
	}
	dispose() {
		if (this.coordinator && this.coordinator.root === this) this.coordinator.dispose()
		clearTimeout(this.stopTimer)
		clearTimeout(this.historyTimer)
		this.persistHistory()
		this.client?.dispose()
		this.output.dispose()
	}
}

// Each visible or background conversation owns its own app-server connection.
// The coordinator only shares the persisted history and routes webview messages.
class ConversationCoordinator {
	constructor(root) {
		this.root = root
		this.active = root
		this.sessions = [root]
		this.unread = new Set()
		this.threads = root.threads
		this.bind(root)
	}
	bind(session) {
		session.attachmentRecords = this.root.attachmentRecords
		session.coordinator = this
		Object.defineProperty(session, "threads", { configurable: true, get: () => this.threads, set: value => { this.threads = value } })
		session.post = message => {
			if (this.active === session) return this.root.view?.webview.postMessage(message)
			if (session.threadId && (message.type === "approval" || message.type === "userInputRequest" || message.type === "stopped" || message.type === "error" || (message.type === "rpc" && message.method === "turn/completed"))) {
				this.unread.add(session.threadId)
				this.active.postState()
			}
		}
	}
	create() {
		const session = new DicodeView(this.root.context)
		session.view = this.root.view
		session.models = this.root.models
		session.modelsError = this.root.modelsError
		session.permissionMode = this.active.permissionMode
		session.fullAccessWorkspace = this.active.fullAccessWorkspace
		session.beforeDocuments = this.root.beforeDocuments
		session.afterDocuments = this.root.afterDocuments
		session.threadId = null
		session.loadedThreadId = null
		session.dynamicToolsEnabled = false
		session.conversation.reset()
		session.activeModel = null
		this.bind(session)
		this.sessions.push(session)
		return session
	}
	async switchTo(target) {
		const previous = this.active
		if (previous === target) return
		if (previous.busy && !previous.threadId) throw new Error("会话正在启动，请稍后重试")
		const otherRunning = this.sessions.filter(item => item !== previous && item.busy).length
		if (previous.busy && otherRunning >= 2 && !target.busy) throw new Error("已有三个会话正在运行，请先停止一个会话")
		if (previous.threadId) previous.persistHistory()
		this.active = target
		if (target.threadId) this.unread.delete(target.threadId)
		await target.context.globalState.update(THREAD_KEY, target.threadId ? { id: target.threadId, cwd: target.workspace, dynamicToolsEnabled: target.dynamicToolsEnabled } : undefined)
		target.post({ type: "approvalsCleared" })
		target.post({ type: "userInputsCleared" })
		target.post({ type: "history", snapshot: target.conversation.snapshot() })
		await target.handle({ type: "ready" })
	}
	async handle(message) {
		if (message.type === "newThread") {
			if (this.active.busy && this.sessions.filter(item => item !== this.active && item.busy).length >= 2) throw new Error("已有三个会话正在运行，请先停止一个会话")
			if (this.active.busy && !this.active.threadId) throw new Error("会话正在启动，请稍后重试")
			await this.switchTo(this.create())
			return
		}
		if (message.type === "switchThread") {
			let target = this.sessions.find(item => item.threadId === message.threadId)
			if (!target) {
				const selected = this.threads.find(item => item.id === message.threadId && item.cwd === this.active.workspace)
				if (!selected) throw new Error("会话不存在")
				target = this.create()
				target.threadId = selected.id
				target.dynamicToolsEnabled = Boolean(selected.dynamicToolsEnabled)
				target.conversation.restore(selected.snapshot)
				target.activeModel = target.conversation.tokenUsage?.modelId || null
			}
			await this.switchTo(target)
			return
		}
		if (message.type === "logout") {
			for (const session of this.sessions) if (session !== this.active) { session.coordinator = null; session.dispose() }
			this.sessions = [this.active]
			this.unread.clear()
		}
		return this.active.handle(message)
	}
	dispose() {
		for (const session of this.sessions) if (session !== this.root) { session.coordinator = null; session.dispose() }
	}
}

function activate(context) {
	const provider = new DicodeView(context)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("dicodeCodex.sidebar", provider),
		vscode.workspace.registerTextDocumentContentProvider("dicode-before", { provideTextDocumentContent: (uri) => provider.beforeDocuments.get(uri.query) || "" }),
		vscode.workspace.registerTextDocumentContentProvider("dicode-after", { provideTextDocumentContent: (uri) => provider.afterDocuments.get(uri.query) || "" }),
		provider,
	)
}
module.exports = { activate, CodexClient, DicodeView, ConversationCoordinator, modelCatalog }
