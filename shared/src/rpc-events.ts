/**
 * Wire shapes that flow from the omp agent (RPC mode) through the omp-web
 * server to the browser. These mirror the JSON produced by
 * `@oh-my-pi/pi-coding-agent`'s RPC protocol (`src/modes/rpc/rpc-types.ts`)
 * and the agent's `AgentSessionEvent` union.
 *
 * Consumers cast at the JSON boundary and every `switch` keeps a tolerant
 * `default:` branch — unknown variants arrive over the wire as plain JSON and
 * must never crash the renderer.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface WireTextContent {
	type: "text";
	text: string;
}

export interface WireImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
	/** Optional https mirror served by the blob server. */
	url?: string;
}

export interface WireThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface WireRedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface WireToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type WireAssistantContent =
	| WireTextContent
	| WireThinkingContent
	| WireRedactedThinkingContent
	| WireToolCallContent;

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

export interface WireUserMessage {
	role: "user";
	content: string | (WireTextContent | WireImageContent)[];
	synthetic?: boolean;
	timestamp: number;
}

export interface WireAssistantMessage {
	role: "assistant";
	content: WireAssistantContent[];
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

export interface WireToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (WireTextContent | WireImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = WireUserMessage | WireAssistantMessage | WireToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Agent events
// ═══════════════════════════════════════════════════════════════════════════

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
}

export interface WireContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface WireSessionState {
	model?: WireModel;
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	contextUsage?: WireContextUsage;
	todoPhases?: unknown[];
}

export type WireAgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	/** Carries the FULL accumulating partial message — no delta tracking needed. */
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
			intent?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string }
	| { type: "model_changed" };

// ═══════════════════════════════════════════════════════════════════════════
// Subagents (RPC frames)
// ═══════════════════════════════════════════════════════════════════════════

export interface WireAgentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: { tool: string; args: string; endMs: number }[];
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
}

export interface WireSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource?: string;
	description?: string;
	status: WireAgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: WireAgentProgress;
	parentToolCallId?: string;
}

export type WireSubagentFrame =
	| {
			type: "subagent_snapshot";
			subagents: WireSubagentSnapshot[];
	  }
	| { type: "subagent_lifecycle"; id: string; agent: string; description?: string; status: string }
	| { type: "subagent_progress"; snapshot: WireSubagentSnapshot }
	| { type: "subagent_event"; id: string; event: unknown };

// ═══════════════════════════════════════════════════════════════════════════
// Available commands
// ═══════════════════════════════════════════════════════════════════════════

export interface WireAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: string;
}

export interface WireAvailableCommandsFrame {
	type: "available_commands_update";
	commands: WireAvailableSlashCommand[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Misc RPC frames
// ═══════════════════════════════════════════════════════════════════════════

export interface WirePromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface WireRpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface WireRpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension UI sub-protocol (docs/rpc.md "Extension UI Sub-Protocol").
// Interactive methods (select/confirm/input/editor) block the agent until the
// host replies with `extension_ui_response`; the rest are fire-and-forget.
// Tool approvals surface as `select` with options ["Approve", "Deny"].
// ═══════════════════════════════════════════════════════════════════════════

export interface WireExtensionSelectOptionDetail {
	description?: string;
}

export type WireExtensionUiRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: WireExtensionSelectOptionDetail[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	/** Server-side abort of a pending dialog — dismiss the UI for `targetId`. */
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/** Short loopback 302 redirect — surface as the copy target (OAuth). */
			launchUrl?: string;
			instructions?: string;
	  };

export type WireExtensionUiResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/** Misc side-channel frames the agent emits outside the event/response flow. */
export interface WireCommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface WireSessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId?: string;
}

export interface WireConfigUpdateFrame {
	type: "config_update";
	model?: string;
	thinkingLevel?: string;
}

export interface WireExtensionErrorFrame {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

/** Anything the agent emits on stdout that the UI may want to render. */
export type WireFrame =
	| WireAgentEvent
	| WireSubagentFrame
	| WireSessionState
	| WireRpcResponse
	| WireRpcReadyFrame
	| WireAvailableCommandsFrame
	| WirePromptResultFrame
	| WireExtensionUiRequest
	| WireCommandOutputFrame
	| WireSessionInfoUpdateFrame
	| WireConfigUpdateFrame
	| WireExtensionErrorFrame
	| { type: string; [key: string]: unknown };

// ═══════════════════════════════════════════════════════════════════════════
// UI-facing message log entries (derived from events on the client)
// ═══════════════════════════════════════════════════════════════════════════

export interface UiTextPart {
	kind: "text";
	text: string;
}

export interface UiThinkingPart {
	kind: "thinking";
	thinking: string;
}

export interface UiToolCallPart {
	kind: "toolCall";
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	/** Streamed while executing. */
	result?: unknown;
	isError?: boolean;
}

export type UiAssistantPart = UiTextPart | UiThinkingPart | UiToolCallPart;
