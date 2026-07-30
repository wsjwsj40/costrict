const state = {
	token: sessionStorage.getItem("adminToken") || "",
	data: null,
	selectedEmails: new Set(),
}
const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

async function api(path, options = {}) {
	const response = await fetch(`/admin/api${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${state.token}`,
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...(options.headers || {}),
		},
	})
	if (!response.ok) {
		const body = await response.json().catch(() => ({}))
		throw new Error(body.message || `请求失败 (${response.status})`)
	}
	return response.status === 204 ? null : response.json()
}

async function load() {
	state.data = await api("/state")
	render()
}

function render() {
	const { models, plans, users } = state.data
	$("#metric-models").textContent = models.filter((m) => m.enabled).length
	$("#metric-plans").textContent = plans.length
	$("#metric-users").textContent = users.length

	const max = Math.max(...plans.map((p) => p.modelIds.length), 1)
	$("#coverage").innerHTML = plans
		.map(
			(p) => `
    <div class="coverage-row"><strong>${escapeHTML(p.name)}</strong>
      <div class="bar"><i style="width:${Math.round((p.modelIds.length / max) * 100)}%"></i></div>
      <span>${p.modelIds.length} 个模型</span>
    </div>`,
		)
		.join("")

	$("#models-table").innerHTML =
		`<table><thead><tr><th>模型</th><th>上下文</th><th>最大输出</th><th>状态</th><th></th></tr></thead><tbody>${models
			.map(
				(m) => `<tr>
      <td><strong>${escapeHTML(m.publicInfo.name || m.id)}</strong><br><small>${escapeHTML(m.id)}</small></td>
      <td>${number(m.publicInfo.contextWindow)}</td><td>${number(m.publicInfo.maxTokens)}</td>
      <td><span class="badge ${m.enabled ? "" : "off"}">${m.enabled ? "已启用" : "已停用"}</span></td>
      <td><div class="row-actions"><button data-edit-model="${attr(m.id)}">编辑</button><button class="danger" data-delete-model="${attr(m.id)}">删除</button></div></td>
    </tr>`,
			)
			.join("")}</tbody></table>`

	$("#plan-cards").innerHTML = plans
		.map(
			(p) => `<article class="plan-card ${p.code === "pro" ? "pro" : ""}">
    <div class="plan-name">${escapeHTML(p.name)}</div>
    <div class="plan-meta">${p.isDefault ? "默认套餐 · " : ""}${p.modelIds.length} 个可见模型</div>
    <div class="model-checks">${models.map((m) => `<label><input type="checkbox" data-plan="${attr(p.code)}" value="${attr(m.id)}" ${p.modelIds.includes(m.id) ? "checked" : ""} ${!m.enabled ? "disabled" : ""}> ${escapeHTML(m.publicInfo.name || m.id)}</label>`).join("") || "<span class='muted'>请先添加模型</span>"}</div>
    <button class="primary" data-save-plan="${attr(p.code)}">保存 ${escapeHTML(p.name)} 权限</button>
  </article>`,
		)
		.join("")

	renderUsers()
	$("#user-form select").innerHTML = plans
		.map((p) => `<option value="${attr(p.code)}">${escapeHTML(p.name)}</option>`)
		.join("")
	$("#bulk-plan").innerHTML = plans
		.map((p) => `<option value="${attr(p.code)}">${escapeHTML(p.name)}</option>`)
		.join("")
	$("#batch-user-form select").innerHTML = plans
		.filter((p) => !p.isDefault)
		.map((p) => `<option value="${attr(p.code)}">${escapeHTML(p.name)}</option>`)
		.join("")
}

function renderUsers() {
	const query = $("#user-search").value.trim().toLowerCase()
	const users = state.data.users.filter((u) => u.email.includes(query))
	const visibleEmails = users.map((u) => u.email)
	const allVisibleSelected =
		visibleEmails.length > 0 && visibleEmails.every((email) => state.selectedEmails.has(email))
	$("#users-table").innerHTML =
		`<table><thead><tr><th class="table-check"><input id="select-all-users" type="checkbox" aria-label="选择当前列表全部用户" ${allVisibleSelected ? "checked" : ""}></th><th>邮箱</th><th>套餐</th><th></th></tr></thead><tbody>${users
			.map(
				(
					u,
				) => `<tr><td class="table-check"><input type="checkbox" data-select-user="${attr(u.email)}" aria-label="选择 ${attr(u.email)}" ${state.selectedEmails.has(u.email) ? "checked" : ""}></td><td><strong>${escapeHTML(u.email)}</strong></td><td><span class="badge">${escapeHTML(u.planCode)}</span></td>
    <td><div class="row-actions"><button data-edit-user="${attr(u.email)}">修改</button><button class="danger" data-delete-user="${attr(u.email)}">移除</button></div></td></tr>`,
			)
			.join("")}</tbody></table>`
	updateBulkControls()
}

