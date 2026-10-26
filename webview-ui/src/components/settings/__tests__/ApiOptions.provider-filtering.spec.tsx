import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings, OrganizationAllowList } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"

import ApiOptions from "../ApiOptions"

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({
		organizationAllowList: undefined,
		cloudIsAuthenticated: false,
	})),
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock the router models hook
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({
	useRouterModels: () => ({
		data: null,
		refetch: vi.fn(),
	}),
}))

// Mock the selected model hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn(() => ({
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		info: null,
	})),
}))

// Mock the OpenRouter model providers hook
vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	useOpenRouterModelProviders: () => ({
		data: null,
	}),
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
}))

// Mock the SearchableSelect component to capture the options passed to it
vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({ options, ...props }: any) => {
		// Store the options in a data attribute for testing
		return (
			<div data-testid="searchable-select" data-options={JSON.stringify(options)} {...props}>
				{options.map((opt: any) => (
					<div key={opt.value} data-testid={`option-${opt.value}`}>
						{opt.label}
					</div>
				))}
			</div>
		)
	},
	StandardTooltip: ({ children }: any) => <>{children}</>,
	Select: ({ children }: any) => <div>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	Collapsible: ({ children }: any) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
	CollapsibleContent: ({ children }: any) => <div>{children}</div>,
	Slider: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	// AlertDialog components for ProviderChangeWarningDialog
	AlertDialog: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	AlertDialogAction: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	AlertDialogCancel: ({ children, ...props }: any) => <button {...props}>{children}</button>,
	AlertDialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	AlertDialogDescription: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	AlertDialogFooter: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	AlertDialogHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	AlertDialogTitle: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	// Add Popover components for ModelPicker
	Popover: ({ children }: any) => <div>{children}</div>,
	PopoverTrigger: ({ children }: any) => <div>{children}</div>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	// Add Command components for ModelPicker
	Command: ({ children }: any) => <div>{children}</div>,
	CommandInput: ({ ...props }: any) => <input {...props} />,
	CommandList: ({ children }: any) => <div>{children}</div>,
	CommandEmpty: ({ children }: any) => <div>{children}</div>,
	CommandGroup: ({ children }: any) => <div>{children}</div>,
	CommandItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}))

describe("ApiOptions Provider Filtering", () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	})

	const defaultProps = {
		uriScheme: "vscode",
		apiConfiguration: {
			apiProvider: "anthropic",
			apiKey: "test-key",
		} as ProviderSettings,
		setApiConfigurationField: vi.fn(),
		fromWelcomeView: false,
		errorMessage: undefined,
		setErrorMessage: vi.fn(),
		setCachedStateField: vi.fn(),
	}

	const renderWithProviders = (props = defaultProps) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<ApiOptions {...props} />
			</QueryClientProvider>,
		)
	}

	beforeEach(() => {
		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: undefined,
			cloudIsAuthenticated: false,
		} as any)
		vi.mocked(useSelectedModel).mockReturnValue({
			provider: "costrict",
			id: undefined,
			info: null,
		} as any)
	})

	it("only exposes the built-in and OpenAI Compatible providers", () => {
		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")

		const providerValues = options.map((opt: any) => opt.value)
		expect(providerValues).toEqual(["costrict", "openai"])
	})

	it("still applies the organization allow list to selectable providers", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: {
				openai: { allowAll: true },
			},
		}

		// Mock the extension state with the allow list
		vi.mocked(useExtensionState).mockReturnValue({
			organizationAllowList: allowList,
			cloudIsAuthenticated: false,
		} as any)

		renderWithProviders()

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).toEqual(["openai"])
	})

	it("does not re-expose a legacy provider merely because it is selected", () => {
		const props = {
			...defaultProps,
			apiConfiguration: {
				...defaultProps.apiConfiguration,
				apiProvider: "anthropic",
			} as ProviderSettings,
		}

		renderWithProviders(props)

		const selectElement = screen.getByTestId("provider-select")
		const options = JSON.parse(selectElement.getAttribute("data-options") || "[]")
		const providerValues = options.map((opt: any) => opt.value)

		expect(providerValues).toEqual(["costrict", "openai"])
	})
})
