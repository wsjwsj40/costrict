import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { CommandExecution } from "../CommandExecution"
import { ExtensionStateContext } from "../../../context/ExtensionStateContext"
import { vscode } from "../../../utils/vscode"

vi.mock("react-use", () => ({ useEvent: vi.fn() }))
vi.mock("../../../utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("../../common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <div data-testid="code-block">{source}</div>,
}))

function renderCommand(profile?: { mode: "request-approval" | "auto-approval" }) {
	return render(
		<ExtensionStateContext.Provider value={{ projectPermissionProfile: profile } as any}>
			<CommandExecution
				executionId="test"
				text="pnpm test"
				approvalPending
				commandExecution={{ cwd: "/project", scope: "workspace" }}
			/>
		</ExtensionStateContext.Provider>,
	)
}

describe("CommandExecution", () => {
	beforeEach(() => vi.clearAllMocks())

	it("renders the command and one-time approval controls", () => {
		renderCommand({ mode: "request-approval" })
		expect(screen.getByTestId("code-block")).toHaveTextContent("pnpm test")
		expect(screen.getByTestId("allow-command-once")).toBeInTheDocument()
		expect(screen.getByTestId("deny-command")).toBeInTheDocument()
	})

	it("offers an exact project command grant only in request approval", () => {
		renderCommand({ mode: "request-approval" })
		fireEvent.click(screen.getByTestId("allow-project-command"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "approveProjectCommand", text: "pnpm test" })
	})

	it("does not offer a remembered grant for destructive commands", () => {
		render(
			<ExtensionStateContext.Provider value={{ projectPermissionProfile: { mode: "request-approval" } } as any}>
				<CommandExecution
					executionId="test"
					text="rm -rf build"
					approvalPending
					commandExecution={{ cwd: "/project", scope: "workspace", requiresReview: true }}
				/>
			</ExtensionStateContext.Provider>,
		)
		expect(screen.queryByTestId("allow-project-command")).not.toBeInTheDocument()
	})

	it("does not render approval buttons after an automatic approval", () => {
		render(
			<ExtensionStateContext.Provider value={{ projectPermissionProfile: { mode: "auto-approval" } } as any}>
				<CommandExecution
					executionId="test"
					text="python3 --version"
					approvalPending={false}
					commandExecution={{ cwd: "/project", scope: "workspace" }}
				/>
			</ExtensionStateContext.Provider>,
		)
		expect(screen.queryByTestId("allow-command-once")).not.toBeInTheDocument()
		expect(screen.queryByTestId("deny-command")).not.toBeInTheDocument()
	})
})