function updateBulkControls() {
	const count = state.selectedEmails.size
	$("#selection-count").textContent = count ? `已选择 ${count} 个用户` : "未选择用户"
	$("#bulk-set-plan").disabled = count === 0
	$("#bulk-delete-users").disabled = count === 0
}

function showApp() {
	$("#login").classList.add("hidden")
	$("#app").classList.remove("hidden")
}

function toast(message) {
	const el = $("#toast")
	el.textContent = message
	el.classList.add("show")
	setTimeout(() => el.classList.remove("show"), 2200)
}

function openModel(model = null) {
	const form = $("#model-form")
	form.reset()
	form.elements.id.readOnly = Boolean(model)
	if (model) {
		form.elements.id.value = model.id
		form.elements.name.value = model.publicInfo.name || ""
		form.elements.contextWindow.value = model.publicInfo.contextWindow || 0
		form.elements.maxTokens.value = model.publicInfo.maxTokens || 0
		form.elements.description.value = model.publicInfo.description || ""
		form.elements.sortOrder.value = model.sortOrder
		form.elements.enabled.checked = model.enabled
	}
	$("#model-dialog").showModal()
}

function openUser(user = null) {
	const form = $("#user-form")
	form.reset()
	form.elements.email.readOnly = Boolean(user)
	if (user) {
		form.elements.email.value = user.email
		form.elements.planCode.value = user.planCode
	}
	$("#user-dialog").showModal()
}

function openBatchUsers() {
	const form = $("#batch-user-form")
	form.reset()
	$("#batch-email-count").textContent = "已识别 0 个邮箱"
	$("#batch-user-dialog").showModal()
}

function parseEmails(value) {
	const matches = String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
	return [...new Set(matches.map((email) => email.toLowerCase()))]
}

async function batchUsers(action, emails, planCode = "") {
	return api("/users/batch", {
		method: "POST",
		body: JSON.stringify({ action, emails, ...(planCode ? { planCode } : {}) }),
	})
}

$("#login-form").addEventListener("submit", async (e) => {
	e.preventDefault()
	state.token = $("#admin-token").value
	try {
		await load()
		sessionStorage.setItem("adminToken", state.token)
		showApp()
	} catch (error) {
		$("#login-error").textContent = error.message
	}
})

$("#logout").addEventListener("click", () => {
	sessionStorage.removeItem("adminToken")
	state.token = ""
	location.reload()
})
$("#refresh").addEventListener("click", async () => {
	await load()
	toast("数据已刷新")
})
$("#add-model").addEventListener("click", () => openModel())
$("#add-user").addEventListener("click", () => openUser())
$("#batch-add-users").addEventListener("click", openBatchUsers)
$("#user-search").addEventListener("input", renderUsers)
$$(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()))

$("#batch-user-form textarea").addEventListener("input", (e) => {
	$("#batch-email-count").textContent = `已识别 ${parseEmails(e.currentTarget.value).length} 个邮箱`
})

$("#batch-user-csv").addEventListener("change", async (e) => {
	const file = e.currentTarget.files[0]
	if (!file) return
	const textarea = $("#batch-user-form textarea")
	const emails = parseEmails(`${textarea.value}\n${await file.text()}`)
	textarea.value = emails.join("\n")
	$("#batch-email-count").textContent = `已识别 ${emails.length} 个邮箱`
})

$("#bulk-set-plan").addEventListener("click", async () => {
	const emails = [...state.selectedEmails]
	const planCode = $("#bulk-plan").value
	if (!emails.length || !confirm(`确认将选中的 ${emails.length} 个用户变更为 ${planCode} 套餐？`)) return
	const result = await batchUsers("set", emails, planCode)
	state.selectedEmails.clear()
	await load()
	toast(`已更新 ${result.count} 个用户`)
})

$("#bulk-delete-users").addEventListener("click", async () => {
	const emails = [...state.selectedEmails]
	if (!emails.length || !confirm(`确认删除选中的 ${emails.length} 个用户配置并恢复默认 Free？`)) return
	const result = await batchUsers("delete", emails)
	state.selectedEmails.clear()
	await load()
	toast(`已删除 ${result.count} 个用户配置`)
})

