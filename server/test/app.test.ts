/**
 * End-to-end integration test for the omp-web server, using the bundled mock
 * RPC host (no real omp needed). Covers session CRUD, WebSocket bridge,
 * auto-hydration (state + messages), prompt streaming, and process lifecycle.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { SessionManager } from "../src/sessions/manager";

interface TestContext {
	baseUrl: string;
	manager: SessionManager;
	stop: () => Promise<void>;
}

let ctx: TestContext;
let tempDir: string;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-test-"));
	const config = loadConfig({
		dataDir: tempDir,
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: tempDir,
	});
	const manager = new SessionManager(config);
	await manager.load();
	const { server } = createApp({ config, manager });
	const port = server.port;
	ctx = {
		baseUrl: `http://127.0.0.1:${port}`,
		manager,
		stop: () => manager.shutdown(),
	};
});

afterAll(async () => {
	await ctx.stop();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function jsonRequest(pathname: string, init?: RequestInit): Promise<Response> {
	return fetch(`${ctx.baseUrl}${pathname}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
}

test("GET /api returns server info", async () => {
	const res = await jsonRequest("/api");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { name: string; defaultCwd: string };
	expect(body.name).toBe("omp-web");
	expect(typeof body.defaultCwd).toBe("string");
});

test("session lifecycle: create → start → list → delete", async () => {
	// Create
	const createRes = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "test-session", cwd: tempDir }),
	});
	expect(createRes.status).toBe(201);
	const created = (await createRes.json()) as { session: { id: string; status: string } };
	expect(created.session.status).toBe("starting");
	const sessionId = created.session.id;

	// List
	const listRes = await jsonRequest("/api/sessions");
	const listBody = (await listRes.json()) as { sessions: Array<{ id: string; name: string }> };
	expect(listBody.sessions.some(s => s.id === sessionId)).toBe(true);

	// Delete
	const deleteRes = await jsonRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
	expect(deleteRes.status).toBe(200);
	const listAfter = (await jsonRequest("/api/sessions").then(r => r.json())) as {
		sessions: Array<{ id: string }>;
	};
	expect(listAfter.sessions.some(s => s.id === sessionId)).toBe(false);
});

test("WebSocket: auto-hydration + prompt streaming", async () => {
	// Create + wait for running.
	const createRes = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "ws-session", cwd: tempDir }),
	});
	const { session } = (await createRes.json()) as { session: { id: string } };
	const sessionId = session.id;

	// Wait for the process to be ready.
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const detail = (await jsonRequest(`/api/sessions/${sessionId}`).then(r => r.json())) as {
			session: { status: string };
		};
		if (detail.session.status === "running" || detail.session.status === "error") break;
		await new Promise(r => setTimeout(r, 200));
	}

	const ws = new WebSocket(`${ctx.baseUrl.replace("http", "ws")}/ws/sessions/${sessionId}`);
	const frames: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	const notify = () => {
		for (const w of [...waiters]) w();
	};

	ws.onmessage = (event: MessageEvent) => {
		frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		notify();
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws open failed"));
	});

	// Race-free waiter: registered before the initial scan, notified on each frame.
	const waitFor = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const waiter = () => {
				const found = frames.find(predicate);
				if (found) {
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(found);
				}
			};
			waiters.add(waiter);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error("timed out waiting for frame"));
			}, timeoutMs);
			waiter();
		});

	// Auto-hydration: state response + messages response.
	const stateResp = await waitFor(
		f =>
			(f.type as string) === "event" &&
			(f.frame as { type?: string }).type === "response" &&
			(f.frame as { id?: string }).id?.startsWith("auto:state:"),
	);
	expect((stateResp.frame as { data?: { sessionId?: string } }).data?.sessionId).toBe("ws-session");

	const messagesResp = await waitFor(
		f =>
			(f.type as string) === "event" &&
			(f.frame as { type?: string }).type === "response" &&
			(f.frame as { id?: string }).id?.startsWith("auto:messages:"),
	);
	expect(Array.isArray((messagesResp.frame as { data?: { messages?: unknown[] } }).data?.messages)).toBe(true);

	// Send a prompt and verify streaming events.
	ws.send(JSON.stringify({ type: "rpc", command: "prompt", message: "Hello mock" }));
	const start = await waitFor(
		f => (f.type as string) === "event" && (f.frame as { type?: string }).type === "message_start",
	);
	expect((start.frame as { message?: { role?: string } }).message?.role).toBe("user");

	const toolEnd = await waitFor(
		f => (f.type as string) === "event" && (f.frame as { type?: string }).type === "tool_execution_end",
		20_000,
	);
	expect((toolEnd.frame as { toolName?: string }).toolName).toBe("read_file");

	ws.close();
}, 30_000);

test("WebSocket: unknown commands are rejected", async () => {
	const createRes = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "reject-session", cwd: tempDir }),
	});
	const { session } = (await createRes.json()) as { session: { id: string } };
	const ws = new WebSocket(`${ctx.baseUrl.replace("http", "ws")}/ws/sessions/${session.id}`);

	const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.onopen = () => ws.send(JSON.stringify({ type: "rpc", command: "evil_command", payload: 1 }));
		ws.onmessage = (event: MessageEvent) => {
			const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (parsed.type === "server_error") resolve(parsed);
		};
		setTimeout(() => reject(new Error("timeout waiting for server_error")), 10_000);
	});
	expect(frame.type).toBe("server_error");
	ws.close();
});

test("extension UI: interactive select roundtrip + subagent snapshot", async () => {
	const createRes = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "ext-ui-session", cwd: tempDir }),
	});
	const { session } = (await createRes.json()) as { session: { id: string } };
	const sessionId = session.id;

	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const detail = (await jsonRequest(`/api/sessions/${sessionId}`).then(r => r.json())) as {
			session: { status: string };
		};
		if (detail.session.status === "running" || detail.session.status === "error") break;
		await new Promise(r => setTimeout(r, 200));
	}

	const ws = new WebSocket(`${ctx.baseUrl.replace("http", "ws")}/ws/sessions/${sessionId}`);
	const frames: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	const notify = () => {
		for (const w of [...waiters]) w();
	};
	ws.onmessage = (event: MessageEvent) => {
		frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		notify();
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws open failed"));
	});
	const waitFor = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const waiter = () => {
				const found = frames.find(predicate);
				if (found) {
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(found);
				}
			};
			waiters.add(waiter);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error("timed out waiting for frame"));
			}, timeoutMs);
			waiter();
		});
	const agentFrame = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number) =>
		waitFor(f => (f.type as string) === "event" && predicate(f.frame as Record<string, unknown>), timeoutMs);

	// The mock emits an approval-style select + a widget + a subagent snapshot
	// at startup; the buffered-frame replay must deliver them to late joiners.
	const request = await agentFrame(
		f =>
			f.type === "extension_ui_request" &&
			(f as { method?: string }).method === "select" &&
			Array.isArray((f as { options?: string[] }).options),
	);
	const requestId = (request.frame as { id?: string }).id;
	expect((request.frame as { options?: string[] }).options).toEqual(["Approve", "Deny"]);

	await agentFrame(f => f.type === "subagent_snapshot");
	await agentFrame(f => f.type === "setWidget" || (f as { widgetKey?: string }).widgetKey === "autoresearch");

	// Answer the dialog over the side channel and observe the mock's echo.
	ws.send(JSON.stringify({ type: "rpc", command: "extension_ui_response", id: requestId, value: "Approve" }));
	const echo = await agentFrame(
		f => f.type === "notice" && String((f as { message?: string }).message ?? "").includes("value=Approve"),
	);
	expect(echo).toBeDefined();

	ws.close();
}, 30_000);

test("create with approvalMode round-trips and rejects invalid values", async () => {
	const bad = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: tempDir, approvalMode: "sudo" }),
	});
	expect(bad.status).toBe(400);

	const ok = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "approval-session", cwd: tempDir, approvalMode: "write" }),
	});
	expect(ok.status).toBe(201);
	const { session } = (await ok.json()) as { session: { id: string; approvalMode?: string } };
	expect(session.approvalMode).toBe("write");

	// The file endpoint refuses paths outside session cwds.
	const outside = await fetch(`${ctx.baseUrl}/api/fs/file?path=${encodeURIComponent("/etc/passwd")}`);
	expect(outside.status).toBe(403);

	await jsonRequest(`/api/sessions/${session.id}`, { method: "DELETE" });
});

test("config, models, and omp-session history endpoints (mock mode)", async () => {
	const config = await jsonRequest("/api/config");
	expect(config.status).toBe(200);
	const configBody = (await config.json()) as {
		path: string;
		entries: Array<{ key: string; type: string }>;
	};
	expect(configBody.entries.some(e => e.key === "modelRoles")).toBe(true);

	const models = await jsonRequest("/api/models");
	expect(models.status).toBe(200);
	const modelsBody = (await models.json()) as { models: Array<{ id: string }> };
	expect(modelsBody.models.length).toBeGreaterThan(0);

	const history = await jsonRequest(`/api/omp-sessions?cwd=${encodeURIComponent(tempDir)}`);
	expect(history.status).toBe(200);
	const historyBody = (await history.json()) as { sessions: Array<{ id: string }> };
	expect(historyBody.sessions.some(s => s.id === "mock-1")).toBe(true);

	// Create with a pre-seeded omp identity (resume flow) round-trips it.
	const resume = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: tempDir, resumeOmpSessionId: "mock-1", name: "resumed" }),
	});
	expect(resume.status).toBe(201);
	const resumed = (await resume.json()) as { session: { ompSessionId?: string } };
	expect(resumed.session.ompSessionId).toBe("mock-1");
	await jsonRequest(`/api/sessions/${(resumed as { session: { id: string } }).session.id}`, { method: "DELETE" });
});

test("assistant sessions get a seeded workspace and kind", async () => {
	const res = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: tempDir, assistant: true }),
	});
	expect(res.status).toBe(201);
	const { session } = (await res.json()) as { session: { id: string; kind?: string; cwd: string } };
	expect(session.kind).toBe("assistant");
	// The workspace is bootstrapped with the native context file omp auto-loads.
	expect(fs.existsSync(`${session.cwd}/.omp/AGENTS.md`)).toBe(true);
	await jsonRequest(`/api/sessions/${session.id}`, { method: "DELETE" });
});

test("branch points + OAuth login flow over WS", async () => {
	const createRes = await jsonRequest("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ name: "branch-login-session", cwd: tempDir }),
	});
	const { session } = (await createRes.json()) as { session: { id: string } };
	const sessionId = session.id;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const detail = (await jsonRequest(`/api/sessions/${sessionId}`).then(r => r.json())) as {
			session: { status: string };
		};
		if (detail.session.status === "running" || detail.session.status === "error") break;
		await new Promise(r => setTimeout(r, 200));
	}

	const ws = new WebSocket(`${ctx.baseUrl.replace("http", "ws")}/ws/sessions/${sessionId}`);
	const frames: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	ws.onmessage = (event: MessageEvent) => {
		frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		for (const w of [...waiters]) w();
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws open failed"));
	});
	const waitFor = (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const waiter = () => {
				const found = frames.find(predicate);
				if (found) {
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(found);
				}
			};
			waiters.add(waiter);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error("timed out waiting for frame"));
			}, timeoutMs);
			waiter();
		});
	const agentFrame = (predicate: (frame: Record<string, unknown>) => boolean) =>
		waitFor(f => (f.type as string) === "event" && predicate(f.frame as Record<string, unknown>));

	// Branch points list.
	ws.send(JSON.stringify({ type: "rpc", id: "t:branch-list", command: "get_branch_messages" }));
	const list = await agentFrame(
		f =>
			f.type === "response" &&
			f.id === "t:branch-list" &&
			Array.isArray((f as { data?: unknown }).data?.messages ?? undefined),
	);

	// Branch from the first entry.
	const entries = (list.frame as { data?: { messages?: Array<{ entryId: string }> } }).data?.messages ?? [];
	ws.send(JSON.stringify({ type: "rpc", id: "t:branch", command: "branch", entryId: entries[0]?.entryId }));
	await agentFrame(f => f.type === "response" && f.id === "t:branch");

	// Login flow: providers list → login → open_url + input dialogs → answer.
	ws.send(JSON.stringify({ type: "rpc", id: "t:providers", command: "get_login_providers" }));
	const providers = await agentFrame(f => f.type === "response" && f.id === "t:providers");
	expect(
		((providers.frame as { data?: { providers?: Array<{ id: string }> } }).data?.providers ?? []).some(
			p => p.id === "mock-oauth",
		),
	).toBe(true);

	ws.send(JSON.stringify({ type: "rpc", id: "t:login", command: "login", providerId: "mock-oauth" }));
	await agentFrame(f => f.type === "extension_ui_request" && (f as { method?: string }).method === "open_url");
	const inputReq = await agentFrame(
		f => f.type === "extension_ui_request" && (f as { method?: string }).method === "input",
	);
	const inputId = (inputReq.frame as { id?: string }).id;
	ws.send(JSON.stringify({ type: "rpc", command: "extension_ui_response", id: inputId, value: "code-123" }));
	await agentFrame(
		f => f.type === "response" && (f as { command?: string }).command === "login" && f.success === true,
	);

	ws.close();
}, 30_000);

// ── Auth (OMP_WEB_TOKEN) ─────────────────────────────────────────────────────

test("auth: token gate protects API + WS; /api/auth exchanges a cookie", async () => {
	const config = loadConfig({
		dataDir: tempDir,
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: tempDir,
		authToken: "secret-token-123",
	});
	const manager = new SessionManager(config);
	await manager.load();
	const { server } = createApp({ config, manager });
	const base = `http://127.0.0.1:${server.port}`;

	try {
		// Unauthenticated API access and the auth check itself are 401.
		expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
		expect((await fetch(`${base}/api/auth`)).status).toBe(401);

		// WS upgrade is rejected without the cookie (before session lookup).
		const wsRes = await fetch(`${base}/ws/sessions/whatever`, {
			headers: { upgrade: "websocket", connection: "Upgrade" },
		});
		expect(wsRes.status).toBe(401);

		// Wrong token is rejected.
		const wrong = await fetch(`${base}/api/auth`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "nope" }),
		});
		expect(wrong.status).toBe(401);

		// Correct token issues a session cookie that unlocks the API.
		const login = await fetch(`${base}/api/auth`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "secret-token-123" }),
		});
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect(cookie).toContain("ompweb_session=");

		const listRes = await fetch(`${base}/api/sessions`, { headers: { cookie } });
		expect(listRes.status).toBe(200);
		expect((await fetch(`${base}/api/auth`, { headers: { cookie } })).status).toBe(200);
	} finally {
		await manager.shutdown();
		server.stop(true);
	}
});

test("auth: token can come from <dataDir>/config.json", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-authfile-"));
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ authToken: "file-token-42" }), { mode: 0o600 });
	const config = loadConfig({
		dataDir: dir,
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: dir,
	});
	const manager = new SessionManager(config);
	await manager.load();
	const { server } = createApp({ config, manager });
	const base = `http://127.0.0.1:${server.port}`;

	try {
		expect(config.authToken).toBe("file-token-42");
		expect(config.authTokenSource).toBe("file");
		expect((await fetch(`${base}/api/sessions`)).status).toBe(401);

		const login = await fetch(`${base}/api/auth`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "file-token-42" }),
		});
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(200);
	} finally {
		await manager.shutdown();
		server.stop(true);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("auth: logout expires the cookie and revokes replayed values", async () => {
	const config = loadConfig({
		dataDir: tempDir,
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: tempDir,
		authToken: "logout-token",
	});
	const manager = new SessionManager(config);
	await manager.load();
	const { server } = createApp({ config, manager });
	const base = `http://127.0.0.1:${server.port}`;

	try {
		const login = await fetch(`${base}/api/auth`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "logout-token" }),
		});
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(200);

		// Logout expires the cookie client-side…
		const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
		expect(logout.status).toBe(200);
		expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

		// …and the old value cannot be replayed.
		expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(401);
	} finally {
		await manager.shutdown();
		server.stop(true);
	}
});
