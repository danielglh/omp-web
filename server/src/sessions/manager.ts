/**
 * SessionManager — registry + process lifecycle for omp RPC sessions.
 *
 * Each web session maps to one `omp --mode rpc --session <name>` subprocess
 * running in the session's cwd. Records persist to `<dataDir>/sessions.json`
 * so sessions survive server restarts; the process is (re)spawned on demand.
 *
 * Frames from a process are fanned out through {@link SessionEvents.onFrame}
 * (the WS layer routes them). The last N frames are kept in a ring buffer so a
 * late joiner can re-sync recent live activity; full history comes from
 * `get_messages` (issued per-connection by the WS layer).
 */
import * as path from "node:path";
import type { ApprovalMode, SessionInfo, SessionKind, SessionStatus, SessionSummary } from "@omp-web/shared";
import { ensureAssistantWorkspace } from "../assistant";
import type { ServerConfig } from "../config";
import { deleteOmpSession } from "../fs";
import { sanitizeForwardedFrame, spawnOmpProcess } from "../rpc/process";

const APPROVAL_MODES = new Set(["always-ask", "write", "yolo"]);

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && APPROVAL_MODES.has(value);
}

interface SessionRecord {
	id: string;
	name: string;
	cwd: string;
	model?: string;
	approvalMode?: ApprovalMode;
	/** "assistant" sessions manage omp itself from a seeded workspace. */
	kind?: SessionKind;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	lastPrompt?: string;
	/** omp session id captured after a fresh new_session; used to resume. */
	ompSessionId?: string;
	/** True when this web session wraps pre-existing omp history (delete keeps the file). */
	resumedFromHistory?: boolean;
	sessionFile?: string;
}

interface SessionRuntime {
	status: SessionStatus;
	error?: string;
	pid?: number;
	process?: ReturnType<typeof spawnOmpProcess>;
	connections: Set<string>;
	/** Ring buffer of recent frames for late joiners. */
	frameBuffer: unknown[];
}

const FRAME_BUFFER_CAP = 400;

