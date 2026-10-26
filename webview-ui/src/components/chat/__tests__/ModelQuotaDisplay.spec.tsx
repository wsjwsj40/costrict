import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { ModelQuotaDisplay } from "../ModelQuotaDisplay"

const mocks = vi.hoisted(() => ({
	postMessage: vi.fn(),
	configuration: {
		apiProvider: "costrict",
		costrictAccessToken: "access-token",
	} as any,
}))

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: mocks.postMessage },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: mocks.configuration }),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: { amount?: string }) => {
			if (key === "chat:modelQuota.remaining") return `剩余 ¥${values?.amount}`
			if (key === "chat:modelQuota.used") return `已用 ¥${values?.amount}`
			if (key === "chat:modelQuota.unlimited") return "无限额度"
			return key
		},
	}),
	initReactI18next: { type: "3rdParty", init: vi.fn() },
}))

describe("ModelQuotaDisplay", () => {
	beforeEach(() => {
		mocks.postMessage.mockClear()
		mocks.configuration = { apiProvider: "costrict", costrictAccessToken: "access-token" }
	})

	it("requests quota on mount and renders refreshed money amounts", async () => {
		render(<ModelQuotaDisplay />)
		expect(mocks.postMessage).toHaveBeenCalledWith({ type: "fetchModelQuota" })

		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "modelQuotaInfo",
					values: { remainQuotaMoney: 20, usedQuotaMoney: 0.5, unlimitedQuota: false },
				},
			}),
		)

		await waitFor(() => {
			expect(screen.getByText("剩余 ¥20.00")).toBeInTheDocument()
			expect(screen.getByText("已用 ¥0.50")).toBeInTheDocument()
		})
	})

	it("shows unlimited quota instead of a remaining amount", async () => {
		render(<ModelQuotaDisplay />)
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "modelQuotaInfo",
					values: { remainQuotaMoney: 0, usedQuotaMoney: 0.5, unlimitedQuota: true },
				},
			}),
		)

		await waitFor(() => {
			expect(screen.getByText("无限额度")).toBeInTheDocument()
			expect(screen.getByText("已用 ¥0.50")).toBeInTheDocument()
			expect(screen.queryByText(/剩余/)).not.toBeInTheDocument()
		})
	})

	it("does not query or render quota for other providers", () => {
		mocks.configuration = { apiProvider: "anthropic" }
		render(<ModelQuotaDisplay />)

		expect(mocks.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByText(/剩余/)).not.toBeInTheDocument()
	})
})
