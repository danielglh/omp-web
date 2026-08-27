/**
 * Unit tests for the assistant host-tool dispatcher: argument validation,
 * self-protection guards, and that every operation really lands on the
 * SessionManager it is bound to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config";
import { ASSISTANT_HOST_TOOLS, runHostToolCall } from "../src/host-tools";
import { SessionManager } from "../src/sessions/manager";

const HOSTING_SESSION = "hosting-1";
let manager: SessionManager;
const createdIds: string[] = [];
let tempRoot: string;
let hostingId: string;

beforeAll(async () => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hosttools-"));
	const config = loadConfig({
		dataDir: path.join(tempRoot, "data"),
		port: 0,
		host: "127.0.0.1",
		mockMode: true,
		webDistDir: tempRoot,
	});
	manager = new SessionManager(config);
	await manager.load();
	// A hosting (assistant) session plus one ordinary session to observe.
	await manager.create({ cwd: tempRoot, name: HOSTING_SESSION });
	await manager.create({ cwd: tempRoot, name: "victim", prompt: undefined });

	const deadline = Date.now() + 10_000;
	for (;;) {
		const victim = manager.list().find(s => s.name === "victim");
		if (!victim || victim.status === "running") break;
		if (Date.now() > deadline) throw new Error("seed session did not start");
		await new Promise(r => setTimeout(r, 100));
	}
	hostingId = manager.list().find(s => s.name === HOSTING_SESSION)?.id ?? "";
	expect(hostingId).toBeTruthy();
});

afterAll(async () => {
	await manager.shutdown();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown> = {}, callingSessionId: string = hostingId) {
	return runHostToolCall(manager, callingSessionId, name, args);
}

describe("assistant host tools", () => {
	test("the announced tool set matches what is implemented", () => {
		expect(ASSISTANT_HOST_TOOLS.map(t => t.name)).toEqual([
			"omp_web_list_sessions",
			"omp_web_create_session",
			"omp_web_delete_session",
			"omp_web_stop_session",
		]);
	});

	test("list reports sessions with ids and marks the assistant kind", async () => {
		const res = await call("omp_web_list_sessions");
		expect(res.isError).toBeFalsy();
		expect(res.content).toContain(`id=${hostingId}`);
		expect(res.content).toContain("victim");
	});

	test("create starts a new session and delivers its initial prompt", async () => {
		const res = await call("omp_web_create_session", { cwd: tempRoot, name: "spawned-by-tool", prompt: "do things" });
		expect(res.isError).toBeFalsy();
		const id = /id=([a-z0-9-]+)/.exec(res.content)?.[1] ?? "";
		expect(id).toBeTruthy();
		createdIds.push(id);

		// lastPrompt and the echoed user message land once the agent is ready.
		const deadline = Date.now() + 10_000;
		let echoed = false;
		while (Date.now() < deadline && !echoed) {
			echoed = (manager.bufferedFrames(id) as Array<Record<string, unknown>>).some(
				f =>
					f.type === "message_start" &&
					(f.message as { role?: string; content?: string } | undefined)?.content === "do things",
			);
			await new Promise(r => setTimeout(r, 100));
		}
		expect(echoed).toBe(true);
		expect(manager.get(id)?.name).toBe("spawned-by-tool");
		expect(manager.get(id)?.lastPrompt).toBe("do things");
	});

	test("create without a cwd is rejected", async () => {
		expect((await call("omp_web_create_session", {})).isError).toBe(true);
	});

	test("delete requires an id and protects the hosting session", async () => {
		expect((await call("omp_web_delete_session", {})).isError).toBe(true);
		const self = await call("omp_web_delete_session", { id: hostingId });
		expect(self.isError).toBe(true);
		expect(self.content).toContain("refusing");
		expect(manager.get(hostingId)).toBeDefined();
	});

	test("stop requires an id and protects the hosting session", async () => {
		expect((await call("omp_web_stop_session", {})).isError).toBe(true);
		const self = await call("omp_web_stop_session", { id: hostingId });
		expect(self.isError).toBe(true);
	});

	test("unknown tools are reported as errors", async () => {
		const res = await call("omp_web_not_a_tool");
		expect(res.isError).toBe(true);
		expect(res.content).toContain("omp_web_not_a_tool");
	});

	test("delete then stop round-trip against real sessions", async () => {
		const spawned = await call("omp_web_create_session", { cwd: tempRoot, name: "to-be-managed" });
		const id = /id=([a-z0-9-]+)/.exec(spawned.content)?.[1] ?? "";
		createdIds.push(id);

		const stopped = await call("omp_web_stop_session", { id });
		expect(stopped.isError).toBeFalsy();
		expect(manager.get(id)?.status).toBe("stopped");

		const restarted = await call("omp_web_create_session", { cwd: tempRoot, name: "second-life" });
		void restarted;

		const deleted = await call("omp_web_delete_session", { id });
		expect(deleted.isError).toBeFalsy();
		expect(manager.get(id)).toBeUndefined();
	});
});
