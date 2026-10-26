const { spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const repoRoot = path.join(__dirname, "..")
const binDir = path.join(repoRoot, "bin")
const sourcePackagePath = path.join(repoRoot, "src", "package.json")
const sourcePackage = JSON.parse(fs.readFileSync(sourcePackagePath, "utf8"))
const runtimePublicKeyPath = path.join(repoRoot, "branding", "costrict-runtime-public.pem")

const configuredIconPath = process.env.DICODE_ICON_PATH ? path.resolve(process.env.DICODE_ICON_PATH) : undefined
const configuredPngPath =
	configuredIconPath && path.extname(configuredIconPath).toLowerCase() === ".png"
		? configuredIconPath
		: path.join(repoRoot, "branding", "dicode-icon.png")
const configuredSvgPath =
	configuredIconPath && path.extname(configuredIconPath).toLowerCase() === ".svg"
		? configuredIconPath
		: path.join(repoRoot, "branding", "dicode-icon.svg")
const activityIcon = fs.existsSync(configuredSvgPath)
	? "assets/images/dicode-activity-icon.svg"
	: "assets/images/dicode-icon.png"

const brand = {
	name: process.env.DICODE_EXTENSION_NAME || "dicode",
	publisher: process.env.DICODE_PUBLISHER || "atad-apts",
	displayName: process.env.DICODE_DISPLAY_NAME || "DiCode",
	version: process.env.DICODE_VERSION || sourcePackage.version,
	description:
		process.env.DICODE_DESCRIPTION ||
		"Dicode - enterprise AI development assistant with AI Agent, Code Review, and Code Completion.",
	homepage: process.env.DICODE_HOMEPAGE || "https://dicode.byd.com",
	repository: process.env.DICODE_REPOSITORY || "",
}

const stableVsix = path.join(binDir, `${sourcePackage.name}-${sourcePackage.version}.vsix`)
const targetVsix = path.join(binDir, `${brand.name}-${brand.version}.vsix`)
const cloudCommands = new Set([
	"costrict.cloudButtonClicked",
	"costrict.reconnectCsCloud",
	"costrict.restartCsCloudServer",
	"costrict.switchUiMode",
	"costrict.toggleUiMode",
])
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".svg", ".txt", ".xml", ".yaml", ".yml"])

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	})
	if (result.status !== 0) process.exit(result.status ?? 1)
}

