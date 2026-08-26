// ═══════════════════════════════════════════════════════════════════════════
// Session model
// ═══════════════════════════════════════════════════════════════════════════

export type SessionStatus = "created" | "starting" | "running" | "stopped" | "error";

/** omp tool-approval tiers, set at spawn via `--approval-mode` (docs/approval-mode.md). */
export type ApprovalMode = "always-ask" | "write" | "yolo";

/** Session flavors surfaced in the UI. */
export type SessionKind = "assistant";

export interface SessionInfo {
	/** Server-assigned id (stable across restarts). */
	id: string;
	/** omp session name (resumed/created via `--session <name>`). */
	name: string;
	cwd: string;
	status: SessionStatus;
	model?: string;
	/** "assistant" = the omp-manages-omp config helper. */
	kind?: SessionKind;
	/** Set when the agent reported a startup error. */
	error?: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	lastPrompt?: string;
	pid?: number;
	/** omp session id (from get_state); used to resume across restarts. */
	ompSessionId?: string;
	/** omp session file path (from get_state). */
	sessionFile?: string;
	/** Tool approval tier this session's agent was spawned with. */
	approvalMode?: ApprovalMode;
}

export interface SessionSummary extends SessionInfo {
	/** Number of connected browser clients. */
	connections: number;
}

export interface SessionDetail extends SessionSummary {
	state?: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateSessionRequest {
	/** omp session name; defaults to a generated name. */
	name?: string;
	/** Working directory for the session. */
	cwd: string;
	/** Initial prompt sent right after the agent is ready. */
	prompt?: string;
	/** Initial model in "provider/modelId" form (optional). */
	model?: string;
	/** Tool approval tier passed to the agent at spawn (default: yolo). */
	approvalMode?: ApprovalMode;
	/** Spawn the omp assistant (config helper) in its seeded workspace. */
	assistant?: boolean;
}

export interface UpdateSessionRequest {
	name?: string;
}

export interface ApiError {
	error: string;
}

export interface SessionListResponse {
	sessions: SessionSummary[];
}

export interface SessionCreateResponse {
	session: SessionInfo;
}

export interface SessionGetResponse {
	session: SessionDetail;
}

export interface ModelsResponse {
	models: Array<{ provider: string; id: string }>;
}

export interface ServerInfoResponse {
	name: string;
	version: string;
	ompVersion?: string;
	defaultCwd: string;
	host: string;
	port: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket protocol
// ═══════════════════════════════════════════════════════════════════════════

/** Commands the browser sends over the session WebSocket. */
export type ClientCommand =
	| { type: "hello"; sessionId: string }
	/** Forward an RPC command to the agent; `id` correlates responses. */
	| { type: "rpc"; id?: string; command: string; [key: string]: unknown }
	/** Refresh the server-side session snapshot (replied with `session`). */
	| { type: "refresh_session" }
	/** Ask the server to stop the session's agent process. */
	| { type: "stop_session" };

/** Frames the server sends over the session WebSocket. */
export type ServerFrame =
	| { type: "hello_ack" }
	/** The agent emitted a frame (event / response / state). */
	| { type: "event"; frame: unknown }
	/** The agent process exited. */
	| { type: "process_exit"; code: number | null; signal: string | null }
	/** Server-side failure (bridge or protocol error). */
	| { type: "server_error"; message: string }
	/** Current session snapshot (reply to `refresh_session`, or on status change). */
	| { type: "session"; session: SessionInfo };

// ═══════════════════════════════════════════════════════════════════════════
// Public constants
// ═══════════════════════════════════════════════════════════════════════════

export const API_PREFIX = "/api";
