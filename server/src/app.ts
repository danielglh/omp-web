import * as os from "node:os";
import * as path from "node:path";
import { API_PREFIX, type ClientCommand, type ServerFrame } from "@omp-web/shared";
/**
 * omp-web server application: REST API + session WebSocket + static web app.
 */
import type { ServerWebSocket } from "bun";
import {
	AUTH_COOKIE,
	AuthSessionStore,
	parseCookies,
	sessionCookieHeader,
	sessionPrefixFor,
	tokenEquals,
} from "./auth";
import type { ServerConfig } from "./config";
import { listDir, searchDir, searchPaths } from "./fs";
import { listOmpSessions, ompConfigList, ompConfigPath, ompConfigReset, ompConfigSet, ompModelList } from "./omp";
import { type SessionManager, isApprovalMode } from "./sessions/manager";
import { serveStatic } from "./static";

/** Representative config keys for mock mode (no omp CLI to call). */
function mockConfigEntries() {
	return [
		{ key: "modelRoles", value: {}, type: "record", description: "Model assignments per role" },
		{ key: "defaultThinkingLevel", value: "high", type: "enum", description: "Default thinking level" },
		{ key: "tools.approvalMode", value: "yolo", type: "enum", description: "Tool approval mode" },
		{ key: "compaction.enabled", value: true, type: "boolean", description: "Enable compaction" },
		{ key: "autoResume", value: false, type: "boolean", description: "Automatically resume the most recent session" },
	];
}

interface SessionConn {
	connId: string;
	socket: ServerWebSocket<ConnData>;
	/** Auto-hydration request ids issued for this connection (routed only to it). */
	autoStateId?: string;
	autoMessagesId?: string;
	autoModelsId?: string;
}

interface ConnData {
	sessionId: string;
	connId: string;
}

export interface AppDeps {
	config: ServerConfig;
	manager: SessionManager;
}

