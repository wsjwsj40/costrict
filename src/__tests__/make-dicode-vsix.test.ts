import fs from "fs"
import os from "os"
import path from "path"

const {
	brand,
	patchNlsFiles,
	patchPackageJson,
	patchVsixManifest,
	removeCloudAssets,
	replaceVisibleBrand,
} = require("../../scripts/make-dicode-vsix.js")

describe("make-dicode-vsix", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-dicode-vsix-test-"))
		fs.mkdirSync(path.join(tempDir, "extension", "assets", "images"), { recursive: true })
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("rebrands package metadata and removes Cloud UI contributions", () => {
		const packagePath = path.join(tempDir, "extension", "package.json")
		fs.writeFileSync(
			packagePath,
			JSON.stringify({
				name: "zgsm",
				publisher: "zgsm-ai",
				version: "3.0.16",
				displayName: "CoStrict",
				description: "CoStrict extension",
				icon: "assets/images/shenma_robot_logo_big.png",
				keywords: ["costrict", "zgsm", "ai"],
				contributes: {
					views: {
						"costrict-ActivityBar": [
							{ id: "costrict.SidebarProvider", icon: "assets/images/shenma_robot_logo_big.png" },
							{ id: "costrict.AssistantUISidebarProvider" },
						],
					},
					commands: [
						{ command: "costrict.openNewButtonClicked" },
						{ command: "costrict.cloudButtonClicked" },
						{ command: "costrict.switchUiMode" },
					],
					menus: {
						"view/title": [
							{ command: "costrict.settingsButtonClicked", when: "view == costrict.SidebarProvider" },
							{ command: "costrict.reloadWebview", when: "view == costrict.AssistantUISidebarProvider" },
						],
					},
					configuration: {
						properties: {
							"costrict.uiMode": { type: "string" },
							"costrict.assistantUI.enabled": { type: "boolean" },
							"costrict.apiRequestTimeout": { type: "number" },
						},
					},
				},
			}),
		)

		patchPackageJson(tempDir)
		const result = JSON.parse(fs.readFileSync(packagePath, "utf8"))

		expect(result.name).toBe("dicode")
		expect(result.publisher).toBe(brand.publisher)
		expect(result.displayName).toBe("Dicode")
		expect(result.icon).toBe("assets/images/dicode-icon.png")
		expect(result.keywords).not.toContain("costrict")
		expect(result.contributes.views["costrict-ActivityBar"]).toHaveLength(1)
		expect(result.contributes.commands.map((item: { command: string }) => item.command)).toEqual([
			"costrict.openNewButtonClicked",
		])
		expect(result.contributes.menus["view/title"]).toHaveLength(1)
		expect(result.contributes.configuration.properties["costrict.uiMode"]).toBeUndefined()
		expect(result.contributes.configuration.properties["costrict.assistantUI.enabled"]).toBeUndefined()
		expect(result.contributes.configuration.properties["costrict.apiRequestTimeout"]).toBeDefined()
	})

	it("patches every localized extension display name", () => {
		const extensionDir = path.join(tempDir, "extension")
		for (const name of ["package.nls.json", "package.nls.zh-CN.json"]) {
			fs.writeFileSync(
				path.join(extensionDir, name),
				JSON.stringify({
					"extension.displayName": "CoStrict",
					"extension.displayName.long": "CoStrict",
					"extension.description": "CoStrict extension",
					"configuration.title": "CoStrict",
				}),
			)
		}

		patchNlsFiles(tempDir)

		for (const name of ["package.nls.json", "package.nls.zh-CN.json"]) {
			const result = JSON.parse(fs.readFileSync(path.join(extensionDir, name), "utf8"))
			expect(result["extension.displayName"]).toBe("Dicode")
			expect(result["configuration.title"]).toBe("Dicode")
		}
	})

	it("patches the VSIX identity and visible metadata", () => {
		const manifestPath = path.join(tempDir, "extension.vsixmanifest")
		fs.writeFileSync(
			manifestPath,
			`<PackageManifest><Metadata><Identity Language="en-US" Id="zgsm" Version="3.0.16" Publisher="zgsm-ai" /><DisplayName>CoStrict</DisplayName><Description xml:space="preserve">CoStrict extension</Description><Properties><Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/zgsm-ai/costrict.git" /></Properties></Metadata></PackageManifest>`,
		)

		patchVsixManifest(tempDir)
		const result = fs.readFileSync(manifestPath, "utf8")
		expect(result).toContain('Id="dicode"')
		expect(result).toContain(`Publisher="${brand.publisher}"`)
		expect(result).toContain("<DisplayName>Dicode</DisplayName>")
		expect(result).not.toContain("CoStrict")
		expect(result).not.toContain("zgsm-ai/costrict")
	})

	it("removes packaged Cloud UI static assets", () => {
		const cloudDir = path.join(tempDir, "extension", "dist", "assets", "cs-cloud-ui", "out")
		fs.mkdirSync(cloudDir, { recursive: true })
		fs.writeFileSync(path.join(cloudDir, "index.html"), "cloud")

		removeCloudAssets(tempDir)

		expect(fs.existsSync(cloudDir)).toBe(false)
	})

	it("rebrands built-in prompt text without changing lowercase backend identifiers", () => {
		expect(replaceVisibleBrand("You are CoStrict, based on Roo Code. provider=costrict 诸葛神码")).toBe(
			"You are Dicode, based on Dicode. provider=costrict Dicode",
		)
	})
})
