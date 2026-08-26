#!/usr/bin/env bun
/**
 * Mock RPC host — speaks the omp RPC protocol well enough to develop and
 * test omp-web without a real omp install.
 *
 * Start the server with OMP_WEB_MOCK=1 to spawn this instead of `omp`.
 * Behaviour:
 *  - emits the `ready` frame on startup
 *  - negotiates protocol v2 when asked
 *  - `prompt`/`steer`/`follow_up` answer instantly, then stream a canned
 *    assistant turn (thinking → text → tool call → tool result)
 *  - `get_state` / `get_messages` return canned state/history
 *  - `abort` cancels any streaming turn
 */
import { RpcFrameDecoder } from "../src/rpc/frame";

const sessionName = process.argv.includes("--session")
	? (process.argv[process.argv.indexOf("--session") + 1] ?? "mock")
	: "mock";

let protocolVersion = 1;
const write = (obj: unknown) => {
	const line = `${JSON.stringify(obj)}\n`;
	// Mirror the real encoder: split frames above 1 MB into v2 rpc_chunk frames.
	const isChunk = (obj as { type?: string }).type === "rpc_chunk";
	if (!isChunk && protocolVersion >= 2 && Buffer.byteLength(line, "utf8") > 1024 * 1024) {
		const bytes = Buffer.from(JSON.stringify(obj), "utf8");
		const chunkId = `mock-${Math.random().toString(36).slice(2)}`;
		const count = Math.ceil(bytes.byteLength / (256 * 1024));
		for (let index = 0; index < count; index++) {
			write({
				type: "rpc_chunk",
				chunkId,
				index,
				count,
				byteLength: bytes.byteLength,
				data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
			});
		}
		return;
	}
	process.stdout.write(line);
};

interface Pending {
	id?: string;
	command: string;
}

let pendingPrompt: Pending | undefined;
let streamTimer: ReturnType<typeof setTimeout> | undefined;
let pendingLogin: { id?: string; providerId: string } | undefined;

function stopStream() {
	clearTimeout(streamTimer);
	streamTimer = undefined;
}

