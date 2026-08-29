/**
 * Browser-side API client: REST for CRUD, WebSocket for live session traffic.
 *
 * The session store keeps a per-session transcript + agent state derived from
 * RPC frames, exposed through `useSyncExternalStore` snapshots. Every update
 * replaces the snapshot object (immutable), so React re-renders reliably.
 */
import type {
	ClientCommand,
	ServerFrame,
	SessionInfo,
	SessionSummary,
	WireAssistantMessage,
	WireExtensionUiRequest,
	WireMessage,
	WireRpcResponse,
	WireSessionState,
	WireSubagentSnapshot,
} from "@omp-web/shared";
import { isHttpUrl } from "./lib/url";

/** SessionStats from the get_session_stats RPC. */
export interface SessionStats {
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
}

// ═══════════════════════════════════════════════════════════════════════════
// REST
// ═══════════════════════════════════════════════════════════════════════════

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	if (!res.ok) {
		if (res.status === 401) {
			// Session cookie expired/revoked — flip the app back to the auth gate.
			window.dispatchEvent(new Event("omp-web:unauthorized"));
		}
		let message = `${res.status} ${res.statusText}`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// non-JSON error body
		}
		throw new Error(message);
	}
	return (await res.json()) as T;
}

export const api = {
	/**
	 * true = access granted (or auth disabled). Only a definitive 401 gates the
	 * app; transient server errors fall through so the normal in-app error UI
	 * handles them (a mid-session 401 re-gates via the unauthorized event).
	 */
	authCheck: async (): Promise<boolean> => {
		try {
			const res = await fetch("/api/auth");
			return res.status !== 401;
		} catch {
			return true;
		}
	},
	/** Exchange the access token for a session cookie. Throws on wrong token. */
	authLogin: async (token: string): Promise<void> => {
		const res = await fetch("/api/auth", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		if (res.status === 401) throw new Error("invalid token");
		if (!res.ok) throw new Error(`login failed (${res.status})`);
	},
	// NOTE: logout lives in lib/logout.ts (logoutDeterminesGate) — the button
	// needs the follow-up auth probe to decide whether to re-gate.
	listSessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions").then(r => r.sessions),
	createSession: (input: {
		name?: string;
		cwd: string;
		prompt?: string;
		model?: string;
		approvalMode?: string;
		resumeOmpSessionId?: string;
		assistant?: boolean;
	}) =>
		request<{ session: SessionInfo }>("/api/sessions", {
			method: "POST",
			body: JSON.stringify(input),
		}).then(r => r.session),
	getSession: (id: string) => request<{ session: SessionSummary }>(`/api/sessions/${id}`).then(r => r.session),
	deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
	startSession: (id: string) =>
		request<{ session: SessionInfo }>(`/api/sessions/${id}/start`, { method: "POST" }).then(r => r.session),
	stopSession: (id: string) =>
		request<{ session: SessionInfo }>(`/api/sessions/${id}/stop`, { method: "POST" }).then(r => r.session),
	renameSession: (id: string, name: string) =>
		request<{ session: SessionInfo }>(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}).then(r => r.session),
	serverInfo: () => request<import("@omp-web/shared").ServerInfoResponse>("/api"),
	fsList: (pathname?: string, showHidden = false) => {
		const params = new URLSearchParams();
		if (pathname) params.set("path", pathname);
		if (showHidden) params.set("hidden", "1");
		const qs = params.toString();
		return request<{ path: string; parent: string | null; dirs: string[] }>(`/api/fs/list${qs ? `?${qs}` : ""}`);
	},
	fsSearch: (prefix: string) =>
		request<{ prefix: string; matches: string[] }>(`/api/fs/search?prefix=${encodeURIComponent(prefix)}`),
	fsEntries: (path: string) =>
		request<{ path: string; entries: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> }>(
			`/api/fs/entries?path=${encodeURIComponent(path)}`,
		),
	fsPreview: (path: string) =>
		request<{ kind: "text" | "image" | "binary"; mime: string; size: number; truncated: boolean; text?: string }>(
			`/api/fs/preview?path=${encodeURIComponent(path)}`,
		),
	fsRawUrl: (path: string) => `/api/fs/raw?path=${encodeURIComponent(path)}`,
	fsDownloadUrl: (path: string) => `/api/fs/file?download=1&path=${encodeURIComponent(path)}`,
	fsPaths: (prefix: string, cwd?: string) => {
		const params = new URLSearchParams({ prefix });
		if (cwd) params.set("cwd", cwd);
		return request<{ prefix: string; matches: string[] }>(`/api/fs/paths?${params.toString()}`);
	},
	// ── omp config / catalog / history (CLI-backed server routes) ─────────────
	getConfig: () =>
		request<{ path: string; entries: Array<{ key: string; value?: unknown; type: string; description?: string }> }>(
			"/api/config",
		),
	setConfig: (key: string, value: string) =>
		request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify({ key, value }) }),
	resetConfig: (key: string) =>
		request<{ ok: boolean }>(`/api/config?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
	getModels: () =>
		request<{ models: Array<{ provider: string; id: string; name?: string }> }>("/api/models").then(r => r.models),
	listOmpSessions: (cwd: string) =>
		request<{
			sessions: Array<{
				file: string;
				id: string;
				title?: string;
				cwd?: string;
				createdAt?: number;
				updatedAt: number;
				sizeBytes: number;
			}>;
		}>(`/api/omp-sessions?cwd=${encodeURIComponent(cwd)}`).then(r => r.sessions),
};

// ═══════════════════════════════════════════════════════════════════════════
// Session store (WebSocket)
// ═══════════════════════════════════════════════════════════════════════════

export interface RenderedMessage {
	key: string;
	role: "user" | "assistant";
	message: WireMessage;
	/** True while the agent is still streaming this message. */
	streaming: boolean;
}

export interface ToolExecution {
	status: "running" | "done";
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
	intent?: string;
	startedAt: number;
}

export interface NoticeEntry {
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
	at: number;
}

export interface SessionSnapshot {
	/** Connection lifecycle. */
	phase: "connecting" | "connected" | "disconnected";
	error?: string;
	session?: SessionInfo;
	state?: WireSessionState;
	messages: RenderedMessage[];
	toolExecutions: Map<string, ToolExecution>;
	subagents: WireSubagentSnapshot[];
	notices: NoticeEntry[];
	/** Models offered by the agent (from get_available_models). */
	availableModels: Array<{ id: string; name: string; provider: string }>;
	/** Slash commands the agent supports (from available_commands_update). */
	availableCommands: Array<{ name: string; description?: string; source?: string }>;
	/** Unanswered interactive extension-UI requests (oldest first). */
	extensionRequests: Array<WireExtensionUiRequest & { receivedAt?: number }>;
	/** Persistent extension widgets (setWidget), keyed by widgetKey. */
	widgets: Record<string, { lines: string[]; placement?: string }>;
	/** Persistent status-line entries (setStatus), keyed by statusKey. */
	statusEntries: Record<string, string>;
	/** open_url requests (login flows) not yet dismissed. Identified by a
	 * monotonic id — millisecond timestamps can collide. */
	openUrls: Array<{ id: number; at: number; url: string; launchUrl?: string; instructions?: string }>;
	/** Text output from local slash commands (command_output frames). */
	commandOutputs: Array<{ at: number; text: string }>;
	/** Composer prefill pushed by the agent (set_editor_text); seq bumps on change. */
	editorText?: { text: string; seq: number };
	/** Latest get_session_stats response (fetched on demand). */
	sessionStats?: SessionStats;
	/** Path of the last export_html output (agent-side). */
	exportPath?: string;
	/** OAuth providers and their auth state (get_login_providers). */
	loginProviders: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
}

function sameMessage(a: WireMessage, b: WireMessage): boolean {
	if (a.role !== b.role || a.timestamp !== b.timestamp) return false;
	if (a.role === "assistant" && b.role === "assistant") {
		return (a as WireAssistantMessage).model === (b as WireAssistantMessage).model;
	}
	return true;
}

/** Monotonic id for agent-pushed open_url cards (timestamps can collide). */
let openUrlSeq = 0;

export const emptySnapshot = (): SessionSnapshot => ({
	phase: "connecting",
	messages: [],
	toolExecutions: new Map(),
	subagents: [],
	notices: [],
	availableModels: [],
	availableCommands: [],
	extensionRequests: [],
	widgets: {},
	statusEntries: {},
	openUrls: [],
	commandOutputs: [],
	loginProviders: [],
});

export interface SessionStoreOptions {
	/** Endpoint override (tests inject this instead of touching `location`). */
	socketUrl?: (sessionId: string) => string;
	/** Socket construction override (tests inject a fake transport). */
	socketFactory?: (url: string) => WebSocket;
}

function defaultSocketUrl(sessionId: string): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/ws/sessions/${sessionId}`;
}