$$(".nav").forEach((button) =>
	button.addEventListener("click", () => {
		$$(".nav").forEach((n) => n.classList.remove("active"))
		button.classList.add("active")
		$$(".view").forEach((v) => v.classList.add("hidden"))
		$(`#${button.dataset.view}-view`).classList.remove("hidden")
		$("#page-title").textContent = {
			overview: "权限概览",
			models: "模型目录",
			plans: "套餐权限",
			users: "用户权限",
		}[button.dataset.view]
	}),
)

$("#model-form").addEventListener("submit", async (e) => {
	e.preventDefault()
	const f = e.currentTarget
	const id = f.elements.id.value.trim()
	await api(`/models/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: JSON.stringify({
			id,
			enabled: f.elements.enabled.checked,
			sortOrder: Number(f.elements.sortOrder.value),
			publicInfo: {
				name: f.elements.name.value.trim(),
				contextWindow: Number(f.elements.contextWindow.value),
				maxTokens: Number(f.elements.maxTokens.value),
				description: f.elements.description.value.trim(),
			},
		}),
	})
	f.closest("dialog").close()
	await load()
	toast("模型已保存")
})

$("#user-form").addEventListener("submit", async (e) => {
	e.preventDefault()
	const f = e.currentTarget
	await api(`/users/${encodeURIComponent(f.elements.email.value.trim())}`, {
		method: "PUT",
		body: JSON.stringify({ planCode: f.elements.planCode.value }),
	})
	f.closest("dialog").close()
	await load()
	toast("用户权限已保存")
})

$("#batch-user-form").addEventListener("submit", async (e) => {
	e.preventDefault()
	const f = e.currentTarget
	const emails = parseEmails(f.elements.emails.value)
	if (!emails.length) {
		toast("没有识别到有效邮箱")
		return
	}
	const result = await batchUsers("set", emails, f.elements.planCode.value)
	f.closest("dialog").close()
	await load()
	toast(`已保存 ${result.count} 个用户权限`)
})

document.addEventListener("change", (e) => {
	if (e.target.id === "select-all-users") {
		$$("[data-select-user]").forEach((input) => {
			input.checked = e.target.checked
			if (e.target.checked) state.selectedEmails.add(input.dataset.selectUser)
			else state.selectedEmails.delete(input.dataset.selectUser)
		})
		updateBulkControls()
	}
	if (e.target.dataset.selectUser) {
		if (e.target.checked) state.selectedEmails.add(e.target.dataset.selectUser)
		else state.selectedEmails.delete(e.target.dataset.selectUser)
		updateBulkControls()
		const visible = $$("[data-select-user]")
		$("#select-all-users").checked = visible.length > 0 && visible.every((input) => input.checked)
	}
})

document.addEventListener("click", async (e) => {
	const button = e.target.closest("button")
	if (!button) return
	if (button.dataset.editModel) openModel(state.data.models.find((m) => m.id === button.dataset.editModel))
	if (button.dataset.editUser) openUser(state.data.users.find((u) => u.email === button.dataset.editUser))
	if (button.dataset.savePlan) {
		const ids = $$(`input[data-plan="${CSS.escape(button.dataset.savePlan)}"]:checked`).map((i) => i.value)
		await api(`/plans/${encodeURIComponent(button.dataset.savePlan)}/models`, {
			method: "PUT",
			body: JSON.stringify({ modelIds: ids }),
		})
		await load()
		toast("套餐权限已保存")
	}
	if (button.dataset.deleteModel && confirm(`确认删除模型 ${button.dataset.deleteModel}？`)) {
		await api(`/models/${encodeURIComponent(button.dataset.deleteModel)}`, { method: "DELETE" })
		await load()
		toast("模型已删除")
	}
	if (button.dataset.deleteUser && confirm(`确认移除 ${button.dataset.deleteUser} 的套餐配置？`)) {
		await api(`/users/${encodeURIComponent(button.dataset.deleteUser)}`, { method: "DELETE" })
		state.selectedEmails.delete(button.dataset.deleteUser)
		await load()
		toast("用户已恢复默认套餐")
	}
})

function escapeHTML(value) {
	const d = document.createElement("div")
	d.textContent = String(value ?? "")
	return d.innerHTML
}
function attr(value) {
	return escapeHTML(value).replaceAll('"', "&quot;")
}
function number(value) {
	return Number(value || 0).toLocaleString()
}

if (state.token)
	load()
		.then(showApp)
		.catch(() => sessionStorage.removeItem("adminToken"))
