/**
 * Hardening suite: covers fixes surfaced in the pre-release code review.
 *
 *  - static file guard rejects sibling-directory traversal (`/x/%2e%2e/dist-*`)
 *    and malformed percent-escapes (%zz) instead of leaking files / 500-ing
 *  - state-changing requests carrying Sec-Fetch-Site: cross-site are refused
 *  - PATCH /api/sessions/:id validates JSON + name type (400, not 500)
 *  - /api/fs/file resolves symlinks so links cannot escape session cwds, and
 *    always delivers HTML downloads as attachments with a sandbox CSP
 *  - RPC stdout decoding survives multi-byte UTF-8 sequences split across read
 *    chunks (createLineDecoder)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLineDecoder } from "../src/rpc/process";
import { SessionManager } from "../src/sessions/manager";
import { resolveStaticPath, serveStatic } from "../src/static";

let tempDir: string;
let baseUrl: string;
let manager: SessionManager;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-hardening-"));
	const config = loadConfig({
		dataDir: path.join(tempDir, "data"),
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: tempDir,
	});
	manager = new SessionManager(config);
	await manager.load();
	const { server } = createApp({ config, manager });
	baseUrl = `http://127.0.0.1:${server.port}`;

	// Sibling directory whose name extends webDistDir's basename: reachable only
	// because startsWith(root) matched the shared prefix, not a path boundary.
	const evilSibling = `${tempDir}-eviltwin`;
	fs.mkdirSync(evilSibling, { recursive: true });
	fs.writeFileSync(path.join(evilSibling, "secret.txt"), "TOPSECRET");
});

// Static-guard tests target resolveStaticPath directly: both HTTP clients and
// Bun's URL parser collapse raw dot segments (even %-encoded ones) before the
// handler sees them, so the only faithful way to exercise the guard is with
// the exact pathname strings an origin would receive.
const staticRoot = () => path.resolve(tempDir);

afterAll(async () => {
	await manager.shutdown();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(`${tempDir}-eviltwin`, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

// ── static file serving ──────────────────────────────────────────────────────

test("static guard: sibling directory traversal is rejected", () => {
	const baseName = path.basename(tempDir);
	// '/..' escapes dist itself, landing in a sibling whose NAME extends the
	// dist basename — exactly the case a bare startsWith(root) used to pass.
	const out = resolveStaticPath(staticRoot(), `/%2e%2e/${baseName}-eviltwin/secret.txt`);
	expect(out.status === "forbidden").toBe(true);
	const inner = resolveStaticPath(staticRoot(), "/app.js");
	expect(inner.status === "ok").toBe(true);
});

test("static guard: raw dot-dot paths are rejected too", () => {
	for (const p of ["/assets/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd"]) {
		const resolved = resolveStaticPath(staticRoot(), p);
		expect(resolved.status === "ok" ? resolved.fullPath : "blocked").not.toContain("etc/passwd");
	}
});

test("static: still serves existing files and SPA fallback", () => {
	fs.writeFileSync(path.join(tempDir, "app.js"), "console.log(1)");
	expect(serveStatic(new Request("http://omp.test/app.js"), tempDir).status).toBe(200);
	const spa = serveStatic(new Request("http://omp.test/sessions/whatever"), tempDir);
	expect(spa.status).toBe(200);
	return spa.text().then(body => expect(body).toContain("omp-web"));
});

test("static: malformed percent-escape resolves to not-found, not a thrown error", () => {
	expect(resolveStaticPath(staticRoot(), "/%zzzz").status).toBe("not_found");
});

test("static: missing dist directory serves the build-me placeholder", () => {
	const missing = path.join(staticRoot(), "no-such-dist");
	const res = serveStatic(new Request("http://omp.test/"), missing);
	expect(res.status).toBe(200);
	return res.text().then(body => expect(body).toContain("has not been built"));
});

// ── cross-site request policy ────────────────────────────────────────────────

test("cross-site state-changing requests are refused; plain requests are not", async () => {
	const crossRes = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
		body: JSON.stringify({ cwd: tempDir }),
	});
	expect(crossRes.status).toBe(403);

	// Same operation without the marker (curl / same-origin fetch) proceeds.
	const okRes = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: tempDir }),
	});
	expect(okRes.status).toBe(201);
	const created = (await okRes.json()) as { session: { id: string } };

	// Reads stay navigable (an external link to a download must keep working).
	const getRes = await fetch(`${baseUrl}/api/sessions`, { headers: { "sec-fetch-site": "cross-site" } });
	expect(getRes.status).toBe(200);

	await jsonDelete(created.session.id);
});

async function jsonDelete(id: string): Promise<void> {
	await fetch(`${baseUrl}/api/sessions/${id}`, { method: "DELETE" });
}

// ── PATCH input validation ───────────────────────────────────────────────────

async function createSession(name: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: tempDir, name }),
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { session: { id: string } };
	return body.session.id;
}

test("PATCH with invalid JSON body yields 400", async () => {
	const id = await createSession("patch-invalid-json");
	const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: "{not json",
	});
	expect(res.status).toBe(400);
	await jsonDelete(id);
});

test("PATCH with non-string name yields 400", async () => {
	const id = await createSession("patch-bad-name");
	const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: 123 }),
	});
	expect(res.status).toBe(400);
	await jsonDelete(id);
});

test("PATCH with a valid name still renames", async () => {
	const id = await createSession("patch-ok");
	const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "renamed-session" }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { session: { name: string } };
	expect(body.session.name).toBe("renamed-session");
	await jsonDelete(id);
});

// ── /api/fs/file: symlinks + HTML disposition ────────────────────────────────

describe("fs file endpoint", () => {
	let sessionId: string;
	let cwd: string;

	beforeAll(async () => {
		cwd = path.join(tempDir, "fsfile-cwd");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(cwd, "page.html"), "<script>alert('boom')</script><p>hi</p>");
		try {
			fs.symlinkSync("/etc/passwd", path.join(cwd, "leak.txt"));
		} catch {
			// filesystems without symlink support (rare in CI) — test self-skips
		}
		sessionId = await createSession("fs-file-fixture");
	});

	afterAll(async () => {
		if (sessionId) await jsonDelete(sessionId);
	});

	test("symlinked file inside a session cwd cannot escape it", async () => {
		if (!fs.existsSync(path.join(cwd, "leak.txt"))) return;
		const res = await fetch(`${baseUrl}/api/fs/file?path=${encodeURIComponent(path.join(cwd, "leak.txt"))}`);
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("root:"); // no /etc/passwd content
	});

	test("files under a session cwd download as attachments (never inline HTML)", async () => {
		const res = await fetch(`${baseUrl}/api/fs/file?path=${encodeURIComponent(path.join(cwd, "page.html"))}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition") ?? "").toStartWith("attachment");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
	});
});

// ── UTF-8 chunk-boundary decoding ────────────────────────────────────────────

test("line decoder reassembles multibyte characters split across chunks", () => {
	const lines: string[] = [];
	const decoder = createLineDecoder(line => lines.push(line));
	const encoder = new TextEncoder();
	const full = encoder.encode('{"t":"你好"}\n{"t":"🚀"}\nplain\n');
	// Cut inside 你 (byte offset 8 lands mid-codepoint) and inside 🚀 again.
	decoder.push(full.subarray(0, 8));
	decoder.push(full.subarray(8, 14));
	decoder.push(full.subarray(14));
	expect(lines).toEqual(['{"t":"你好"}', '{"t":"🚀"}', "plain"]);
});

// ── reconnect dialog replay ──────────────────────────────────────────────────
//
// The per-session frame ring buffer exists so a mid-turn joiner can resync,
// but it must not resurrect interactive dialogs that were already answered:
// an answered extension_ui_request is no longer live session state.

describe("reconnect dialog replay", () => {
	const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

	async function waitRunning(sessionId: string): Promise<void> {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
			const body = (await res.json()) as { session?: { status: string } };
			if (body.session?.status === "running" || body.session?.status === "error") return;
			await sleep(200);
		}
		throw new Error("session did not start");
	}

	/** Frames arrive wrapped as {type:"event", frame}; unwrap for predicates. */
	function unwrap(raw: Record<string, unknown>): Record<string, unknown> {
		const inner = raw.frame;
		return (typeof inner === "object" && inner !== null ? inner : raw) as Record<string, unknown>;
	}

	interface Sock {
		ws: WebSocket;
		frames: Record<string, unknown>[];
	}

	function openSocket(sessionId: string): Promise<Sock> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/sessions/${sessionId}`);
			const sock: Sock = { ws, frames: [] };
			ws.onmessage = event => {
				sock.frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
			};
			ws.onopen = () => resolve(sock);
			ws.onerror = () => reject(new Error("ws open failed"));
			setTimeout(() => reject(new Error("ws open timeout")), 10_000);
		});
	}

	async function agentFrame(
		sock: Sock,
		predicate: (frame: Record<string, unknown>) => boolean,
		timeoutMs = 10_000,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = sock.frames.map(unwrap).find(predicate);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error("timed out waiting for agent frame");
			await sleep(100);
		}
	}

	function closeSocket(sock: Sock): Promise<void> {
		return new Promise(resolve => {
			sock.ws.addEventListener("close", () => resolve(), { once: true });
			sock.ws.close();
		});
	}

	test("answered dialogs are pruned from the replay buffer", async () => {
		const sessionId = await createSession("replay-answered");
		try {
			await waitRunning(sessionId);
			const first = await openSocket(sessionId);
			const request = await agentFrame(first, f => f.type === "extension_ui_request" && f.method === "select");
			const requestId = String(request.id);
			first.ws.send(
				JSON.stringify({ type: "rpc", command: "extension_ui_response", id: requestId, value: "Approve" }),
			);
			// The mock echoes the answer as a notice — proves the answer landed.
			await agentFrame(first, f => f.type === "notice" && String(f.message ?? "").includes("value=Approve"));
			await closeSocket(first);
			await sleep(300);

			const second = await openSocket(sessionId);
			// Sentinel: the server's private auto-hydration response is queued
			// AFTER every buffered replay frame on this socket, so once it
			// arrives the replay burst is provably complete — no fixed sleep.
			await agentFrame(second, f => f.type === "response" && String(f.id ?? "").startsWith("auto:state:"));
			const resurrected = second.frames
				.map(unwrap)
				.some(f => f.type === "extension_ui_request" && f.method === "select" && f.id === requestId);
			expect(resurrected).toBe(false);
			// Guard against a vacuous pass: passive process-scoped surfaces
			// (widget, subagent snapshot) must still have been replayed.
			const replayedSomething = second.frames
				.map(unwrap)
				.some(
					f => f.type === "subagent_snapshot" || (f.type === "extension_ui_request" && f.method === "setWidget"),
				);
			expect(replayedSomething).toBe(true);
			await closeSocket(second);
		} finally {
			await jsonDelete(sessionId);
		}
	}, 30_000);

	test("unanswered dialogs still replay on reconnect", async () => {
		const sessionId = await createSession("replay-unanswered");
		try {
			await waitRunning(sessionId);
			const first = await openSocket(sessionId);
			await agentFrame(first, f => f.type === "extension_ui_request" && f.method === "select");
			await closeSocket(first);
			await sleep(300);
			const second = await openSocket(sessionId);
			const again = await agentFrame(second, f => f.type === "extension_ui_request" && f.method === "select");
			expect(String(again.id)).toBeTruthy();
			await closeSocket(second);
		} finally {
			await jsonDelete(sessionId);
		}
	}, 30_000);
});

// ── delete chain end-to-end: API → manager → filesystem ─────────────────────

describe("delete chain end-to-end", () => {
	let chainBase: string;
	let fileA: string;
	let artifactsA: string;
	let fileB: string;

	beforeAll(async () => {
		const dataDir = path.join(tempDir, "data-chain");
		fs.mkdirSync(dataDir, { recursive: true });
		fileA = path.join(tempDir, "chain-session.jsonl");
		artifactsA = path.join(tempDir, "chain-session");
		fs.writeFileSync(fileA, '{"row":1}');
		fs.mkdirSync(artifactsA);
		fs.writeFileSync(path.join(artifactsA, "shot.png"), "x");
		fileB = path.join(tempDir, "history-session.jsonl");
		fs.writeFileSync(fileB, "pre-existing user data");

		const registry = {
			sessions: [
				{
					id: "chain-del",
					name: "chain",
					cwd: tempDir,
					createdAt: 0,
					updatedAt: 0,
					messageCount: 0,
					sessionFile: fileA,
				},
				{
					id: "chain-resumed",
					name: "resumed",
					cwd: tempDir,
					createdAt: 0,
					updatedAt: 0,
					messageCount: 0,
					sessionFile: fileB,
					resumedFromHistory: true,
				},
			],
		};
		fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify(registry));

		// mockMode off is the point: deletion must hit the real filesystem.
		const config = loadConfig({
			dataDir,
			port: 0,
			host: "127.0.0.1",
			mockMode: false,
			webDistDir: tempDir,
			ompBin: "/definitely/not/used/delete-never-spawns",
		});
		const chainManager = new SessionManager(config);
		await chainManager.load();
		chainBase = `http://127.0.0.1:${createApp({ config, manager: chainManager }).server.port}`;
	});

	test("deleting a normal session removes the omp session file and artifacts over HTTP", async () => {
		const res = await fetch(`${chainBase}/api/sessions/chain-del`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		expect(fs.existsSync(fileA)).toBe(false);
		expect(fs.existsSync(artifactsA)).toBe(false);
		expect((await fetch(`${chainBase}/api/sessions/chain-del`)).status).toBe(404);
	});

	test("deleting a resumed session keeps the pre-existing history file", async () => {
		const res = await fetch(`${chainBase}/api/sessions/chain-resumed`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(fs.readFileSync(fileB, "utf8")).toBe("pre-existing user data");
	});
});

