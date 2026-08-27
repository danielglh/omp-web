/**
 * Unit tests for loadConfig's diagnostics: the config file's permissions and
 * corruption only produce console warnings (never a crash), while values still
 * resolve.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config";

let tempDir: string;
const warns: string[] = [];
const originalWarn = console.warn;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-"));
	warns.length = 0;
	console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
});

afterEach(() => {
	console.warn = originalWarn;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("config file diagnostics", () => {
	test("a group/world-readable config file triggers a chmod warning", () => {
		fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ authToken: "secret" }), { mode: 0o666 });
		const config = loadConfig({ dataDir: tempDir });
		expect(config.authToken).toBe("secret");
		expect(warns.some(w => w.includes("group/world readable"))).toBe(true);
	});

	test("a corrupt config file warns but does not crash", () => {
		fs.writeFileSync(path.join(tempDir, "config.json"), "{broken json");
		const config = loadConfig({ dataDir: tempDir });
		expect(config.authToken).toBe("");
		expect(warns.some(w => w.includes("cannot read"))).toBe(true);
	});

	test("secureCookie resolves from the config file and beats nothing but loses to env", () => {
		fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ authToken: "t", secureCookie: true }), {
			mode: 0o600,
		});
		expect(loadConfig({ dataDir: tempDir }).secureCookie).toBe(true);

		process.env.OMP_WEB_SECURE_COOKIE = "false";
		try {
			expect(loadConfig({ dataDir: tempDir }).secureCookie).toBe(false);
		} finally {
			delete process.env.OMP_WEB_SECURE_COOKIE;
		}
	});
});
