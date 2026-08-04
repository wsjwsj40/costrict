import fs from "fs"
import os from "os"
import path from "path"

const sourcePackageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))

const {
	patchPackageJson,
	patchRuntimeBundle,
	patchVsixManifest,
	removeExcludedBundledSkillFiles,
} = require("../../scripts/make-nightly-vsix.js")

describe("make-nightly-vsix patchPackageJson", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-nightly-vsix-test-"))
		fs.mkdirSync(path.join(tempDir, "extension"), { recursive: true })
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("保留 author、repository、homepage，并继续应用 nightly 变换", () => {
		const packagePath = path.join(tempDir, "extension", "package.json")
		const originalPackage = {
			name: "zgsm-nightly",
			publisher: "atad-apts",
			version: "0.0.1-nightly",
			displayName: "DiCode Nightly",
			description: "nightly build for costrict",
			command: "costrict.openPanel",
			author: { name: "unexpected-author" },
			repository: {
				type: "git",
				url: "https://example.com/incorrect/repo",
			},
			homepage: "https://example.com/wrong-homepage",
		}

		fs.writeFileSync(packagePath, `${JSON.stringify(originalPackage, null, "\t")}\n`)

		patchPackageJson(tempDir)

		const patchedPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"))

		expect(patchedPackage.name).toBe("zgsm-nightly")
		expect(patchedPackage.publisher).toBe("atad-apts")
		expect(patchedPackage.version).toBe(sourcePackageJson.version)
		expect(patchedPackage.displayName).toBe("DiCode Nightly")
		expect(patchedPackage.description).toBe("nightly build for costrict-nightly")
		expect(patchedPackage.command).toBe("costrict-nightly.openPanel")
		expect(patchedPackage.author).toEqual({ name: "atad-apts" })
		expect(patchedPackage.repository).toEqual({
			type: "git",
			url: "https://github.com/atad-apts/costrict",
		})
		expect(patchedPackage.homepage).toBe("https://github.com/atad-apts/costrict")
	})

	it("patches runtime Package metadata for nightly activation", () => {
		const distDir = path.join(tempDir, "extension", "dist")
		fs.mkdirSync(distDir, { recursive: true })
		const bundlePath = path.join(distDir, "extension.js")
		fs.writeFileSync(
			bundlePath,
			'name:process.env.COSTRICT_PKG_NAME||"zgsm",commandIDPrefix:process.env.COSTRICT_PKG_COMMAND_ID_PREFIX||"costrict",other:true',
		)

		patchRuntimeBundle(tempDir)

		const patchedBundle = fs.readFileSync(bundlePath, "utf8")
		expect(patchedBundle).toContain('name:"zgsm-nightly"')
		expect(patchedBundle).toContain('commandIDPrefix:"costrict-nightly"')
		expect(patchedBundle).not.toContain('name:process.env.COSTRICT_PKG_NAME||"zgsm"')
	})

	it("patches VSIX manifest display metadata for Marketplace uniqueness", () => {
		const manifestPath = path.join(tempDir, "extension.vsixmanifest")
		fs.writeFileSync(
			manifestPath,
			`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest>
	<Metadata>
		<Identity Language="en-US" Id="zgsm-nightly" Version="3.0.0" Publisher="atad-apts" />
		<DisplayName>DiCode</DisplayName>
		<Description xml:space="preserve">DiCode - strict AI coder for enterprises, quality first, including AI Agent, AI CodeReview, AI Completion.</Description>
	</Metadata>
</PackageManifest>`,
		)

		patchVsixManifest(tempDir)

		const patchedManifest = fs.readFileSync(manifestPath, "utf8")
		expect(patchedManifest).toContain("<DisplayName>DiCode Nightly</DisplayName>")
		expect(patchedManifest).toContain(
			'<Description xml:space="preserve">DiCode Nightly - strict AI coder for enterprises, quality first, including AI Agent, AI CodeReview, AI Completion.</Description>',
		)
		expect(patchedManifest).not.toContain("<DisplayName>DiCode</DisplayName>")
	})

	it("removes Marketplace-flagged bundled skill files recursively", () => {
		const languageDir = path.join(
			tempDir,
			"extension",
			"bundled-skills",
			"en",
			"security-review",
			"knowledge",
			"languages",
		)
		fs.mkdirSync(languageDir, { recursive: true })
		const excludedFile = path.join(languageDir, "php_deserialization.md")
		const retainedFile = path.join(languageDir, "python.md")
		fs.writeFileSync(excludedFile, "excluded")
		fs.writeFileSync(retainedFile, "retained")

		removeExcludedBundledSkillFiles(path.join(tempDir, "extension", "bundled-skills"))

		expect(fs.existsSync(excludedFile)).toBe(false)
		expect(fs.existsSync(retainedFile)).toBe(true)
	})
})
