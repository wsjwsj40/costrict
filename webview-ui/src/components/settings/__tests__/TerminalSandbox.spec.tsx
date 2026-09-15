import { render, screen, fireEvent } from "@testing-library/react"
import { TerminalSettings } from "../TerminalSettings"
import { vscode } from "@/utils/vscode"
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("../SearchableSetting", () => ({ SearchableSetting: ({ children }: any) => children }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={!!checked} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeButton: ({ children, onClick, disabled }: any) => (
		<button onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
	VSCodeLink: ({ children }: any) => <span>{children}</span>,
}))
it("buffers sandbox changes until the parent SettingsView saves them", () => {
	const setCachedStateField = vi.fn()
	render(<TerminalSettings terminalSandboxEnabled setCachedStateField={setCachedStateField} />)
	fireEvent.click(screen.getByLabelText("settings:terminal.sandbox.label"))
	expect(setCachedStateField).toHaveBeenCalledWith("terminalSandboxEnabled", false)
	expect(vi.mocked(vscode.postMessage).mock.calls.some(([message]) => message.type === "updateSettings")).toBe(false)
})
it("checks availability without enabling sandboxing or installing anything", () => {
	vi.mocked(vscode.postMessage).mockClear()
	const setCachedStateField = vi.fn()
	render(<TerminalSettings setCachedStateField={setCachedStateField} />)
	fireEvent.click(screen.getByText("settings:terminal.sandbox.check"))
	expect(vscode.postMessage).toHaveBeenCalledWith({ type: "checkCommandSandbox" })
	expect(setCachedStateField).not.toHaveBeenCalled()
	expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "installCommandSandbox" })
})
