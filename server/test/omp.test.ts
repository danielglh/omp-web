/**
 * Unit tests for the omp CLI bridge. A fake executable stands in for the real
 * `omp` binary — each test generates a dedicated script with the mode inlined
 * (Bun children do NOT inherit runtime `process.env` mutations, so env-driven
 * fakes are unreliable) — letting us pin down argument passing, stdout
 * parsing, failure and timeout handling, plus the on-disk session-history
 * scanner with an injectable root.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	listOmpSessions,
	ompConfigList,
	ompConfigPath,
	ompConfigReset,
	ompConfigSet,
	ompModelList,
	runOmpCli,
} from "../src/omp";

let scratch: string;
let counter = 0;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cli-"));
});

afterAll(() => {
	try {
		fs.rmSync(path.join(os.tmpdir(), "omp-cli-"), { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// best effort — leftover temp dirs are harmless
	}
});

/**
 * Generate an executable that behaves like a canned `omp` invocation.
 * Modes: "json" prints `stdout`; "argv" records its argv to `argvFile`;
 * "fail" exits 3 with stderr "boom"; "slow" idles until killed.
 */
async function makeFakeBin(mode: "json" | "argv" | "fail" | "slow", opts: { stdout?: string; argvFile?: string } = {}) {
	const script = `#!/usr/bin/env bun
const mode = ${JSON.stringify(mode)};
const stdout = ${JSON.stringify(opts.stdout ?? "")};
const argvFile = ${JSON.stringify(opts.argvFile ?? "")};
if (mode === "argv") {
	if (argvFile) await Bun.write(argvFile, JSON.stringify(process.argv.slice(2)));
	process.exit(0);
}
if (mode === "fail") {
	process.stderr.write("boom\\n");
	process.exit(3);
}
if (mode === "slow") {
	await new Promise(() => {});
}
process.stdout.write(stdout);
`;
	const file = path.join(scratch, `fake-omp-${counter++}`);
	await Bun.write(file, script);
	fs.chmodSync(file, 0o755);
	return file;
}

describe("runOmpCli", () => {
	test("resolves with stdout on success", async () => {
		const bin = await makeFakeBin("json", { stdout: "hello omp" });
		expect(await runOmpCli(bin, ["--version"], 5_000)).toBe("hello omp");
	});

	test("rejects with stderr on non-zero exit", async () => {
		const bin = await makeFakeBin("fail");
		await expect(runOmpCli(bin, ["config", "list"], 5_000)).rejects.toThrow("boom");
	});

	test("kills the process and rejects when the timeout fires", async () => {
		const bin = await makeFakeBin("slow");
		const started = Date.now();
		await expect(runOmpCli(bin, ["config", "list"], 150)).rejects.toThrow("timed out");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

describe("config + model bridges", () => {
	test("config list parses the JSON catalog", async () => {
		const bin = await makeFakeBin("json", {
			stdout: JSON.stringify({ modelRoles: { value: {}, type: "record", description: "roles" } }),
		});
		expect(await ompConfigList(bin)).toEqual([
			{ key: "modelRoles", value: {}, type: "record", description: "roles" },
		]);
	});

	test("config path is trimmed", async () => {
		const bin = await makeFakeBin("json", { stdout: "/mock/.omp/agent/config.yml\n" });
		expect(await ompConfigPath(bin)).toBe("/mock/.omp/agent/config.yml");
	});

	test("config set/reset pass key and value as single argv entries", async () => {
		const argvFile = path.join(scratch, "argv.json");
		const bin = await makeFakeBin("argv", { argvFile });

		await ompConfigSet(bin, "modelRoles", '{"default":"a/b"}');
		let argv = JSON.parse(await fs.promises.readFile(argvFile, "utf8")) as string[];
		expect(argv).toEqual(["config", "set", "modelRoles", '{"default":"a/b"}']);

		await ompConfigSet(bin, "note", "spaces  are  kept");
		argv = JSON.parse(await fs.promises.readFile(argvFile, "utf8")) as string[];
		expect(argv[3]).toBe("spaces  are  kept");

		await ompConfigReset(bin, "modelRoles");
		argv = JSON.parse(await fs.promises.readFile(argvFile, "utf8")) as string[];
		expect(argv).toEqual(["config", "reset", "modelRoles"]);
	});

	test("models ls parses the catalog payload", async () => {
		const bin = await makeFakeBin("json", {
			stdout: JSON.stringify({ models: [{ provider: "p", id: "m", name: "Model" }] }),
		});
		expect(await ompModelList(bin)).toEqual([{ provider: "p", id: "m", name: "Model" }]);
	});
});

describe("listOmpSessions", () => {
	let sessionsRoot: string;

	beforeEach(() => {
		sessionsRoot = path.join(scratch, "sessions");
		const write = (rel: string, lines: object[], mtime: number) => {
			const file = path.join(sessionsRoot, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
			fs.utimesSync(file, new Date(mtime), new Date(mtime));
		};
		const day = 86_400_000;
		write(
			"a/old.jsonl",
			[
				{ type: "title", title: "Old chat" },
				{ type: "session", id: "s-old", cwd: "/work/proj", timestamp: "2026-01-01T00:00:00Z" },
			],
			Date.now() - 3 * day,
		);
		write("b/new.jsonl", [{ type: "session", id: "s-new", cwd: "/work/proj" }], Date.now() - day);
		write("b/other.jsonl", [{ type: "session", id: "s-other", cwd: "/somewhere/else" }], Date.now());
		write("a/broken.jsonl", [{ type: "title", title: "no session header here" }], Date.now());
		fs.writeFileSync(path.join(sessionsRoot, "a", "notes.txt"), "not a session");
	});

	test("matches sessions by header cwd, newest first", () => {
		const sessions = listOmpSessions("/work/proj", 10, sessionsRoot);
		expect(sessions.map(s => s.id)).toEqual(["s-new", "s-old"]);
		expect(sessions[1]?.title).toBe("Old chat");
		expect(sessions[1]?.file).toBe(path.join(sessionsRoot, "a", "old.jsonl"));
		expect(sessions[1]?.createdAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
		expect(sessions[1]?.sizeBytes).toBeGreaterThan(0);
	});

	test("other working directories, broken headers and non-jsonl files are skipped", () => {
		expect(listOmpSessions("/somewhere/else", 10, sessionsRoot).map(s => s.id)).toEqual(["s-other"]);
		expect(listOmpSessions("/no/such/cwd", 10, sessionsRoot)).toEqual([]);
	});

	test("limit caps the result", () => {
		expect(listOmpSessions("/work/proj", 1, sessionsRoot).map(s => s.id)).toEqual(["s-new"]);
	});

	test("a missing sessions root yields an empty list", () => {
		expect(listOmpSessions("/work/proj", 10, path.join(sessionsRoot, "missing"))).toEqual([]);
	});
});
