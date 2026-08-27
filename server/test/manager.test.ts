/**
 * Unit tests for SessionManager data safety around deletion. The session
 * registry is seeded through `load()` (the same path a real restart takes), so
 * no agent process is spawned and the tests exercise exactly the rule that
 * matters: deleting a web session also deletes the underlying omp session
 * files — UNLESS the session was opened from the history browser
 * (resumedFromHistory), in which case pre-existing user data must survive.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config";
import { SessionManager } from "../src/sessions/manager";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manager-"));
});

afterAll(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

interface SeedOptions {
	sessionFile?: string;
	resumedFromHistory?: boolean;
	mockMode?: boolean;
}

async function seededManager(options: SeedOptions = {}): Promise<SessionManager> {
	const dataDir = path.join(tempDir, `data-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dataDir, { recursive: true });
	const config = loadConfig({
		dataDir,
		port: 0,
		host: "127.0.0.1",
		webDistDir: tempDir,
		mockMode: options.mockMode ?? false,
	});
	const registry = {
		sessions: [
			{
				id: "s1",
				name: "seeded",
				cwd: tempDir,
				createdAt: 0,
				updatedAt: 0,
				messageCount: 0,
				...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
				...(options.resumedFromHistory ? { resumedFromHistory: true } : {}),
			},
		],
	};
	fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify(registry));
	const manager = new SessionManager(config);
	await manager.load();
	return manager;
}

describe("session delete data safety", () => {
	test("delete removes the underlying omp session file and its artifacts", async () => {
		const sessionFile = path.join(tempDir, "session-abc.jsonl");
		const artifacts = path.join(tempDir, "session-abc");
		fs.writeFileSync(sessionFile, "{}");
		fs.mkdirSync(artifacts);
		fs.writeFileSync(path.join(artifacts, "shot.png"), "x");

		const manager = await seededManager({ sessionFile });
		await manager.delete("s1");

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(artifacts)).toBe(false);
		expect(manager.get("s1")).toBeUndefined();
	});

	test("a session resumed from history never deletes the underlying file", async () => {
		const sessionFile = path.join(tempDir, "history-session.jsonl");
		const artifacts = path.join(tempDir, "history-session");
		fs.writeFileSync(sessionFile, "user data");
		fs.mkdirSync(artifacts);
		fs.writeFileSync(path.join(artifacts, "keep.png"), "x");

		const manager = await seededManager({ sessionFile, resumedFromHistory: true });
		await manager.delete("s1");

		expect(fs.readFileSync(sessionFile, "utf8")).toBe("user data");
		expect(fs.existsSync(artifacts)).toBe(true);
		expect(manager.get("s1")).toBeUndefined();
	});

	test("mock mode never touches the filesystem", async () => {
		const sessionFile = path.join(tempDir, "mock-session.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		const manager = await seededManager({ sessionFile, mockMode: true });
		await manager.delete("s1");

		expect(fs.existsSync(sessionFile)).toBe(true);
	});

	test("a session without a recorded session file just leaves the registry", async () => {
		const manager = await seededManager();
		await manager.delete("s1");
		expect(manager.get("s1")).toBeUndefined();
	});

	test("create() with an initial prompt sends it to the agent once ready", async () => {
		const config = loadConfig({
			dataDir: path.join(tempDir, "data-prompt"),
			port: 0,
			host: "127.0.0.1",
			mockMode: true,
			webDistDir: tempDir,
		});
		const manager = new SessionManager(config);
		await manager.load();
		const session = await manager.create({ cwd: tempDir, prompt: "hello from test" });

		// The mock host echoes the prompt as a live user message_start frame.
		const deadline = Date.now() + 10_000;
		let echoed = false;
		while (Date.now() < deadline && !echoed) {
			echoed = manager
				.bufferedFrames(session.id)
				.some(
					frame =>
						(frame as { type?: string; message?: { role?: string; content?: unknown } }).type ===
							"message_start" &&
						(frame as { message?: { role?: string; content?: unknown } }).message?.role === "user" &&
						(frame as { message?: { content?: string } }).message?.content === "hello from test",
				);
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		expect(echoed).toBe(true);
		await manager.shutdown();
	});
});

// ── non-mock spawn identity flow ─────────────────────────────────────────────
//
// With mockMode off the spawn handshake mints (or re-captures) the omp session
// identity: fresh sessions run new_session → set_session_name → get_state and
// record id + file; resumed sessions re-capture the session file. The bundled
// mock RPC host plays the agent so the full handshake runs for real.

describe("non-mock spawn identity flow", () => {
	const TEST_AGENT = path.resolve(import.meta.dir, "fixtures/spawn-test-agent.sh");
	let tempDir2: string;

	beforeEach(() => {
		fs.chmodSync(TEST_AGENT, 0o755);
		tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-spawn-"));
	});

	afterAll(async () => {
		// shutdown of the last manager happens inside each test
		try {
			fs.rmSync(tempDir2, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	function spawnConfig(): ReturnType<typeof loadConfig> {
		return loadConfig({
			dataDir: path.join(tempDir2, "data"),
			port: 0,
			host: "127.0.0.1",
			mockMode: false,
			webDistDir: tempDir2,
			// The wrapper IS the omp binary: it receives the exact CLI args the
			// server would pass to a real agent (--mode rpc, --session …).
			ompBin: TEST_AGENT,
		});
	}

	async function waitStatus(manager: SessionManager, id: string): Promise<"running" | "error"> {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const info = manager.get(id);
			if (info?.status === "running" || info?.status === "error") return info.status;
			if (Date.now() > deadline) throw new Error(`session did not settle: ${info?.status}`);
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}

	async function waitFor(predicate: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	test("a fresh session records the minted omp identity", async () => {
		const manager = new SessionManager(spawnConfig());
		await manager.load();
		const session = await manager.create({ cwd: tempDir2, name: "identity-flow" });
		expect(await waitStatus(manager, session.id)).toBe("running");

		// The identity handshake runs after the running transition — poll for it.
		await waitFor(() => manager.get(session.id)?.ompSessionId !== undefined, "ompSessionId");
		const info = manager.get(session.id);
		// The agent mints the id; the registry must record it plus its file.
		expect(info?.ompSessionId?.startsWith("mock-")).toBe(true);
		expect(info?.sessionFile).toBe(`/mock/sessions/${info?.ompSessionId}`);
		await manager.shutdown();
	}, 30_000);

	test("a resumed session keeps its ompSessionId and captures the session file", async () => {
		const manager = new SessionManager(spawnConfig());
		await manager.load();
		const session = await manager.create({ cwd: tempDir2, resumeOmpSessionId: "resume-1", name: "resumed" });
		expect(await waitStatus(manager, session.id)).toBe("running");

		await waitFor(() => manager.get(session.id)?.sessionFile !== undefined, "sessionFile");
		const info = manager.get(session.id);
		expect(info?.ompSessionId).toBe("resume-1");
		expect(info?.sessionFile).toBe("/mock/sessions/resume-1");
		await manager.shutdown();
	}, 30_000);

	test("a broken omp binary surfaces an error status", async () => {
		const config = loadConfig({
			dataDir: path.join(tempDir2, "data-broken"),
			port: 0,
			host: "127.0.0.1",
			mockMode: false,
			webDistDir: tempDir2,
			ompBin: "/definitely/not/a/real/omp",
		});
		const manager = new SessionManager(config);
		await manager.load();
		const session = await manager.create({ cwd: tempDir2 });
		expect(await waitStatus(manager, session.id)).toBe("error");
		expect(manager.get(session.id)?.error).toBeTruthy();
		await manager.shutdown();
	}, 30_000);

	test("start() on an already-running session is a no-op and a broken spawn throws", async () => {
		const manager = new SessionManager(spawnConfig());
		await manager.load();
		const session = await manager.create({ cwd: tempDir2, name: "start-idempotent" });
		expect(await waitStatus(manager, session.id)).toBe("running");

		const before = manager.get(session.id);
		const again = await manager.start(session.id);
		expect(again.id).toBe(before?.id);
		expect(again.status).toBe("running");

		const broken = loadConfig({
			dataDir: path.join(tempDir2, "data-broken-start"),
			port: 0,
			host: "127.0.0.1",
			mockMode: false,
			webDistDir: tempDir2,
			ompBin: "/definitely/not/a/real/omp",
		});
		const manager2 = new SessionManager(broken);
		await manager2.load();
		const failed = await manager2.create({ cwd: tempDir2 });
		await waitStatus(manager2, failed.id);
		await expect(manager2.start(failed.id)).rejects.toThrow();
		await manager.shutdown();
		await manager2.shutdown();
	}, 30_000);
});