const writeJson = (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`)

const replaceVisibleBrand = (text) =>
	text
		.replaceAll("CoStrict", brand.displayName)
		.replaceAll("Costrict", brand.displayName)
		.replaceAll("Roo Code", brand.displayName)
		.replaceAll("https://github.com/atad-apts/costrict", brand.homepage)
		.replaceAll("https://costrict.ai/operation", brand.homepage)

const escapeXml = (text) =>
	text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const isCloudCommand = (command) => typeof command === "string" && cloudCommands.has(command)
const referencesCloudView = (value) => typeof value === "string" && value.includes("AssistantUISidebarProvider")

const replaceExtensionNamespace = (value) =>
	value === "costrict"
		? brand.name
		: value.replaceAll("costrict.", `${brand.name}.`).replaceAll("costrict-", `${brand.name}-`)

const patchContributionIdentifiers = (value, field = "") => {
	if (Array.isArray(value)) return value.map((item) => patchContributionIdentifiers(item, field))
	if (!value || typeof value !== "object") {
		if (
			typeof value === "string" &&
			["command", "enablement", "id", "submenu", "viewType", "when"].includes(field)
		) {
			return replaceExtensionNamespace(value)
		}
		return value
	}

	const patched = {}
	for (const [key, item] of Object.entries(value)) {
		const patchedKey = replaceExtensionNamespace(key)
		patched[patchedKey] = patchContributionIdentifiers(item, key)
	}
	return patched
}

const removeCloudContributions = (packageJson) => {
	const contributes = packageJson.contributes || {}

	if (contributes.views) {
		for (const [container, views] of Object.entries(contributes.views)) {
			contributes.views[container] = views.filter((view) => !referencesCloudView(view.id))
		}
	}

	if (Array.isArray(contributes.commands)) {
		contributes.commands = contributes.commands.filter((item) => !isCloudCommand(item.command))
	}

	if (contributes.menus) {
		for (const [menu, items] of Object.entries(contributes.menus)) {
			contributes.menus[menu] = items.filter(
				(item) => !isCloudCommand(item.command) && !referencesCloudView(item.when),
			)
		}
	}

	if (Array.isArray(contributes.keybindings)) {
		contributes.keybindings = contributes.keybindings.filter((item) => !isCloudCommand(item.command))
	}

	const configurations = Array.isArray(contributes.configuration)
		? contributes.configuration
		: contributes.configuration
			? [contributes.configuration]
			: []
	for (const configuration of configurations) {
		if (!configuration.properties) continue
		for (const key of Object.keys(configuration.properties)) {
			if (
				key === "costrict.uiMode" ||
				key === "costrict.csCloudBaseUrl" ||
				key.startsWith("costrict.assistantUI.")
			) {
				delete configuration.properties[key]
			}
		}
	}

	return packageJson
}

const patchPackageJson = (unpackDir) => {
	const packagePath = path.join(unpackDir, "extension", "package.json")
	const packageJson = removeCloudContributions(JSON.parse(fs.readFileSync(packagePath, "utf8")))
	packageJson.contributes = patchContributionIdentifiers(packageJson.contributes)
	packageJson.activationEvents = patchContributionIdentifiers(packageJson.activationEvents, "id")
	const alwaysVisibleReviewCommands = new Set([
		`${brand.name}.codeReview`,
		`${brand.name}.securityReviewCode`,
		`${brand.name}.reviewFilesAndFolders`,
		`${brand.name}.securityFilesAndFolders`,
	])
	for (const items of Object.values(packageJson.contributes?.menus || {})) {
		for (const item of items) {
			if (alwaysVisibleReviewCommands.has(item.command)) delete item.when
		}
	}
	packageJson.name = brand.name
	packageJson.publisher = brand.publisher
	packageJson.version = brand.version
	packageJson.displayName = brand.displayName
	packageJson.description = brand.description
	packageJson.author = { name: `${brand.displayName} Team` }
	packageJson.icon = "assets/images/dicode-icon.png"
	packageJson.keywords = Array.from(
		new Set(
			(packageJson.keywords || [])
				.filter((keyword) => !/costrict|zgsm|shenma|sangfor/i.test(keyword))
				.concat(["dicode", "ai", "agent", "code review", "code completion"]),
		),
	)

	if (brand.homepage) packageJson.homepage = brand.homepage
	else delete packageJson.homepage
	if (brand.repository) packageJson.repository = { type: "git", url: brand.repository }
	else delete packageJson.repository
	delete packageJson.bugs
	delete packageJson.sponsor

	const replaceIcon = (value) => {
		if (Array.isArray(value)) return value.map(replaceIcon)
		if (!value || typeof value !== "object") return value
		for (const [key, item] of Object.entries(value)) {
			if (key === "icon" && item === "assets/images/shenma_robot_logo_big.png") value[key] = activityIcon
			else value[key] = replaceIcon(item)
		}
		return value
	}
	replaceIcon(packageJson.contributes)
	writeJson(packagePath, packageJson)
}

const patchNlsFiles = (unpackDir) => {
	const extensionDir = path.join(unpackDir, "extension")
	for (const entry of fs.readdirSync(extensionDir)) {
		if (!/^package\.nls(?:\.[^.]+)?\.json$/.test(entry)) continue
		const filePath = path.join(extensionDir, entry)
		const nls = JSON.parse(fs.readFileSync(filePath, "utf8"))
		for (const [key, value] of Object.entries(nls)) {
			if (typeof value === "string") nls[key] = replaceVisibleBrand(value)
		}
		nls["extension.displayName"] = brand.displayName
		nls["extension.displayName.long"] = brand.displayName
		nls["extension.description"] = brand.description
		writeJson(filePath, nls)
	}
}

const patchTextAssets = (dir) => {
	if (!fs.existsSync(dir)) return
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const filePath = path.join(dir, entry.name)
		if (entry.isDirectory()) patchTextAssets(filePath)
		else if (entry.name !== "LICENSE" && textExtensions.has(path.extname(entry.name).toLowerCase())) {
			const original = fs.readFileSync(filePath, "utf8")
			const patched = replaceVisibleBrand(original)
			if (patched !== original) fs.writeFileSync(filePath, patched)
		}
	}
}

const patchIcon = (unpackDir) => {
	const fallbackPath = path.join(unpackDir, "extension", "assets", "images", "shenma_robot_logo_big.png")
	const imagesDir = path.join(unpackDir, "extension", "assets", "images")
	const webviewLogoPath = path.join(unpackDir, "extension", "webview-ui", "build", "logo.svg")

	if (fs.existsSync(configuredPngPath)) {
		fs.copyFileSync(configuredPngPath, path.join(imagesDir, "dicode-icon.png"))
	} else {
		fs.copyFileSync(fallbackPath, path.join(imagesDir, "dicode-icon.png"))
		console.warn(`[Dicode] PNG icon not found at ${configuredPngPath}; using the existing metadata icon.`)
	}

	if (fs.existsSync(configuredSvgPath)) {
		fs.copyFileSync(configuredSvgPath, path.join(imagesDir, "dicode-activity-icon.svg"))
		// The login and account views load /logo.svg from the packaged webview root.
		fs.copyFileSync(configuredSvgPath, webviewLogoPath)
	} else {
		console.warn(`[Dicode] SVG icon not found at ${configuredSvgPath}; the login page keeps the placeholder logo.`)
	}
}

const patchDocumentation = (unpackDir) => {
	const extensionDir = path.join(unpackDir, "extension")
	const packagedFiles = fs.readdirSync(extensionDir)
	const readmeName = packagedFiles.find((name) => name.toLowerCase() === "readme.md") || "README.md"
	const changelogName = packagedFiles.find((name) => name.toLowerCase() === "changelog.md") || "CHANGELOG.md"
	fs.copyFileSync(path.join(repoRoot, "branding", "DICODE_README.md"), path.join(extensionDir, readmeName))
	fs.writeFileSync(
		path.join(extensionDir, changelogName),
		`# Dicode ${brand.version}\n\n- Dicode enterprise distribution.\n`,
	)
}