export function createApp(deps: AppDeps) {
	const { config, manager } = deps;
	const sessionConns = new Map<string, Map<string, SessionConn>>();

	// Auth: enabled iff an access token is configured. Sessions are server-side
	// (random values persisted to disk), so logout truly revokes and re-login
	// issues a fresh one; the value prefix ties sessions to the current token.
	const authRequired = config.authToken.length > 0;
	const authSessionPrefix = authRequired ? sessionPrefixFor(config.authToken) : "";
	const authSessions = new AuthSessionStore(config.dataDir);
	const isAuthed = (req: Request): boolean =>
		!authRequired || authSessions.has(authSessionPrefix, parseCookies(req.headers.get("cookie")).get(AUTH_COOKIE));

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const jsonError = (message: string, status = 400) => json({ error: message }, status);

	function ensureConns(sessionId: string): Map<string, SessionConn> {
		let map = sessionConns.get(sessionId);
		if (!map) {
			map = new Map();
			sessionConns.set(sessionId, map);
		}
		return map;
	}

	/** Existing connection table without creating one (read paths). */
	function peekConns(sessionId: string): Map<string, SessionConn> | undefined {
		return sessionConns.get(sessionId);
	}

	function connById(sessionId: string, connId: string): SessionConn | undefined {
		return sessionConns.get(sessionId)?.get(connId);
	}

	/**
	 * Cross-site state-change policy: browsers stamp Sec-Fetch-Site on every
	 * request they make, so a cross-site marker on a mutating request (or a
	 * WebSocket handshake) is a drive-by/CSRF attempt and gets dropped. Reads
	 * stay open: cross-origin JS cannot read the responses (no CORS headers),
	 * and plain links to downloads must keep working.
	 */
	function isCrossSite(req: Request): boolean {
		return req.headers.get("sec-fetch-site") === "cross-site";
	}

	function sendToConn(conn: SessionConn | undefined, frame: ServerFrame) {
		if (!conn || conn.socket.readyState !== 1) return;
		try {
			conn.socket.send(JSON.stringify(frame));
		} catch {
			// socket gone
		}
	}

	function sendToSession(sessionId: string, frame: ServerFrame, exceptConnId?: string) {
		const map = peekConns(sessionId);
		if (!map) return;
		for (const conn of map.values()) {
			if (conn.connId === exceptConnId) continue;
			sendToConn(conn, frame);
		}
	}

	// Route agent frames: auto-hydration responses go to their own connection;
	// everything else broadcasts to the session's connections.
	manager.onFrame((sessionId, frame) => {
		const map = peekConns(sessionId);
		if (!map || map.size === 0) return;
		if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string") {
			const id = frame.id as string;
			for (const conn of map.values()) {
				if (id === conn.autoStateId || id === conn.autoMessagesId || id === conn.autoModelsId) {
					sendToConn(conn, { type: "event", frame });
					return;
				}
			}
		}
		sendToSession(sessionId, { type: "event", frame });
	});

	// Broadcast session snapshot updates to that session's connections.
	manager.onUpdate(session => {
		sendToSession(session.id, { type: "session", session });
	});

	// ── WebSocket ────────────────────────────────────────────────────────────

	async function handleWebSocket(socket: ServerWebSocket<ConnData>) {
		const { sessionId, connId } = socket.data;
		const map = ensureConns(sessionId);
		const conn: SessionConn = { connId, socket };
		map.set(connId, conn);
		manager.registerConnection(sessionId, connId);
		socket.send(JSON.stringify({ type: "hello_ack" } satisfies ServerFrame));

		// Replay recent live frames so a mid-turn joiner isn't blank.
		for (const frame of manager.bufferedFrames(sessionId)) {
			socket.send(JSON.stringify({ type: "event", frame } satisfies ServerFrame));
		}

		// Hydrate: authoritative state + full message history + model list. If
		// the process is still spawning, wait for it; otherwise the client gets
		// the snapshot and re-hydrates once the session turns running.
		conn.autoStateId = `auto:state:${connId}`;
		conn.autoMessagesId = `auto:messages:${connId}`;
		conn.autoModelsId = `auto:models:${connId}`;
		const ready = await manager.waitReady(sessionId, 20_000);
		if (ready) {
			manager.sendToProcess(sessionId, { type: "get_state", id: conn.autoStateId });
			manager.sendToProcess(sessionId, { type: "get_messages", id: conn.autoMessagesId });
			manager.sendToProcess(sessionId, { type: "get_available_models", id: conn.autoModelsId });
		} else {
			const session = manager.get(sessionId);
			if (session) socket.send(JSON.stringify({ type: "session", session } satisfies ServerFrame));
		}
	}

	// ── HTTP routing ─────────────────────────────────────────────────────────

	async function handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// WebSocket upgrade.
		const wsMatch = /^\/ws\/sessions\/([A-Za-z0-9_-]+)$/.exec(pathname);
		if (wsMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
			if (isCrossSite(req)) return jsonError("cross-site request refused", 403);
			if (!isAuthed(req)) return jsonError("unauthorized", 401);
			const sessionId = wsMatch[1]!;
			if (!manager.get(sessionId)) return jsonError("session not found", 404);
			const connId = crypto.randomUUID();
			const upgraded = server.upgrade(req, { data: { sessionId, connId } satisfies ConnData });
			if (!upgraded) return jsonError("websocket upgrade failed", 426);
			return new Response(null, { status: 101 });
		}

		// REST API.
		if (pathname.startsWith(API_PREFIX)) {
			return handleApi(req, url);
		}

		// Static web app.
		return serveStatic(req, config.webDistDir);
	}

	async function handleApi(req: Request, url: URL): Promise<Response> {
		// Mutating methods from a cross-site context are drive-by/CSRF attempts.
		if (!["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase()) && isCrossSite(req)) {
			return jsonError("cross-site request refused", 403);
		}
		const parts = url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean);

		// Auth endpoints are the only routes reachable without a session cookie.
		if (parts[0] === "auth") {
			if (parts[1] === "logout" && req.method === "POST") {
				authSessions.revoke(parseCookies(req.headers.get("cookie")).get(AUTH_COOKIE));
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"set-cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
					},
				});
			}
			if (req.method === "GET") {
				// 200 = authed (or auth disabled); 401 = token required, not authed.
				if (!authRequired || isAuthed(req)) return json({ authRequired });
				return jsonError("unauthorized", 401);
			}
			if (req.method === "POST") {
				if (!authRequired) return json({ ok: true, authRequired: false });
				const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
				const token = typeof body?.token === "string" ? body.token : "";
				if (!token || !tokenEquals(token, config.authToken)) return jsonError("invalid token", 401);
				return new Response(JSON.stringify({ ok: true, authRequired: true }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"set-cookie": sessionCookieHeader(authSessions.issue(authSessionPrefix)),
					},
				});
			}
			return jsonError("method not allowed", 405);
		}

		if (!isAuthed(req)) return jsonError("unauthorized", 401);

		if (parts.length === 0) {
			if (req.method === "GET") {
				return json({
					name: "omp-web",
					version: "0.1.0",
					ompVersion: await detectOmpVersion(config.ompBin),
					defaultCwd: config.defaultCwd,
					host: config.host,
					port: config.port,
				});
			}
			return jsonError("method not allowed", 405);
		}

		if (parts[0] === "sessions") {
			if (parts.length === 1) {
				if (req.method === "GET") {
					return json({ sessions: manager.list() });
				}
				if (req.method === "POST") {
					let body: unknown;
					try {
						body = await req.json();
					} catch {
						return jsonError("invalid JSON body");
					}
					const b = body as {
						name?: string;
						cwd?: string;
						prompt?: string;
						model?: string;
						approvalMode?: unknown;
						resumeOmpSessionId?: unknown;
						assistant?: boolean;
					};
					if (typeof b.cwd !== "string" || b.cwd.trim().length === 0) {
						return jsonError("cwd is required");
					}
					if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
						return jsonError("approvalMode must be one of always-ask | write | yolo");
					}
					if (b.resumeOmpSessionId !== undefined && typeof b.resumeOmpSessionId !== "string") {
						return jsonError("resumeOmpSessionId must be a string");
					}
					const session = await manager.create({
						name: b.name,
						cwd: b.cwd,
						prompt: typeof b.prompt === "string" && b.prompt.trim() ? b.prompt : undefined,
						model: b.model,
						approvalMode: isApprovalMode(b.approvalMode) ? b.approvalMode : undefined,
						resumeOmpSessionId:
							typeof b.resumeOmpSessionId === "string" && b.resumeOmpSessionId.trim()
								? b.resumeOmpSessionId.trim()
								: undefined,
						assistant: b.assistant === true,
					});
					return json({ session }, 201);
				}
				return jsonError("method not allowed", 405);
			}

			const id = parts[1]!;
			if (parts.length === 2) {
				const session = manager.get(id);
				if (!session) return jsonError("session not found", 404);
				if (req.method === "GET") {
					return json({ session: { ...session, connections: peekConns(id)?.size ?? 0 } });
				}
				if (req.method === "DELETE") {
					await manager.delete(id);
					return json({ ok: true });
				}
				if (req.method === "PATCH") {
					let body: { name?: unknown } | undefined;
					try {
						body = (await req.json()) as { name?: unknown };
					} catch {
						return jsonError("invalid JSON body");
					}
					if (!body || typeof body !== "object") return jsonError("invalid JSON body");
					if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
						return jsonError("name must be a non-empty string");
					}
					const updated = await manager.update(id, {
						name: typeof body.name === "string" ? body.name : undefined,
					});
					return json({ session: updated });
				}
				return jsonError("method not allowed", 405);
			}

			if (parts.length === 3 && parts[2] === "start") {
				if (req.method !== "POST") return jsonError("method not allowed", 405);
				try {
					const session = await manager.start(id);
					return json({ session });
				} catch (error) {
					return jsonError(error instanceof Error ? error.message : String(error), 500);
				}
			}
			if (parts.length === 3 && parts[2] === "stop") {
				if (req.method !== "POST") return jsonError("method not allowed", 405);
				await manager.stop(id);
				return json({ session: manager.get(id) });
			}
			return jsonError("not found", 404);
		}

		if (parts[0] === "models" && req.method === "GET") {
			if (config.mockMode) {
				return json({
					models: [{ provider: "mock", id: "mock-model", name: "Mock Model" }],
				});
			}
			try {
				return json({ models: await ompModelList(config.ompBin) });
			} catch (error) {
				return jsonError(error instanceof Error ? error.message : String(error), 500);
			}
		}

		// omp config bridge (CLI-backed; no config RPC exists).
		if (parts[0] === "config") {
			if (parts.length === 1 && req.method === "GET") {
				if (config.mockMode) {
					return json({
						path: "/mock/.omp/agent",
						entries: mockConfigEntries(),
					});
				}
				try {
					const [entries, configPath] = await Promise.all([
						ompConfigList(config.ompBin),
						ompConfigPath(config.ompBin),
					]);
					return json({ path: configPath, entries });
				} catch (error) {
					return jsonError(error instanceof Error ? error.message : String(error), 500);
				}
			}
			if (parts.length === 1 && req.method === "PUT") {
				const body = (await req.json().catch(() => null)) as { key?: string; value?: string } | null;
				if (!body?.key || typeof body.value !== "string") {
					return jsonError("key and value (string) are required");
				}
				if (config.mockMode) return json({ ok: true });
				try {
					await ompConfigSet(config.ompBin, body.key, body.value);
					return json({ ok: true });
				} catch (error) {
					return jsonError(error instanceof Error ? error.message : String(error), 400);
				}
			}
			if (parts.length === 1 && req.method === "DELETE") {
				const key = url.searchParams.get("key") ?? "";
				if (!key) return jsonError("key is required");
				if (config.mockMode) return json({ ok: true });
				try {
					await ompConfigReset(config.ompBin, key);
					return json({ ok: true });
				} catch (error) {
					return jsonError(error instanceof Error ? error.message : String(error), 400);
				}
			}
			return jsonError("method not allowed", 405);
		}

		// Resumable omp sessions from ~/.omp/agent/sessions (matched by cwd).
		if (parts[0] === "omp-sessions" && req.method === "GET") {
			const cwd = url.searchParams.get("cwd") ?? config.defaultCwd;
			if (config.mockMode) {
				return json({
					sessions: [
						{
							file: "/mock/sessions/mock-1.jsonl",
							id: "mock-1",
							title: "mock history session",
							cwd,
							createdAt: Date.now() - 86_400_000,
							updatedAt: Date.now() - 3_600_000,
							sizeBytes: 2048,
						},
					],
				});
			}
			return json({ sessions: listOmpSessions(cwd) });
		}

		// Filesystem browsing for the working-directory picker (read-only).
		if (parts[0] === "fs") {
			if (parts[1] === "list" && req.method === "GET") {
				const p = url.searchParams.get("path") ?? undefined;
				const hidden = url.searchParams.get("hidden") === "1";
				try {
					return json(listDir(p, hidden));
				} catch (error) {
					return jsonError(error instanceof Error ? error.message : String(error), 400);
				}
			}
			if (parts[1] === "search" && req.method === "GET") {
				const prefix = url.searchParams.get("prefix") ?? "";
				return json(searchDir(prefix));
			}
			// Path completion (files + dirs) for the composer `@context` picker.
			// Defaults to the first session's cwd; sessions pass theirs explicitly.
			if (parts[1] === "paths" && req.method === "GET") {
				const prefix = url.searchParams.get("prefix") ?? "";
				const cwd = url.searchParams.get("cwd") ?? os.homedir();
				return json(searchPaths(prefix, cwd));
			}
			// File download restricted to session working directories
			// (export_html lands in the agent's cwd by default). Always delivered
			// as an attachment — inline HTML would execute agent-authored markup
			// on this origin; the sandbox CSP is belt-and-braces.
			if (parts[1] === "file" && req.method === "GET") {
				const target = url.searchParams.get("path") ?? "";
				if (!target) return jsonError("path is required");
				const resolved = manager.resolveFileUnderSessionCwd(target);
				if (!resolved.ok) return jsonError(resolved.reason, 403);
				const file = Bun.file(resolved.path);
				if (!(await file.exists())) return jsonError("file not found", 404);
				const isHtml = resolved.path.endsWith(".html");
				const filename = path.basename(resolved.path).replace(/["\\/\r\n]/g, "_");
				return new Response(file, {
					headers: {
						"content-type": isHtml ? "text/html; charset=utf-8" : "application/octet-stream",
						"content-disposition": `attachment; filename="${filename}"`,
						...(isHtml ? { "content-security-policy": "sandbox" } : {}),
					},
				});
			}
			return jsonError("not found", 404);
		}

		return jsonError("not found", 404);
	}

	// ── server ───────────────────────────────────────────────────────────────

	const server = Bun.serve<ConnData>({
		hostname: config.host,
		port: config.port,
		fetch: handleRequest,
		websocket: {
			open(ws: ServerWebSocket<ConnData>) {
				handleWebSocket(ws);
			},
			message(ws: ServerWebSocket<ConnData>, message) {
				handleWsMessage(ws, message);
			},
			close(ws: ServerWebSocket<ConnData>) {
				const { sessionId, connId } = ws.data;
				peekConns(sessionId)?.delete(connId);
				manager.unregisterConnection(sessionId, connId);
			},
		},
	});

	function handleWsMessage(ws: ServerWebSocket<ConnData>, raw: string | Buffer) {
		const { sessionId } = ws.data;
		let msg: unknown;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
		} catch {
			sendToConn(connById(sessionId, ws.data.connId), {
				type: "server_error",
				message: "invalid JSON message",
			});
			return;
		}
		const command = msg as Partial<ClientCommand>;
		switch (command.type) {
			case "rpc": {
				// Drop the envelope fields (type/id/command); the inner command
				// name lives in `command` and the rest is its payload.
				const { type: _envelopeType, id, command: name, ...rest } = command as Record<string, unknown>;
				const result = manager.forward(sessionId, { type: name, id, ...rest });
				if (!result.ok) {
					sendToConn(connById(sessionId, ws.data.connId), {
						type: "server_error",
						message: result.reason ?? "failed to forward command",
					});
				}
				break;
			}
			case "stop_session":
				void manager.stop(sessionId);
				break;
			case "hello":
				// Client connection handshake. The connection is already fully
				// set up in the `open` handler (which sends `hello_ack`), so this
				// is just an acknowledgment — ignore it.
				break;
			case "refresh_session": {
				const session = manager.get(sessionId);
				if (session) sendToConn(connById(sessionId, ws.data.connId), { type: "session", session });
				break;
			}
			default:
				sendToConn(connById(sessionId, ws.data.connId), {
					type: "server_error",
					message: `unknown command: ${String(command?.type)}`,
				});
		}
	}

	return { server, address: server.hostname, port: server.port };
}

/** Successful version lookups are memoized per binary; failures retry. */
const ompVersionCache = new Map<string, string>();

async function detectOmpVersion(bin: string): Promise<string | undefined> {
	const cached = ompVersionCache.get(bin);
	if (cached !== undefined) return cached;
	try {
		const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
		const text = await new Response(proc.stdout).text();
		const first = text.trim().split("\n")[0];
		if (first) ompVersionCache.set(bin, first);
		return first || undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
