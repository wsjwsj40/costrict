import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"

import { About } from "../About"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({
			t: (key: string) => key,
		}),
	}
})

vi.mock("@roo/package", () => ({
	Package: {
		version: "1.0.0",
		sha: "abc12345",
		buildTime: "2026-01-15T10:30:00.000Z",
	},
}))

describe("About", () => {
	const defaultProps = {
		telemetrySetting: "enabled" as const,
		setTelemetrySetting: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the About section header", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:sections.about")).toBeInTheDocument()
	})

	it("displays version information", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText(/Version: 1\.0\.0/)).toBeInTheDocument()
	})

	it("renders the feedback message board", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("问题反馈")).toBeInTheDocument()
		expect(screen.getByText("留言板")).toBeInTheDocument()
	})

	it("renders the update command", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		fireEvent.click(screen.getByText("Dicode: Check for Updates"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "checkForUpdates" })
	})

	it("renders the DiCode website and community links", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("DiCode 官方网站")).toBeInTheDocument()
		expect(screen.getByText("查看 DiCode 用户交流群最新二维码")).toBeInTheDocument()
	})

	it("renders the contact", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("zeng.xinyi@byd.com")).toBeInTheDocument()
	})

	it("renders export, import, and reset buttons", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:footer.settings.export")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.import")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.reset")).toBeInTheDocument()
	})
})