const patchVsixManifest = (unpackDir) => {
	const manifestPath = path.join(unpackDir, "extension.vsixmanifest")
	let manifest = replaceVisibleBrand(fs.readFileSync(manifestPath, "utf8"))
	manifest = manifest.replace(/<Identity ([^>]*?)Id="[^"]+"/, `<Identity $1Id="${escapeXml(brand.name)}"`)
	manifest = manifest.replace(/(<Identity [^>]*?)Version="[^"]+"/, `$1Version="${escapeXml(brand.version)}"`)
	manifest = manifest.replace(/(<Identity [^>]*?)Publisher="[^"]+"/, `$1Publisher="${escapeXml(brand.publisher)}"`)
	manifest = manifest.replace(
		/<DisplayName>[^<]*<\/DisplayName>/,
		`<DisplayName>${escapeXml(brand.displayName)}</DisplayName>`,
	)
	manifest = manifest.replace(
		/<Description xml:space="preserve">[^<]*<\/Description>/,
		`<Description xml:space="preserve">${escapeXml(brand.description)}</Description>`,
	)
	manifest = manifest.replace(/\s*<Property Id="Microsoft\.VisualStudio\.Services\.Links\.[^"]+"[^>]*\/>/g, "")
	fs.writeFileSync(manifestPath, manifest)
}

const removeCloudAssets = (unpackDir) => {
	fs.rmSync(path.join(unpackDir, "extension", "dist", "assets", "cs-cloud-ui"), {
		recursive: true,
		force: true,
	})
}

const buildStableVsix = () => {
	if (!process.env.DICODE_UPDATE_MANIFEST_URL?.trim()) {
		console.error("DICODE_UPDATE_MANIFEST_URL is required when building a DiCode VSIX.")
		console.error(
			"Example: DICODE_UPDATE_MANIFEST_URL=https://updates.example.internal/api/v1/releases/latest pnpm vsix:dicode",
		)
		process.exit(1)
	}
	const runtimePublicKey =
		process.env.COSTRICT_PUBLIC_KEY ||
		process.env.ZGSM_PUBLIC_KEY ||
		(fs.existsSync(runtimePublicKeyPath) ? fs.readFileSync(runtimePublicKeyPath, "utf8").trim() : "")
	if (!runtimePublicKey) {
		console.error(
			"COSTRICT_PUBLIC_KEY is required; set it in the environment or provide branding/costrict-runtime-public.pem.",
		)
		process.exit(1)
	}
	const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
	const buildEnv = {
		...process.env,
		COSTRICT_PUBLIC_KEY: runtimePublicKey,
		DICODE_CLASSIC_ONLY: "true",
		COSTRICT_PKG_NAME: brand.name,
		COSTRICT_PKG_PUBLISHER: brand.publisher,
		COSTRICT_PKG_COMMAND_ID_PREFIX: brand.name,
		COSTRICT_PKG_OUTPUT_CHANNEL: brand.displayName,
		REVIEW_SKILLS_OFFLINE: "true",
	}
	for (const workspace of ["packages/build", "packages/types", "webview-ui"]) {
		run(pnpm, ["--dir", workspace, "build"], {
			cwd: repoRoot,
			env: buildEnv,
		})
	}
	run(pnpm, ["--dir", "src", "vsix"], {
		cwd: repoRoot,
		env: buildEnv,
	})
}

const main = () => {
	if (process.argv.includes("--build")) buildStableVsix()
	if (!fs.existsSync(stableVsix)) {
		console.error(`Base VSIX not found: ${stableVsix}`)
		console.error("Run pnpm vsix or use pnpm vsix:dicode.")
		process.exit(1)
	}

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dicode-vsix-"))
	try {
		run("unzip", ["-q", stableVsix, "-d", workDir])
		patchPackageJson(workDir)
		patchNlsFiles(workDir)
		patchTextAssets(path.join(workDir, "extension"))
		patchIcon(workDir)
		patchDocumentation(workDir)
		patchVsixManifest(workDir)
		removeCloudAssets(workDir)

		fs.rmSync(targetVsix, { force: true })
		run("zip", ["-qr", targetVsix, "."], { cwd: workDir })
		console.log(`Packaged Dicode VSIX: ${targetVsix}`)
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true })
	}
}

module.exports = {
	brand,
	patchNlsFiles,
	patchPackageJson,
	patchVsixManifest,
	removeCloudAssets,
	removeCloudContributions,
	replaceVisibleBrand,
}

if (require.main === module) main()
