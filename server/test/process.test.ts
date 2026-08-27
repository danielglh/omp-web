/**
 * Unit tests for OmpProcess lifecycle: readiness timeout, graceful close with
 * SIGTERM escalation to SIGKILL, and the exit callback. A real child process
 * (bun -e) is used so signal handling behaves exactly like production.
 */
import { describe, expect, test } from "bun:test";
import { spawnOmpProcess } from "../src/rpc/process";

const IDLER = "setInterval(() => {}, 1e6)";

describe("spawnOmpProcess lifecycle", () => {
	test("readiness timeout rejects and close terminates the child", async () => {
		const exits: Array<{ code: number | null; signal: string | null }> = [];
		const proc = spawnOmpProcess({
			bin: process.execPath,
			args: ["-e", IDLER],
			cwd: import.meta.dir,
			onFrame: () => {},
			onExit: info => exits.push(info),
			readyTimeoutMs: 150,
		});
		await expect(proc.ready).rejects.toThrow(/timed out waiting for omp RPC ready/);

		await proc.close(150);
		expect(exits.length).toBe(1);
		expect(exits[0]?.code === 0 || exits[0]?.signal !== null).toBe(true);
	});

	test("a child that ignores SIGTERM is escalated to SIGKILL", async () => {
		const exits: Array<{ code: number | null; signal: string | null }> = [];
		const proc = spawnOmpProcess({
			bin: process.execPath,
			// Trap SIGTERM and keep running — only SIGKILL can end us.
			args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"],
			cwd: import.meta.dir,
			onFrame: () => {},
			onExit: info => exits.push(info),
			readyTimeoutMs: 150,
		});
		await proc.ready.catch(() => {});

		const started = Date.now();
		await proc.close(150);
		// close() returns right after sending SIGKILL; wait for the death to land.
		const deadline = Date.now() + 2_000;
		while (exits.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
		expect(exits.length).toBe(1);
		expect(exits[0]?.signal).toBe("SIGKILL");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test("kill() terminates the child directly", async () => {
		const exits: Array<{ code: number | null; signal: string | null }> = [];
		const proc = spawnOmpProcess({
			bin: process.execPath,
			args: ["-e", IDLER],
			cwd: import.meta.dir,
			onFrame: () => {},
			onExit: info => exits.push(info),
			readyTimeoutMs: 150,
		});
		await proc.ready.catch(() => {});

		proc.kill();
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(exits.length).toBe(1);
		expect(exits[0]?.signal).toBe("SIGTERM");
	});

	test("frames from the child reach onFrame after decoder reassembly", async () => {
		const frames: unknown[] = [];
		const proc = spawnOmpProcess({
			bin: process.execPath,
			args: ["-e", "console.log(JSON.stringify({ type: 'ready', protocolVersion: 1 }))"],
			cwd: import.meta.dir,
			onFrame: frame => frames.push(frame),
			onExit: () => {},
			readyTimeoutMs: 2_000,
		});
		const deadline = Date.now() + 3_000;
		while (frames.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
		await proc.close(150);
		expect(frames.some(f => (f as { type?: string }).type === "ready")).toBe(true);
	});
});