// ── filesystem picker endpoints ──────────────────────────────────────────────

describe("non-mock omp CLI bridge errors surface to clients", () => {
	let bridgeBase: string;

	beforeAll(async () => {
		// A fake omp binary that always fails: the bridge must surface its
		// stderr as a client-visible error instead of swallowing it.
		const fakeBin = path.join(tempDir, "fake-omp-fail");
		await Bun.write(fakeBin, '#!/usr/bin/env bun\nprocess.stderr.write("boom\\n");\nprocess.exit(3);\n');
		fs.chmodSync(fakeBin, 0o755);
		const config = loadConfig({
			dataDir: path.join(tempDir, "data-cli"),
			port: 0,
			host: "127.0.0.1",
			mockMode: false,
			webDistDir: tempDir,
			ompBin: fakeBin,
		});
		const bridgeManager = new SessionManager(config);
		await bridgeManager.load();
		bridgeBase = `http://127.0.0.1:${createApp({ config, manager: bridgeManager }).server.port}`;
	});

	test("config/models endpoints surface omp CLI errors", async () => {
		const get = await fetch(`${bridgeBase}/api/config`);
		expect(get.status).toBe(500);
		expect(((await get.json()) as { error: string }).error).toContain("boom");

		const put = await fetch(`${bridgeBase}/api/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "a", value: "b" }),
		});
		expect(put.status).toBe(400);
		expect(((await put.json()) as { error: string }).error).toContain("boom");

		const del = await fetch(`${bridgeBase}/api/config?key=a`, { method: "DELETE" });
		expect(del.status).toBe(400);
		expect(((await del.json()) as { error: string }).error).toContain("boom");

		const models = await fetch(`${bridgeBase}/api/models`);
		expect(models.status).toBe(500);
		expect(((await models.json()) as { error: string }).error).toContain("boom");
	});
});

// ── workspace file manager endpoints ─────────────────────────────────────────

describe("workspace file manager endpoints", () => {
	let wsCwd: string;
	let wsBase: string;

	beforeAll(async () => {
		wsCwd = path.join(tempDir, "ws-fm");
		fs.mkdirSync(path.join(wsCwd, "docs"), { recursive: true });
		fs.mkdirSync(path.join(wsCwd, "assets"), { recursive: true });
		fs.writeFileSync(path.join(wsCwd, "README.md"), "# Hello\n\nworld");
		fs.writeFileSync(path.join(wsCwd, "notes.txt"), "plain notes");
		fs.writeFileSync(
			path.join(wsCwd, "page.html"),
			"<html><body><p>report</p><script>alert(1)</script></body></html>",
		);
		fs.writeFileSync(
			path.join(wsCwd, "logo.png"),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
		);
		fs.writeFileSync(path.join(wsCwd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
		fs.writeFileSync(path.join(wsCwd, "docs", "guide.md"), "# Guide");
		try {
			fs.symlinkSync("/etc/passwd", path.join(wsCwd, "escape.txt"));
			fs.symlinkSync("/etc", path.join(wsCwd, "escape-dir"));
		} catch {
			// best effort
		}

		const dataDir = path.join(tempDir, "data-ws");
		fs.mkdirSync(dataDir, { recursive: true });
		const registry = {
			sessions: [{ id: "ws-fm", name: "fm", cwd: wsCwd, createdAt: 0, updatedAt: 0, messageCount: 0 }],
		};
		fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify(registry));
		const config = loadConfig({
			dataDir,
			port: 0,
			host: "127.0.0.1",
			mockMode: true,
			webDistDir: tempDir,
		});
		const fmManager = new SessionManager(config);
		await fmManager.load();
		wsBase = `http://127.0.0.1:${createApp({ config, manager: fmManager }).server.port}`;
	});

	test("entries lists one directory with types and sizes, within a session cwd", async () => {
		const res = await fetch(`${wsBase}/api/fs/entries?path=${encodeURIComponent(wsCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			path: string;
			entries: Array<{ name: string; type: string; size: number }>;
		};
		expect(body.path).toBe(fs.realpathSync(wsCwd)); // realpath-normalized (e.g. /var → /private/var)
		const byName = Object.fromEntries(body.entries.map(e => [e.name, e]));
		expect(byName["README.md"]).toMatchObject({ type: "file" });
		expect(byName.docs).toMatchObject({ type: "dir" });
		expect(byName["logo.png"].size).toBeGreaterThan(0);
		expect(body.entries.some(e => e.name === "escape.txt")).toBe(true); // listed, but…
	});

	test("navigating into a symlinked directory that escapes is refused", async () => {
		const res = await fetch(`${wsBase}/api/fs/entries?path=${encodeURIComponent(path.join(wsCwd, "escape-dir"))}`);
		expect(res.status).toBe(403);
	});

	test("entries outside every session cwd are refused", async () => {
		expect((await fetch(`${wsBase}/api/fs/entries?path=/etc`)).status).toBe(403);
	});

	test("preview returns decoded text with truncation metadata", async () => {
		const res = await fetch(`${wsBase}/api/fs/preview?path=${encodeURIComponent(path.join(wsCwd, "README.md"))}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { kind: string; mime: string; text: string; truncated: boolean };
		expect(body.kind).toBe("text");
		expect(body.mime).toBe("text/markdown");
		expect(body.text).toContain("# Hello");
		expect(body.truncated).toBe(false);
	});

	test("images are classified for the raw viewer, binaries are not decodable", async () => {
		const img = await fetch(`${wsBase}/api/fs/preview?path=${encodeURIComponent(path.join(wsCwd, "logo.png"))}`);
		const imgBody = (await img.json()) as { kind: string; mime: string };
		expect(imgBody.kind).toBe("image");
		expect(imgBody.mime).toBe("image/png");

		const bin = await fetch(`${wsBase}/api/fs/preview?path=${encodeURIComponent(path.join(wsCwd, "blob.bin"))}`);
		const binBody = (await bin.json()) as { kind: string; text?: string };
		expect(binBody.kind).toBe("binary");
		expect(binBody.text).toBeUndefined();
	});

	test("raw serving is restricted to image types", async () => {
		const png = await fetch(`${wsBase}/api/fs/raw?path=${encodeURIComponent(path.join(wsCwd, "logo.png"))}`);
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(0);

		expect(
			(await fetch(`${wsBase}/api/fs/raw?path=${encodeURIComponent(path.join(wsCwd, "notes.txt"))}`)).status,
		).toBe(415);
	});

	test("content reads cannot escape via symlinks or traversal", async () => {
		expect(
			(await fetch(`${wsBase}/api/fs/preview?path=${encodeURIComponent(path.join(wsCwd, "escape.txt"))}`)).status,
		).toBe(403);
		expect(
			(await fetch(`${wsBase}/api/fs/raw?path=${encodeURIComponent(path.join(wsCwd, "escape.txt"))}`)).status,
		).toBe(403);
		expect(
			(await fetch(`${wsBase}/api/fs/entries?path=${encodeURIComponent(path.join(wsCwd, "..%2F..%2Fetc"))}`)).status,
		).toBe(403);
	});

	test("html preview text keeps its scripts inline (the iframe sandbox neutralizes them)", async () => {
		const res = await fetch(`${wsBase}/api/fs/preview?path=${encodeURIComponent(path.join(wsCwd, "page.html"))}`);
		const body = (await res.json()) as { kind: string; mime: string; text: string };
		expect(body.kind).toBe("text");
		expect(body.mime).toBe("text/html");
		expect(body.text).toContain("<script>alert(1)</script>"); // verbatim; sandbox iframe renders inert
	});
});

describe("fs picker endpoints", () => {
	let pickerCwd: string;

	beforeAll(async () => {
		pickerCwd = path.join(tempDir, "fs-picker-cwd");
		fs.mkdirSync(pickerCwd, { recursive: true });
		fs.writeFileSync(path.join(pickerCwd, "page.html"), "<p>picker</p>");
		fs.mkdirSync(path.join(pickerCwd, "subdir"));
	});

	test("list resolves path/parent and lists subdirectories", async () => {
		const res = await fetch(`${baseUrl}/api/fs/list?path=${encodeURIComponent(pickerCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; parent: string; dirs: string[] };
		expect(body.path).toBe(pickerCwd);
		expect(body.parent).toBe(path.dirname(pickerCwd));
		expect(body.dirs).toEqual(["subdir"]);
	});

	test("list on a file or missing path yields 400", async () => {
		expect(
			(await fetch(`${baseUrl}/api/fs/list?path=${encodeURIComponent(path.join(pickerCwd, "page.html"))}`)).status,
		).toBe(400);
		expect((await fetch(`${baseUrl}/api/fs/list?path=/definitely/missing`)).status).toBe(400);
	});

	test("search matches directory names by basename prefix", async () => {
		const res = await fetch(`${baseUrl}/api/fs/search?prefix=${encodeURIComponent(path.join(tempDir, "fs-pic"))}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matches: string[] };
		expect(body.matches).toEqual([path.join(tempDir, "fs-picker-cwd")]);
	});

	test("paths lists files and dirs under a cwd", async () => {
		const res = await fetch(`${baseUrl}/api/fs/paths?prefix=./&cwd=${encodeURIComponent(pickerCwd)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matches: string[] };
		expect(body.matches).toEqual([path.join(pickerCwd, "page.html"), `${path.join(pickerCwd, "subdir")}/`]);
	});
});

// ── WS control messages ──────────────────────────────────────────────────────

describe("ws control messages", () => {
	let sessionId: string;

	beforeAll(async () => {
		sessionId = await createSession("ws-control");
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const detail = (await fetch(`${baseUrl}/api/sessions/${sessionId}`).then(r => r.json())) as {
				session: { status: string };
			};
			if (detail.session.status === "running" || detail.session.status === "error") return;
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		throw new Error("ws-control session did not start");
	});

	afterAll(async () => {
		if (sessionId) await jsonDelete(sessionId);
	});

	function openSocket(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/sessions/${sessionId}`);
			ws.onopen = () => resolve(ws);
			ws.onerror = () => reject(new Error("ws open failed"));
			setTimeout(() => reject(new Error("ws open timeout")), 10_000);
		});
	}

	test("refresh_session replies with a session snapshot", async () => {
		const ws = await openSocket();
		const reply = await new Promise<Record<string, unknown>>(resolve => {
			ws.onmessage = event => {
				const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
				if (parsed.type === "session") resolve(parsed);
			};
			ws.send(JSON.stringify({ type: "refresh_session" }));
		});
		expect((reply.session as { id?: string }).id).toBe(sessionId);
		ws.close();
	});

	test("stop_session stops the agent and broadcasts the stopped status", async () => {
		const ws = await openSocket();
		const stopped = await new Promise<Record<string, unknown>>(resolve => {
			ws.onmessage = event => {
				const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
				if (parsed.type === "session" && (parsed.session as { status?: string }).status === "stopped") {
					resolve(parsed);
				}
			};
			ws.send(JSON.stringify({ type: "stop_session" }));
		});
		expect((stopped.session as { id?: string }).id).toBe(sessionId);
		const detail = (await fetch(`${baseUrl}/api/sessions/${sessionId}`).then(r => r.json())) as {
			session: { status: string };
		};
		expect(detail.session.status).toBe("stopped");
		ws.close();
	});
});