export class SessionManager {
	readonly #records = new Map<string, SessionRecord>();
	readonly #runtime = new Map<string, SessionRuntime>();
	readonly #config: ServerConfig;
	readonly #updateListeners = new Set<(session: SessionInfo) => void>();
	readonly #frameListeners = new Set<(sessionId: string, frame: unknown) => void>();
	#registryPath: string;
	#persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(config: ServerConfig) {
		this.#config = config;
		this.#registryPath = path.join(config.dataDir, "sessions.json");
	}

	/** Subscribe to session snapshot updates (broadcast on any status/field change). */
	onUpdate(listener: (session: SessionInfo) => void): () => void {
		this.#updateListeners.add(listener);
		return () => this.#updateListeners.delete(listener);
	}

	/** Subscribe to raw agent frames fanned out for a session. */
	onFrame(listener: (sessionId: string, frame: unknown) => void): () => void {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	}

	// ── persistence ──────────────────────────────────────────────────────────

	async load(): Promise<void> {
		try {
			const raw = await Bun.file(this.#registryPath).text();
			const parsed = JSON.parse(raw) as { sessions?: SessionRecord[] };
			for (const record of parsed.sessions ?? []) {
				if (record && typeof record.id === "string" && typeof record.cwd === "string") {
					this.#records.set(record.id, record);
				}
			}
		} catch {
			// No registry yet — first run.
		}
	}

	#schedulePersist(): void {
		clearTimeout(this.#persistTimer);
		this.#persistTimer = setTimeout(() => void this.#persist(), 250);
		this.#persistTimer.unref?.();
	}

	async #persist(): Promise<void> {
		try {
			await Bun.write(this.#registryPath, JSON.stringify({ sessions: [...this.#records.values()] }, null, "\t"));
		} catch (error) {
			console.error(`[omp-web] failed to persist session registry: ${error}`);
		}
	}

	// ── queries ──────────────────────────────────────────────────────────────

	list(): SessionSummary[] {
		const out: SessionSummary[] = [];
		for (const record of this.#records.values()) {
			out.push(this.#summary(record));
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): SessionInfo | undefined {
		const record = this.#records.get(id);
		if (!record) return undefined;
		return this.#info(record);
	}

	#runtimeFor(id: string): SessionRuntime {
		let runtime = this.#runtime.get(id);
		if (!runtime) {
			runtime = { status: "created", connections: new Set(), frameBuffer: [] };
			this.#runtime.set(id, runtime);
		}
		return runtime;
	}

	#info(record: SessionRecord): SessionInfo {
		const runtime = this.#runtimeFor(record.id);
		return {
			id: record.id,
			name: record.name,
			cwd: record.cwd,
			status: runtime.status,
			error: runtime.error,
			model: record.model,
			approvalMode: record.approvalMode,
			kind: record.kind,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			messageCount: record.messageCount,
			lastPrompt: record.lastPrompt,
			pid: runtime.pid,
			ompSessionId: record.ompSessionId,
			sessionFile: record.sessionFile,
		};
	}

	#summary(record: SessionRecord): SessionSummary {
		const info = this.#info(record);
		return { ...info, connections: this.#runtimeFor(record.id).connections.size };
	}

	// ── mutations ────────────────────────────────────────────────────────────

	async create(input: {
		name?: string;
		cwd: string;
		prompt?: string;
		model?: string;
		approvalMode?: ApprovalMode;
		/** Wrap an existing omp session (resume from the history browser). */
		resumeOmpSessionId?: string;
		/** Spawn the omp assistant in its seeded workspace instead. */
		assistant?: boolean;
	}): Promise<SessionInfo> {
		const effective = input.assistant
			? {
					...input,
					cwd: ensureAssistantWorkspace(this.#config.dataDir),
					name: input.name?.trim() || "omp assistant",
					prompt:
						input.prompt ??
						"Introduce yourself in one short paragraph: what you can configure, and 2-3 example asks.",
				}
			: input;
		const name = effective.name?.trim() || defaultSessionName(effective.cwd);
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const record: SessionRecord = {
			id,
			name,
			cwd: path.resolve(effective.cwd),
			model: effective.model,
			approvalMode: effective.approvalMode,
			kind: effective.assistant ? "assistant" : undefined,
			// Pre-seeded identity: spawn resumes it instead of minting a new one.
			// The omp session predates this web session, so deleting the wrapper
			// must not remove the underlying history file.
			...(effective.resumeOmpSessionId
				? { ompSessionId: effective.resumeOmpSessionId, resumedFromHistory: true }
				: {}),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messageCount: 0,
		};
		this.#records.set(id, record);
		this.#schedulePersist();
		const runtime = this.#runtimeFor(id);
		runtime.status = "starting";
		this.#emit(record);
		// Fire-and-forget spawn; the info() snapshot above already reports "starting".
		void this.#spawn(record, effective.prompt).catch(error => {
			runtime.status = "error";
			runtime.error = error instanceof Error ? error.message : String(error);
			this.#emit(record);
		});
		return this.#info(record);
	}

	async start(id: string, initialPrompt?: string): Promise<SessionInfo> {
		const record = this.#records.get(id);
		if (!record) throw new Error(`session ${id} not found`);
		const runtime = this.#runtimeFor(id);
		if (runtime.process) return this.#info(record);
		runtime.status = "starting";
		runtime.error = undefined;
		this.#emit(record);
		try {
			await this.#spawn(record, initialPrompt);
		} catch (error) {
			runtime.status = "error";
			runtime.error = error instanceof Error ? error.message : String(error);
			this.#emit(record);
			throw error;
		}
		return this.#info(record);
	}

	async #spawn(record: SessionRecord, initialPrompt?: string): Promise<void> {
		const runtime = this.#runtimeFor(record.id);
		if (runtime.process) return;

		let bin: string;
		let args: string[];
		if (this.#config.mockMode) {
			bin = process.execPath;
			args = ["run", this.#config.mockScriptPath, "--session", record.name];
		} else {
			bin = this.#config.ompBin;
			// Resume an existing omp session by its id; otherwise open the cwd's
			// default session and mint a fresh one via the new_session RPC below.
			args = [
				"--mode",
				"rpc",
				...(record.ompSessionId ? ["--session", record.ompSessionId] : []),
				// Approval tier is spawn-time only; interactive approvals then flow
				// through extension_ui_request selects handled by the web client.
				...(record.approvalMode && record.approvalMode !== "yolo" ? ["--approval-mode", record.approvalMode] : []),
				...this.#config.ompExtraArgs,
			];
		}

		// One-shot response watchers, consulted by both #onFrame and the init flow.
		const pendingWatchers = new Set<(frame: Record<string, unknown>) => boolean>();
		const ompProc = spawnOmpProcess({
			bin,
			args,
			cwd: record.cwd,
			onFrame: frame => {
				this.#onFrame(record, frame);
				if (isRecord(frame)) {
					for (const watcher of [...pendingWatchers]) {
						if (watcher(frame)) pendingWatchers.delete(watcher);
					}
				}
			},
			onStderr: chunk => {
				if (chunk.trim().length > 0) {
					console.error(`[omp-web] session ${record.id} stderr: ${chunk.trimEnd()}`);
				}
			},
			onExit: ({ code, signal }) => {
				runtime.process = undefined;
				runtime.status = "stopped";
				runtime.error =
					code === 0 || code === null ? undefined : `omp exited (code=${code}, signal=${signal ?? "none"})`;
				runtime.pid = undefined;
				// Interactive requests die with the process (omp rejects pending
				// dialogs on stdin close); replaying them to reconnecting clients
				// would render ghost "agent is waiting" dialogs for a fresh process.
				runtime.frameBuffer = runtime.frameBuffer.filter(frame => !isProcessScopedFrame(frame));
				this.#emit(record);
			},
		});
		runtime.process = ompProc;
		runtime.pid = ompProc.pid;

		await ompProc.ready;
		runtime.status = "running";
		this.#emit(record);

		if (!this.#config.mockMode) {
			const waitResponse = (
				command: string,
				opts: { id?: string; timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						pendingWatchers.delete(check);
						reject(new Error(`timed out waiting for ${command} response`));
					}, opts.timeoutMs ?? 20_000);
					const check = (frame: Record<string, unknown>): boolean => {
						if (frame.type === "response" && frame.command === command) {
							if (opts.id !== undefined && frame.id !== opts.id) return false;
							clearTimeout(timer);
							resolve(frame);
							return true;
						}
						return false;
					};
					pendingWatchers.add(check);
				});

			if (!record.ompSessionId) {
				// Fresh session: mint a new omp session, give it our display name,
				// and remember its id/file so we can resume later.
				ompProc.send({ type: "new_session" });
				const newSession = await waitResponse("new_session");
				if (isRecord(newSession.data) && newSession.data.cancelled === true) {
					throw new Error("omp refused to start a new session");
				}
				ompProc.send({ type: "set_session_name", name: record.name });
				await waitResponse("set_session_name");
				ompProc.send({ type: "get_state", id: "__init_state" });
				const initState = await waitResponse("get_state", { id: "__init_state" });
				const data = initState.data as { sessionId?: string; sessionFile?: string } | undefined;
				if (data?.sessionId) record.ompSessionId = data.sessionId;
				if (data?.sessionFile) record.sessionFile = data.sessionFile;
				this.#schedulePersist();
			} else {
				// Resumed session: re-apply the display name (idempotent) and
				// capture the session file so delete can clean it up.
				ompProc.send({ type: "set_session_name", name: record.name });
				void waitResponse("set_session_name").catch(() => {});
				ompProc.send({ type: "get_state", id: "__resume_state" });
				void waitResponse("get_state", { id: "__resume_state" })
					.then(frame => {
						const data = frame.data as { sessionFile?: string } | undefined;
						if (data?.sessionFile && data.sessionFile !== record.sessionFile) {
							record.sessionFile = data.sessionFile;
							this.#schedulePersist();
						}
					})
					.catch(() => {});
			}
		}

		if (initialPrompt) {
			record.lastPrompt = initialPrompt;
			this.#schedulePersist();
			ompProc.send({ type: "prompt", message: initialPrompt });
		}
	}

	async stop(id: string): Promise<void> {
		const runtime = this.#runtime.get(id);
		const process = runtime?.process;
		if (!process) {
			if (runtime) {
				runtime.status = "stopped";
				runtime.error = undefined;
			}
			const record = this.#records.get(id);
			if (record) this.#emit(record);
			return;
		}
		try {
			await process.close();
		} catch {
			process.kill("SIGKILL");
		}
	}

	async delete(id: string): Promise<void> {
		await this.stop(id);
		const record = this.#records.get(id);
		if (!record) return;
		// Delete the underlying omp session on disk (mirrors omp's `/session
		// delete` → dropSession → deleteSessionWithArtifacts), not just the
		// omp-web registry entry — unless the session was opened from the omp
		// history browser: that file is pre-existing user data, so only the
		// wrapper goes away.
		if (!this.#config.mockMode && record.sessionFile && !record.resumedFromHistory) {
			try {
				deleteOmpSession(record.sessionFile);
			} catch (error) {
				console.error(`[omp-web] failed to delete omp session ${record.sessionFile}: ${error}`);
			}
		}
		this.#records.delete(id);
		this.#runtime.delete(id);
		await this.#persist();
	}

	async update(id: string, patch: { name?: string }): Promise<SessionInfo> {
		const record = this.#records.get(id);
		if (!record) throw new Error(`session ${id} not found`);
		if (patch.name !== undefined && patch.name.trim().length > 0) {
			record.name = patch.name.trim();
			this.#schedulePersist();
		}
		this.#emit(record);
		return this.#info(record);
	}

	// ── connection plumbing ──────────────────────────────────────────────────

	/** Returns the buffered frames for a joining client. */
	bufferedFrames(id: string): unknown[] {
		return [...this.#runtimeFor(id).frameBuffer];
	}

	registerConnection(id: string, connId: string): void {
		const runtime = this.#runtimeFor(id);
		runtime.connections.add(connId);
		const record = this.#records.get(id);
		if (record) this.#emit(record);
	}

	unregisterConnection(id: string, connId: string): void {
		const runtime = this.#runtime.get(id);
		if (!runtime) return;
		runtime.connections.delete(connId);
		const record = this.#records.get(id);
		if (record) this.#emit(record);
	}

	/** Send a command to the agent (used by the WS layer for auto-hydration). */
	sendToProcess(id: string, command: object): boolean {
		const runtime = this.#runtime.get(id);
		const process = runtime?.process;
		if (!process) return false;
		process.send(command);
		return true;
	}

	/**
	 * Resolve a readable file path if it sits inside a known session's working
	 * directory (serves export_html downloads without opening an arbitrary
	 * file-read endpoint).
	 */
	resolveFileUnderSessionCwd(target: string): { ok: true; path: string } | { ok: false; reason: string } {
		const resolved = path.resolve(target);
		for (const record of this.#records.values()) {
			const cwd = path.resolve(record.cwd);
			if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
				return { ok: true, path: resolved };
			}
		}
		return { ok: false, reason: "path is outside any session working directory" };
	}

	/**
	 * Resolve once the session's agent process is ready (spawning in progress
	 * included). Returns `false` when the session has no process after `timeoutMs`.
	 */
	async waitReady(id: string, timeoutMs = 45_000): Promise<boolean> {
		const runtime = this.#runtime.get(id);
		const process = runtime?.process;
		if (!process) return false;
		if (runtime.status === "running") return true;
		try {
			await Promise.race([
				process.ready,
				new Promise<void>(resolve => {
					const timer = setTimeout(() => resolve(), timeoutMs);
					timer.unref?.();
				}),
			]);
			return runtime !== undefined && runtime.process !== undefined;
		} catch {
			return false;
		}
	}

	/** Forward a browser frame to the agent if whitelisted. */
	forward(id: string, frame: unknown): { ok: boolean; reason?: string } {
		const runtime = this.#runtime.get(id);
		const process = runtime?.process;
		if (!process) {
			return { ok: false, reason: "session not running" };
		}
		const sanitized = sanitizeForwardedFrame(frame);
		if (!sanitized) {
			return { ok: false, reason: "command not allowed" };
		}
		if (sanitized.type === "prompt" && typeof (sanitized as { message?: unknown }).message === "string") {
			const record = this.#records.get(id);
			if (record) {
				record.lastPrompt = (sanitized as { message: string }).message;
				record.updatedAt = Date.now();
				this.#schedulePersist();
			}
		}
		process.send(sanitized);
		return { ok: true };
	}

	// ── internals ────────────────────────────────────────────────────────────

	#onFrame(record: SessionRecord, frame: unknown): void {
		const runtime = this.#runtimeFor(record.id);
		// Track message count from terminal message events for the summary line.
		if (isRecord(frame) && frame.type === "message_end") {
			record.messageCount++;
			record.updatedAt = Date.now();
			this.#schedulePersist();
		}
		// branch/switch_session mint or move to a different omp session file:
		// re-read identity so the registry keeps resuming the right session.
		if (isRecord(frame) && frame.type === "response" && frame.success === true) {
			if (frame.command === "branch" || frame.command === "switch_session") {
				runtime.process?.send({ type: "get_state", id: "__identity_sync" });
			} else if (frame.id === "__identity_sync" && isRecord(frame.data)) {
				const data = frame.data as { sessionId?: string; sessionFile?: string };
				if (data.sessionId && (data.sessionId !== record.ompSessionId || data.sessionFile !== record.sessionFile)) {
					record.ompSessionId = data.sessionId;
					record.sessionFile = data.sessionFile;
					this.#schedulePersist();
					this.#emit(record);
				}
			}
		}
		if (frame && typeof frame === "object") {
			runtime.frameBuffer.push(frame);
			if (runtime.frameBuffer.length > FRAME_BUFFER_CAP) {
				runtime.frameBuffer.splice(0, runtime.frameBuffer.length - FRAME_BUFFER_CAP);
			}
		}
		for (const listener of this.#frameListeners) listener(record.id, frame);
	}

	#emit(record: SessionRecord): void {
		const info = this.#info(record);
		for (const listener of this.#updateListeners) listener(info);
	}

	async shutdown(): Promise<void> {
		const running = [...this.#runtime.values()].filter(r => r.process);
		await Promise.allSettled(running.map(r => r.process!.close(1_000)));
	}
}

function defaultSessionName(cwd: string): string {
	const base = path.basename(cwd) || "session";
	const date = new Date().toISOString().slice(0, 10);
	return `${base}-${date}`;
}

/**
 * Frames whose meaning is scoped to one agent process lifetime: interactive
 * extension dialogs (omp rejects them on stdin close) and host-tool/URI calls
 * (their pending state dies with the process). They must not be replayed to
 * clients reconnecting to a respawned process.
 */
function isProcessScopedFrame(frame: unknown): boolean {
	if (!isRecord(frame)) return false;
	if (frame.type === "host_tool_call" || frame.type === "host_uri_request") return true;
	if (frame.type !== "extension_ui_request") return false;
	const method = frame.method;
	return (
		method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "open_url"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