function streamCannedTurn() {
	stopStream();
	let current: Record<string, unknown> | undefined;
	const steps: Array<() => void> = [
		() => {
			current = {
				role: "assistant",
				content: [],
				model: "mock-model",
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			write({ type: "message_start", message: current });
		},
		() => {
			current = {
				...current!,
				content: [{ type: "thinking", thinking: "Let me plan this step by step.\nFirst, list the project files." }],
			};
			write({ type: "message_update", message: current });
		},
		() => {
			current = {
				...current!,
				content: [
					{ type: "thinking", thinking: "Let me plan this step by step.\nFirst, list the project files." },
					{
						type: "text",
						text: "I'll start by inspecting the repository layout, then make the change you asked for.",
					},
				],
			};
			write({ type: "message_update", message: current });
		},
		() => {
			current = {
				...current!,
				content: [
					{ type: "thinking", thinking: "Let me plan this step by step.\nFirst, list the project files." },
					{
						type: "text",
						text: "I'll start by inspecting the repository layout, then make the change you asked for.",
					},
					{ type: "toolCall", id: "tool_1", name: "read_file", arguments: { path: "README.md" } },
				],
			};
			write({ type: "message_update", message: current });
		},
		() => {
			write({ type: "message_end", message: current });
			write({
				type: "tool_execution_start",
				toolCallId: "tool_1",
				toolName: "read_file",
				args: { path: "README.md" },
			});
		},
		() => {
			write({
				type: "tool_execution_update",
				toolCallId: "tool_1",
				toolName: "read_file",
				args: { path: "README.md" },
				partialResult: { content: "# omp\n\nA coding agent." },
			});
		},
		() => {
			write({
				type: "tool_execution_end",
				toolCallId: "tool_1",
				toolName: "read_file",
				result: { content: "# omp\n\nA coding agent." },
			});
			write({ type: "turn_end" });
			if (pendingPrompt) {
				write({ type: "prompt_result", id: pendingPrompt.id, agentInvoked: true });
				pendingPrompt = undefined;
			}
		},
	];
	let index = 0;
	const tick = () => {
		if (index >= steps.length) return;
		steps[index]!();
		index++;
		streamTimer = setTimeout(tick, 250);
	};
	tick();
}

const state = {
	model: { id: "mock-model", name: "Mock Model", provider: "mock", contextWindow: 200000 },
	thinkingLevel: "high",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionFile: `/mock/sessions/${sessionName}`,
	sessionId: sessionName,
	sessionName,
	autoCompactionEnabled: false,
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null,
	messageCount: 2,
	queuedMessageCount: 0,
	contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
};

const cannedMessages = [
	{
		role: "user",
		content: "Welcome! This is a mock session. Send a prompt to see the streaming UI.",
		timestamp: Date.now() - 60_000,
	},
	{
		role: "assistant",
		content: [
			{
				type: "text",
				text: "Hi! I'm the **mock** omp agent. Ask me anything — I'll stream a canned reply with thinking, text, and a tool call.",
			},
		],
		model: "mock-model",
		usage: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 35, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now() - 55_000,
	},
];

const decoder = new RpcFrameDecoder();

function handleFrame(frame: unknown) {
	const parsed = decoder.push(frame);
	if (parsed === undefined) return; // mid-flight chunk sequence
	if (typeof parsed !== "object" || parsed === null) return;
	const obj = parsed as Record<string, unknown>;
	const type = obj.type as string;
	const id = obj.id as string | undefined;

	const respond = (command: string, data?: unknown, success = true) =>
		write({ id, type: "response", command, success, ...(data !== undefined ? { data } : {}) });

	switch (type) {
		case "negotiate_protocol": {
			const version = obj.protocolVersion;
			if (version !== 2) {
				write({
					id,
					type: "response",
					command: "negotiate_protocol",
					success: false,
					error: `Unsupported RPC protocol version: ${String(version)}`,
				});
				return;
			}
			protocolVersion = 2;
			respond("negotiate_protocol", { protocolVersion: 2 });
			return;
		}
		case "get_state":
			respond("get_state", { ...state, isStreaming: streamTimer !== undefined });
			return;
		case "get_messages":
			respond("get_messages", { messages: cannedMessages });
			return;
		case "get_messages_page":
			respond("get_messages_page", { messages: cannedMessages, cursor: undefined });
			return;
		case "get_available_commands":
			respond("get_available_commands", {
				commands: [
					{ name: "model", description: "Show current model selection", source: "builtin" },
					{ name: "compact", description: "Compact the session", source: "builtin" },
					{ name: "todo", description: "Manage todos", source: "builtin" },
				],
			});
			return;
		case "prompt":
		case "steer":
		case "follow_up":
		case "abort_and_prompt": {
			pendingPrompt = { id, command: type };
			write({ id, type: "response", command: type, success: true });
			write({ type: "turn_start" });
			// Echo the prompt back as a user message, images included.
			const images = Array.isArray(obj.images) ? (obj.images as unknown[]) : [];
			const content =
				images.length > 0
					? [
							{ type: "text", text: String(obj.message ?? "") },
							...images.map(image => ({ type: "image", ...(image as Record<string, unknown>) })),
						]
					: String(obj.message ?? "");
			write({
				type: "message_start",
				message: { role: "user", content, timestamp: Date.now() },
			});
			streamCannedTurn();
			return;
		}
		case "abort":
			stopStream();
			write({ id, type: "response", command: "abort", success: true });
			write({ type: "agent_end" });
			pendingPrompt = undefined;
			return;
		case "set_model":
			respond("set_model", { model: obj.modelId ?? "mock-model" });
			write({ type: "model_changed" });
			return;
		case "get_available_models":
			respond("get_available_models", {
				models: [{ id: "mock-model", name: "Mock Model", provider: "mock", contextWindow: 200000 }],
			});
			return;
		case "set_thinking_level":
			respond("set_thinking_level", { thinkingLevel: obj.level ?? null });
			write({ type: "thinking_level_changed", thinkingLevel: obj.level ?? null });
			return;
		case "set_fast_mode": {
			state.fastModeEnabled = obj.enabled === true;
			respond("set_fast_mode", { enabled: state.fastModeEnabled });
			return;
		}
		case "set_interrupt_mode": {
			if (obj.mode === "immediate" || obj.mode === "wait") state.interruptMode = obj.mode;
			respond("set_interrupt_mode", { mode: state.interruptMode });
			return;
		}
		case "set_auto_compaction": {
			state.autoCompactionEnabled = obj.enabled === true;
			respond("set_auto_compaction", { enabled: state.autoCompactionEnabled });
			return;
		}
		case "compact":
			respond("compact", { ok: true });
			return;
		case "set_session_name":
			respond("set_session_name", { sessionName: String(obj.name ?? "") });
			return;
		case "extension_ui_response": {
			// Real omp resolves the pending dialog silently; echo a notice +
			// command_output so tests (and the events panel) can observe it.
			const detail =
				typeof obj.value === "string"
					? `value=${obj.value}`
					: obj.confirmed !== undefined
						? `confirmed=${String(obj.confirmed)}`
						: obj.cancelled
							? "cancelled"
							: "unknown";
			write({
				type: "notice",
				level: "info",
				message: `mock: extension ui answered (${String(obj.id)}) ${detail}`,
				source: "mock",
			});
			write({ type: "command_output", text: `ui-response ${detail}` });
			// Complete a pending login when the paste-code input is answered.
			if (pendingLogin && obj.id === "mock-login-input" && typeof obj.value === "string" && obj.value.length > 0) {
				write({
					id: pendingLogin.id,
					type: "response",
					command: "login",
					success: true,
					data: { providerId: pendingLogin.providerId },
				});
				pendingLogin = undefined;
			}
			write({ id: obj.id, type: "response", command: "extension_ui_response", success: true });
			return;
		}
		case "get_subagents":
			respond("get_subagents", { subagents: [] });
			return;
		case "get_branch_messages":
			respond("get_branch_messages", {
				messages: [
					{ entryId: "e1", text: "first user message" },
					{ entryId: "e2", text: "second user message" },
				],
			});
			return;
		case "branch":
			// Real omp mints a new session file; mock keeps the same identity
			// but still exercises the response + re-hydration path.
			respond("branch", { text: String(obj.entryId ?? ""), cancelled: false });
			return;
		case "get_login_providers":
			respond("get_login_providers", {
				providers: [
					{ id: "anthropic", name: "Anthropic", available: true, authenticated: true },
					{ id: "mock-oauth", name: "Mock OAuth", available: true, authenticated: false },
				],
			});
			return;
		case "login": {
			// Mirror the real flow: push an open_url, then wait for the input
			// dialog response (extension_ui_response) before succeeding.
			write({
				type: "extension_ui_request",
				id: "mock-login-url",
				method: "open_url",
				url: "https://mock.example/oauth/authorize",
				launchUrl: "http://127.0.0.1:9/oauth",
				instructions: "open the link to authorize mock-oauth",
			});
			write({
				type: "extension_ui_request",
				id: "mock-login-input",
				method: "input",
				title: "Paste the authorization code",
				placeholder: "paste code or redirect URL",
				timeout: 600000,
			});
			pendingLogin = { id, providerId: String(obj.providerId ?? "") };
			return;
		}
		case "set_subagent_subscription":
			respond("set_subagent_subscription", { level: obj.level ?? "off" });
			return;
		case "get_session_stats":
			respond("get_session_stats", {
				sessionFile: state.sessionFile,
				sessionId: state.sessionId,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 2,
				tokens: { input: 1200, output: 800, reasoning: 200, cacheRead: 0, cacheWrite: 0, total: 2000 },
				premiumRequests: 0,
				cost: 0.0042,
				contextUsage: state.contextUsage,
			});
			return;
		case "export_html":
			respond("export_html", { path: "/mock/export.html" });
			return;
		default:
			write({ id, type: "response", command: type, success: false, error: `mock: unhandled command ${type}` });
	}
}

// Startup: ready frame, then read stdin lines.
write({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});
write({
	type: "available_commands_update",
	commands: [
		{ name: "model", description: "Show current model selection", source: "builtin" },
		{ name: "compact", description: "Compact the session", source: "builtin" },
	],
});
write({
	type: "extension_ui_request",
	id: "mock-widget",
	method: "setWidget",
	widgetKey: "autoresearch",
	widgetLines: ["autoresearch ▸ scanning docs", "  2/5 sources · eta 30s"],
});
// Interactive approval-style select (blocks until answered, like a real
// approval in --approval-mode write): exercises the web dialog roundtrip.
write({
	type: "extension_ui_request",
	id: "mock-approval-1",
	method: "select",
	title: "Allow tool: read_file\npath: README.md\ntier: read",
	options: ["Approve", "Deny"],
});
// A parked subagent snapshot so the agents panel has something to show.
write({
	type: "subagent_snapshot",
	subagents: [
		{
			id: "sub-mock-1",
			index: 0,
			agent: "explorer",
			description: "scanning the repo",
			status: "running",
			task: "map the repository layout",
			lastUpdate: Date.now(),
			progress: {
				index: 0,
				id: "sub-mock-1",
				agent: "explorer",
				status: "running",
				task: "map the repository layout",
				currentTool: "glob",
				recentTools: [],
				recentOutput: [],
				toolCount: 3,
				requests: 1,
				tokens: 4200,
				cost: 0,
				durationMs: 12_000,
			},
		},
	],
});

let buffer = "";
const decoderForLines = new TextDecoder();
const input = process.stdin;
input.setEncoding?.("utf8");
input.on("data", (chunk: string | Buffer) => {
	buffer += typeof chunk === "string" ? chunk : decoderForLines.decode(chunk);
	let newlineIndex: number;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line-splitting loop
	while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			handleFrame(JSON.parse(trimmed));
		} catch (error) {
			write({ type: "response", id: undefined, command: "parse", success: false, error: String(error) });
		}
	}
});
input.on("end", () => {
	stopStream();
	process.exit(0);
});