export class SessionStore {
	readonly sessionId: string;
	#listeners = new Set<() => void>();
	#snapshot: SessionSnapshot;
	#ws: WebSocket | undefined;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#reconnectAttempts = 0;
	#closed = false;
	/** Committed history (from get_messages). */
	#historyMessages: RenderedMessage[] = [];
	/** In-flight streaming slots (from message_start/update/end). */
	#liveMessages: RenderedMessage[] = [];
	#historyApplied = false;
	readonly #socketUrl: (sessionId: string) => string;
	readonly #socketFactory: (url: string) => WebSocket;

	constructor(sessionId: string, options: SessionStoreOptions = {}) {
		this.sessionId = sessionId;
		this.#socketUrl = options.socketUrl ?? defaultSocketUrl;
		this.#socketFactory = options.socketFactory ?? (url => new WebSocket(url));
		this.#snapshot = emptySnapshot();
		this.connect();
	}

	// ── store plumbing ───────────────────────────────────────────────────────

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): SessionSnapshot => this.#snapshot;

	#emit() {
		for (const listener of this.#listeners) listener();
	}

	/** Immutable update: always assigns a fresh snapshot object so React re-renders. */
	#mutate(fn: (draft: SessionSnapshot) => void) {
		const draft: SessionSnapshot = {
			...this.#snapshot,
			// Copy mutable containers so in-place edits never alias the old snapshot.
			toolExecutions: new Map(this.#snapshot.toolExecutions),
			subagents: [...this.#snapshot.subagents],
			notices: [...this.#snapshot.notices],
		};
		fn(draft);
		this.#snapshot = draft;
		this.#emit();
	}

	/** Rebuild the visible transcript from history + live slots. */
	#rebuildMessages() {
		this.#mutate(s => {
			s.messages = [...this.#historyMessages, ...this.#liveMessages];
		});
	}

	close() {
		this.#closed = true;
		clearTimeout(this.#reconnectTimer);
		this.#ws?.close();
	}

	// ── connection ───────────────────────────────────────────────────────────

	connect() {
		if (this.#closed) return;
		this.#mutate(s => {
			s.phase = "connecting";
			s.error = undefined;
		});
		const ws = this.#socketFactory(this.#socketUrl(this.sessionId));
		this.#ws = ws;

		ws.onopen = () => {
			this.#reconnectAttempts = 0;
			this.#mutate(s => {
				s.phase = "connected";
			});
			ws.send(JSON.stringify({ type: "hello", sessionId: this.sessionId } satisfies ClientCommand));
		};

		ws.onmessage = (event: MessageEvent) => {
			let frame: ServerFrame;
			try {
				frame = JSON.parse(String(event.data)) as ServerFrame;
			} catch {
				return;
			}
			this.#onServerFrame(frame);
		};

		ws.onclose = () => {
			if (this.#closed) return;
			this.#mutate(s => {
				s.phase = "disconnected";
				s.error = "connection lost — reconnecting…";
			});
			const delay = Math.min(1_000 * 2 ** this.#reconnectAttempts, 15_000);
			this.#reconnectAttempts++;
			this.#reconnectTimer = setTimeout(() => this.connect(), delay);
		};

		ws.onerror = () => {
			// onclose follows; nothing to do here.
		};
	}

	sendCommand(command: { type: string } & Record<string, unknown>) {
		if (this.#ws?.readyState !== WebSocket.OPEN) {
			this.#mutate(s => {
				s.error = "not connected";
			});
			return;
		}
		// The wire envelope is { type: "rpc", command: <rpc type>, ...payload }.
		const { type, ...payload } = command;
		this.#ws.send(JSON.stringify({ type: "rpc", command: type, ...payload } satisfies ClientCommand));
	}

	// ── frame handling ───────────────────────────────────────────────────────

	#onServerFrame(frame: ServerFrame) {
		switch (frame.type) {
			case "event":
				this.#onAgentFrame(frame.frame as Record<string, unknown>);
				break;
			case "session":
				this.#mutate(s => {
					s.session = frame.session;
				});
				// The agent came alive after we connected (e.g. the user clicked
				// start): hydrate if we never got history.
				if (frame.session.status === "running" && !this.#historyApplied) {
					this.sendCommand({ type: "get_state", id: "ui:state" });
					this.sendCommand({ type: "get_messages", id: "ui:messages" });
					this.sendCommand({ type: "get_available_models", id: "ui:models" });
					this.sendCommand({ type: "get_available_commands", id: "ui:commands" });
					// Live subagent frames are opt-in; default is "off".
					this.sendCommand({ type: "set_subagent_subscription", level: "events" });
				}
				break;
			case "process_exit":
				this.#mutate(s => {
					s.phase = "disconnected";
					s.error = `agent process exited (code=${frame.code}, signal=${frame.signal ?? "none"})`;
				});
				break;
			case "server_error":
				this.#mutate(s => {
					s.error = frame.message;
				});
				break;
			case "hello_ack":
				break;
		}
	}

	#onAgentFrame(frame: Record<string, unknown>) {
		const type = frame.type as string;

		switch (type) {
			case "response": {
				this.#onRpcResponse(frame as unknown as WireRpcResponse);
				break;
			}
			case "message_start":
			case "message_update": {
				const message = frame.message as WireMessage;
				this.#upsertLive(message, true);
				this.#rebuildMessages();
				break;
			}
			case "message_end": {
				const message = frame.message as WireMessage;
				this.#upsertLive(message, false);
				this.#rebuildMessages();
				break;
			}
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				const toolCallId = frame.toolCallId as string;
				this.#mutate(s => {
					// Replace the Map and the entry (never mutate in place) so each
					// snapshot stays immutable for memoized consumers.
					const next = new Map(s.toolExecutions);
					const existing = s.toolExecutions.get(toolCallId);
					if (type === "tool_execution_start") {
						next.set(toolCallId, {
							status: "running",
							toolCallId,
							toolName: frame.toolName as string,
							args: frame.args,
							intent: frame.intent as string | undefined,
							startedAt: Date.now(),
						});
					} else if (existing) {
						next.set(
							toolCallId,
							type === "tool_execution_update"
								? { ...existing, result: frame.partialResult }
								: { ...existing, status: "done", result: frame.result, isError: frame.isError === true },
						);
					} else if (type === "tool_execution_end") {
						// End without a witnessed start (mid-tool joiner): synthesize.
						next.set(toolCallId, {
							status: "done",
							toolCallId,
							toolName: frame.toolName as string,
							args: frame.args,
							result: frame.result,
							isError: frame.isError === true,
							startedAt: Date.now(),
						});
					}
					s.toolExecutions = next;
				});
				break;
			}
			case "notice": {
				this.#mutate(s => {
					s.notices = [
						...s.notices.slice(-60),
						{
							level: frame.level as NoticeEntry["level"],
							message: frame.message as string,
							source: frame.source as string | undefined,
							at: Date.now(),
						},
					];
				});
				break;
			}
			case "subagent_snapshot": {
				this.#mutate(s => {
					s.subagents = (frame.subagents as WireSubagentSnapshot[]) ?? [];
				});
				break;
			}
			case "subagent_progress": {
				const snap = frame.snapshot as WireSubagentSnapshot;
				if (snap?.id) {
					this.#mutate(s => {
						const index = s.subagents.findIndex(a => a.id === snap.id);
						if (index >= 0) s.subagents[index] = snap;
						else s.subagents.push(snap);
					});
				}
				break;
			}
			case "subagent_lifecycle": {
				// Full snapshots arrive via subagent_snapshot; ask for a fresh one.
				this.sendCommand({ type: "get_subagents" });
				break;
			}
			case "agent_start":
			case "turn_start":
				this.#mutate(s => {
					s.state = { ...(s.state ?? ({} as WireSessionState)), isStreaming: true } as WireSessionState;
				});
				break;
			case "agent_end":
			case "turn_end":
				this.#mutate(s => {
					s.state = { ...(s.state ?? ({} as WireSessionState)), isStreaming: false } as WireSessionState;
				});
				break;
			case "model_changed":
				this.sendCommand({ type: "get_state", id: "ui:state" });
				break;
			case "thinking_level_changed": {
				const level = frame.thinkingLevel;
				this.#mutate(s => {
					if (s.state) s.state.thinkingLevel = level as string | undefined;
				});
				break;
			}
			case "available_commands_update": {
				this.#mutate(s => {
					s.availableCommands = ((
						frame as { commands?: Array<{ name: string; description?: string; source?: string }> }
					).commands ?? []) as SessionSnapshot["availableCommands"];
				});
				break;
			}
			case "extension_ui_request": {
				this.#onExtensionUiRequest(frame as unknown as WireExtensionUiRequest);
				break;
			}
			case "command_output": {
				this.#mutate(s => {
					s.commandOutputs = [...s.commandOutputs.slice(-29), { at: Date.now(), text: frame.text as string }];
				});
				break;
			}
			case "session_info_update": {
				const title = frame.title as string | undefined;
				if (title) {
					this.#mutate(s => {
						if (s.session) s.session = { ...s.session, name: title };
						if (s.state) s.state = { ...s.state, sessionName: title };
					});
				}
				break;
			}
			case "config_update": {
				// Model/thinking changed server-side; refetch authoritative state.
				this.sendCommand({ type: "get_state", id: "ui:state" });
				break;
			}
			case "extension_error": {
				this.#mutate(s => {
					s.notices = [
						...s.notices.slice(-60),
						{
							level: "error",
							message: `${frame.extensionPath ?? "extension"} ${frame.event ?? ""}: ${frame.error ?? "error"}`,
							source: "extension",
							at: Date.now(),
						},
					];
				});
				break;
			}
			default:
				break;
		}
	}

	/** RPC responses are handled by command name, regardless of correlation id. */
	#onRpcResponse(resp: WireRpcResponse) {
		if (resp.command === "parse") return;
		if (resp.success !== true) {
			// Surface agent-side rejections (e.g. "Fast mode is unavailable for the
			// current model") as notices — otherwise the click silently no-ops.
			this.#mutate(s => {
				s.notices = [
					...s.notices.slice(-60),
					{
						level: "warning",
						message: `${resp.command}: ${resp.error ?? "failed"}`,
						source: "rpc",
						at: Date.now(),
					},
				];
			});
			return;
		}
		switch (resp.command) {
			case "get_state":
				this.#mutate(s => {
					s.state = resp.data as WireSessionState;
				});
				break;
			case "get_messages":
				this.#applyHistory(resp.data as { messages: WireMessage[] });
				break;
			case "get_available_models":
				this.#mutate(s => {
					s.availableModels = ((resp.data as { models?: Array<{ id: string; name: string; provider: string }> })
						?.models ?? []) as SessionSnapshot["availableModels"];
				});
				break;
			case "get_available_commands":
				this.#mutate(s => {
					s.availableCommands = ((resp.data as { commands?: SessionSnapshot["availableCommands"] })?.commands ??
						[]) as SessionSnapshot["availableCommands"];
				});
				break;
			case "get_session_stats":
				this.#mutate(s => {
					s.sessionStats = resp.data as SessionStats;
				});
				break;
			case "get_login_providers":
				this.#mutate(s => {
					s.loginProviders = ((resp.data as { providers?: SessionSnapshot["loginProviders"] })?.providers ??
						[]) as SessionSnapshot["loginProviders"];
				});
				break;
			case "login":
				// Auth state changed globally; refresh the provider list.
				this.sendCommand({ type: "get_login_providers", id: "ui:providers" });
				break;
			case "export_html": {
				const path = (resp.data as { path?: string } | undefined)?.path;
				if (path) {
					this.#mutate(s => {
						s.notices = [
							...s.notices.slice(-60),
							{
								level: "info",
								message: `exported to ${path}`,
								source: "export",
								at: Date.now(),
							},
						];
						s.exportPath = path;
					});
				}
				break;
			}
			default:
				break;
		}
	}

	/** Extension UI sub-protocol: interactive dialogs + passive surfaces. */
	#onExtensionUiRequest(frame: WireExtensionUiRequest) {
		switch (frame.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				this.#mutate(s => {
					// Replace an existing request with the same id (replay/refresh).
					s.extensionRequests = [
						...s.extensionRequests.filter(r => r.id !== frame.id),
						{ ...frame, receivedAt: Date.now() },
					];
				});
				break;
			case "cancel":
				this.#mutate(s => {
					s.extensionRequests = s.extensionRequests.filter(r => r.id !== frame.targetId);
				});
				break;
			case "notify":
				this.#mutate(s => {
					s.notices = [
						...s.notices.slice(-60),
						{
							level:
								frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warning" : "info",
							message: frame.message,
							source: "extension",
							at: Date.now(),
						},
					];
				});
				break;
			case "setStatus":
				this.#mutate(s => {
					const next = { ...s.statusEntries };
					if (frame.statusText === undefined) delete next[frame.statusKey];
					else next[frame.statusKey] = frame.statusText;
					s.statusEntries = next;
				});
				break;
			case "setWidget":
				this.#mutate(s => {
					const next = { ...s.widgets };
					if (frame.widgetLines === undefined) delete next[frame.widgetKey];
					else next[frame.widgetKey] = { lines: frame.widgetLines, placement: frame.widgetPlacement };
					s.widgets = next;
				});
				break;
			case "set_editor_text":
				this.#mutate(s => {
					s.editorText = { text: frame.text, seq: (s.editorText?.seq ?? 0) + 1 };
				});
				break;
			case "open_url": {
				this.#mutate(s => {
					const id = ++openUrlSeq;
					s.openUrls = [
						...s.openUrls.slice(-2),
						{ id, at: Date.now(), url: frame.url, launchUrl: frame.launchUrl, instructions: frame.instructions },
					];
				});
				// Agent-supplied URL: only absolute http(s) may auto-open. Anything
				// else still surfaces in the card so the user can inspect it.
				if (isHttpUrl(frame.url)) {
					// Best effort; popup blockers leave the rendered link as fallback.
					window.open(frame.url, "_blank", "noopener");
				}
				break;
			}
			// setTitle is TUI-terminal-title only; nothing to do on the web.
			default:
				break;
		}
	}

	/** Answer an interactive extension UI request (side-channel; overtakes queue). */
	answerExtensionRequest(
		id: string,
		answer: { value: string } | { confirmed: boolean } | { cancelled: true; timedOut?: boolean },
	) {
		this.sendCommand({ type: "extension_ui_response", id, ...answer });
		this.#mutate(s => {
			s.extensionRequests = s.extensionRequests.filter(r => r.id !== id);
		});
	}

	/** Dismiss a rendered open_url link (login flow). */
	dismissOpenUrl(id: number) {
		this.#mutate(s => {
			s.openUrls = s.openUrls.filter(link => link.id !== id);
		});
	}

	/** Fetch session stats into the snapshot (context panel). */
	fetchSessionStats() {
		this.sendCommand({ type: "get_session_stats", id: "ui:stats" });
	}

	/** Export the session to HTML on the server; returns via ui:export response. */
	exportHtml() {
		this.sendCommand({ type: "export_html", id: "ui:export" });
	}

	/** Load OAuth providers + auth state (providers tab). */
	fetchLoginProviders() {
		this.sendCommand({ type: "get_login_providers", id: "ui:providers" });
	}

	/** Start the login flow; open_url + input dialogs arrive via extension UI. */
	loginProvider(providerId: string) {
		this.sendCommand({ type: "login", providerId, id: "ui:login" });
	}

	/**
	 * Insert or replace the live slot for a message (matched by role +
	 * timestamp — same identity `sameMessage` uses for history). A timestamp
	 * alone is not an identity: a user echo and the assistant reply can share
	 * one, and matching on it alone would let one message swallow the other.
	 */
	#upsertLive(message: WireMessage, streaming: boolean) {
		const role: RenderedMessage["role"] = message.role === "user" ? "user" : "assistant";
		const entry: RenderedMessage = { key: `live-${role}-${message.timestamp}`, role, message, streaming };
		const index = this.#liveMessages.findIndex(m => m.role === role && m.message.timestamp === message.timestamp);
		if (index >= 0) {
			this.#liveMessages[index] = entry;
		} else {
			this.#liveMessages.push(entry);
		}
	}

	#applyHistory(data: { messages: WireMessage[] } | undefined) {
		const history = (data?.messages ?? []) as WireMessage[];
		// Keep live messages not already present in history (in-flight turn).
		this.#liveMessages = this.#liveMessages.filter(m => !history.some(h => sameMessage(h, m.message)));
		this.#historyMessages = history.map((message, index) => ({
			key: `h-${message.timestamp}-${index}`,
			role: (message.role === "user" ? "user" : "assistant") as RenderedMessage["role"],
			message,
			streaming: false,
		}));
		this.#historyApplied = true;
		this.#rebuildMessages();
	}
}

// ── store registry ──────────────────────────────────────────────────────────
//
// Stores are reference-counted so a session's WebSocket lives exactly as long
// as some React tree owns it: every acquire must be paired with one release,
// and the final release closes the socket and drops the snapshot.

const stores = new Map<string, SessionStore>();
const storeRefs = new Map<string, number>();

/** Take ownership of the session's store, creating it on first use. */
export function acquireSessionStore(sessionId: string, options?: SessionStoreOptions): SessionStore {
	storeRefs.set(sessionId, (storeRefs.get(sessionId) ?? 0) + 1);
	let store = stores.get(sessionId);
	if (!store) {
		store = new SessionStore(sessionId, options);
		stores.set(sessionId, store);
	}
	return store;
}

/** Drop one ownership reference; the last release closes the connection. */
export function releaseSessionStore(sessionId: string): void {
	const remaining = (storeRefs.get(sessionId) ?? 0) - 1;
	if (remaining > 0) {
		storeRefs.set(sessionId, remaining);
		return;
	}
	storeRefs.delete(sessionId);
	const store = stores.get(sessionId);
	if (store) {
		store.close();
		stores.delete(sessionId);
	}
}
