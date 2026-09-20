import { useCallback, useState, memo, useMemo } from "react"
import { useEvent } from "react-use"
import { t } from "i18next"
import { ChevronDown, OctagonX } from "lucide-react"

import { type ExtensionMessage, type CommandExecutionStatus, commandExecutionStatusSchema } from "@roo-code/types"

import { safeJsonParse } from "@roo/core"
import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { parseCommand } from "@roo/parse-command"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"

import { Button, StandardTooltip } from "@src/components/ui"
import CodeBlock from "@src/components/common/CodeBlock"

import { TerminalOutput } from "./TerminalOutput"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

interface CommandExecutionProps {
	executionId: string
	commandExecution?: import("@roo-code/types").ClineMessage["commandExecution"]
	approvalPending?: boolean
	text?: string
	icon?: JSX.Element | null
	title?: JSX.Element | null
	onCommandStop?: () => void
}

export const CommandExecution = ({
	executionId,
	text,
	icon,
	title,
	onCommandStop,
	commandExecution,
	approvalPending = false,
}: CommandExecutionProps) => {
	const { projectPermissionProfile } = useExtensionState()

	const { command, output: parsedOutput } = useMemo(() => parseCommandAndOutput(text), [text])

	// If we aren't opening the VSCode terminal for this command then we default
	// to expanding the command execution output.
	const [isExpanded, setIsExpanded] = useState(false)
	const [isHovering, setIsHovering] = useState(false)

	const [streamingOutput, setStreamingOutput] = useState("")
	const [status, setStatus] = useState<CommandExecutionStatus | null>(null)
	// Persist pid separately to ensure it's available even after process exits
	const [persistedPid, setPersistedPid] = useState<number | undefined>(undefined)

	// The command's output can either come from the text associated with the
	// task message (this is the case for completed commands) or from the
	// streaming output (this is the case for running commands).
	const output = streamingOutput || parsedOutput
	const isAbortable = status?.status === "started" || status?.status === "backgrounded"

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "commandExecutionStatus") {
				const result = commandExecutionStatusSchema.safeParse(safeJsonParse(message.text, {}))

				if (result.success) {
					const data = result.data

					if (data.executionId !== executionId) {
						return
					}

					switch (data.status) {
						case "started":
							setStatus(data)
							// Persist pid for later use even after process exits
							if (data.pid) {
								setPersistedPid(data.pid)
							}
							break
						case "output":
							setStreamingOutput(data.output)
							break
						case "backgrounded":
							setStatus(data)
							setIsExpanded(true)
							break
						case "fallback":
							setIsExpanded(true)
							break
						default:
							setStatus(data)
							break
					}
				}
			}
		},
		[executionId],
	)

	useEvent("message", onMessage)

	return (
		<>
			{commandExecution && (
				<div className="mb-2 text-sm text-vscode-descriptionForeground">
					<strong>
						{t(
							commandExecution.scope === "outside"
								? "chat:commandExecution.outsideProject"
								: "chat:commandExecution.withinProject",
						)}
					</strong>
					<div>{commandExecution.cwd}</div>
					{commandExecution.requiresReview && <div>{t("chat:commandExecution.review")}</div>}
				</div>
			)}
			<div className="flex flex-row items-center justify-between gap-2 mb-1">
				<div className="flex flex-row items-center gap-2">
					{icon}
					{title}
					{status?.status === "exited" && (
						<div className="flex flex-row items-center gap-2 font-mono text-xs">
							<StandardTooltip
								content={t("chat:commandExecution.exitStatus", { exitCode: status.exitCode })}>
								<div
									className={cn(
										"rounded-full size-2",
										status.exitCode === 0 ? "bg-green-600" : "bg-red-600",
									)}
								/>
							</StandardTooltip>
						</div>
					)}

					{status?.status === "started" &&
						typeof status.agentTimeoutMs === "number" &&
						status.agentTimeoutMs > 0 && (
							<div className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 font-mono text-[10px] leading-none text-amber-600">
								{t("chat:commandExecution.backgroundedPlanned", {
									seconds: Math.round(status.agentTimeoutMs / 1000),
								})}
							</div>
						)}
				</div>
				<div className=" flex flex-row items-center justify-between gap-2 px-1">
					<div className="flex flex-row items-center gap-1">
						{isAbortable && (
							<div className="flex flex-row items-center gap-2 font-mono text-xs">
								{persistedPid && <div className="whitespace-nowrap">(PID: {persistedPid})</div>}
								<StandardTooltip content={t("chat:commandExecution.abort")}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											vscode.postMessage({
												type: "terminalOperation",
												terminalOperation: "abort",
												terminalPid: persistedPid,
												executionId: status?.executionId ?? executionId,
												terminalCommand: command,
											})
											onCommandStop?.()
										}}>
										<OctagonX className="size-4" />
									</Button>
								</StandardTooltip>
							</div>
						)}
						{output.length > 0 && (
							<Button variant="ghost" size="icon" onClick={() => setIsExpanded(!isExpanded)}>
								<ChevronDown
									className={cn(
										"size-4 transition-transform duration-300",
										isExpanded && "rotate-180",
									)}
								/>
							</Button>
						)}
					</div>
				</div>
			</div>

			<div className="bg-vscode-editor-background border border-vscode-border rounded-xs ml-6 mt-2">
				<div
					className="p-2 relative"
					onMouseEnter={() => setIsHovering(true)}
					onMouseLeave={() => setIsHovering(false)}>
					<CodeBlock source={command} language="shell" />
					<OutputContainer isExpanded={isExpanded} output={output} />
					{!isExpanded && output.length > 0 && (
						<div
							style={{
								position: "absolute",
								bottom: 0,
								left: 0,
								right: 0,
								height: "50px",
								background: "linear-gradient(to top, var(--vscode-editor-background), transparent)",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
							}}>
							<VSCodeButton
								appearance="secondary"
								style={{
									borderRadius: "100px",
									opacity: isHovering ? 1 : 0,
									transition: "opacity 0.2s ease-in-out",
									pointerEvents: isHovering ? "auto" : "none",
								}}
								onClick={() => {
									setIsExpanded(true)
								}}>
								{t("chat:markdown.expandPrompt")}
							</VSCodeButton>
						</div>
					)}
				</div>
				{approvalPending && (
					<div className="border-t border-vscode-panel-border p-2 flex flex-col gap-2">
						<p className="m-0 text-xs text-vscode-descriptionForeground">
							{commandExecution?.requiresReview
								? t("chat:commandExecution.oneTimeDestructive")
								: commandExecution?.scope === "outside"
									? t("chat:commandExecution.oneTimeOutsideProject")
									: t("chat:commandExecution.approveWithinProject")}
						</p>
						<div className="flex flex-wrap items-center gap-1.5">
							<Button
								data-testid="allow-command-once"
								size="sm"
								variant="primary"
								onClick={() =>
									vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })
								}>
								{t("chat:commandExecution.allowOnce")}
							</Button>
							{projectPermissionProfile?.mode === "request-approval" &&
								commandExecution?.scope === "workspace" &&
								!commandExecution.requiresReview && (
									<Button
										data-testid="allow-project-command"
										size="sm"
										variant="secondary"
										onClick={() =>
											vscode.postMessage({ type: "approveProjectCommand", text: command })
										}>
										{t("chat:commandExecution.allowCommandInProject")}
									</Button>
								)}
							<Button
								data-testid="deny-command"
								size="sm"
								variant="secondary"
								onClick={() =>
									vscode.postMessage({ type: "askResponse", askResponse: "noButtonClicked" })
								}>
								{t("chat:commandExecution.deny")}
							</Button>
						</div>
					</div>
				)}
			</div>
		</>
	)
}

CommandExecution.displayName = "CommandExecution"

const OutputContainerInternal = ({ isExpanded, output }: { isExpanded: boolean; output: string }) => (
	<div
		className={cn("overflow-auto", {
			"max-h-60": !isExpanded,
			"max-h-full mt-1 pt-1 border-t border-border/25": isExpanded,
		})}>
		{output.length > 0 && <TerminalOutput content={output} />}
	</div>
)

const OutputContainer = memo(OutputContainerInternal)

const parseCommandAndOutput = (text: string | undefined) => {
	if (!text) {
		return { command: "", output: "" }
	}

	const index = text.indexOf(COMMAND_OUTPUT_STRING)

	if (index === -1) {
		return { command: text, output: "" }
	}

	return {
		command: text.slice(0, index),
		output: text.slice(index + COMMAND_OUTPUT_STRING.length),
	}
}
