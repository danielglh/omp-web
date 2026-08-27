/**
 * Unit tests for the AuthSessionStore: token comparison, server-side session
 * TTL expiry (aligned with the 30-day cookie), and persistence-format
 * compatibility (legacy string arrays vs. [value, issuedAt] pairs).
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_SESSION_TTL_MS, AuthSessionStore, sessionPrefixFor, tokenEquals } from "../src/auth";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-auth-test-"));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("auth store", () => {
	const dirs: string[] = [];
	const makeDir = () => {
		const dir = tmpDir();
		dirs.push(dir);
		return dir;
	};

	afterAll(() => {
		for (const dir of dirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	});

	test("tokenEquals compares by hash so length never leaks", () => {
		expect(tokenEquals("secret", "secret")).toBe(true);
		expect(tokenEquals("short", "a-longer-token")).toBe(false);
		expect(tokenEquals("a-longer-token", "short")).toBe(false);
	});

	test("sessions validate until the TTL expires, then are rejected and pruned", () => {
		let now = Date.now();
		const store = new AuthSessionStore(makeDir(), () => now);
		const prefix = sessionPrefixFor("tok");

		const value = store.issue(prefix);
		expect(store.has(prefix, value)).toBe(true);

		now += AUTH_SESSION_TTL_MS - DAY; // just inside
		expect(store.has(prefix, value)).toBe(true);

		now += 2 * DAY; // past the TTL
		expect(store.has(prefix, value)).toBe(false);
		// A different prefixed value cannot ride a valid-looking cookie.
		expect(store.has(sessionPrefixFor("other"), value)).toBe(false);
		expect(store.has(prefix, `${prefix}.not-issued`)).toBe(false);
	});

	test("revocation persists across instances (logout stays logged out)", () => {
		const dir = makeDir();
		let now = Date.now();
		const first = new AuthSessionStore(dir, () => now);
		const prefix = sessionPrefixFor("tok");
		const value = first.issue(prefix);

		now += HOUR;
		const second = new AuthSessionStore(dir, () => now);
		expect(second.has(prefix, value)).toBe(true);
		second.revoke(value);
		const third = new AuthSessionStore(dir, () => now);
		expect(third.has(prefix, value)).toBe(false);
	});

	test("legacy string-array persistence files still load", () => {
		const dir = makeDir();
		const prefix = sessionPrefixFor("legacy");
		const value = `${prefix}.deadbeef`;
		fs.writeFileSync(path.join(dir, "auth-sessions.json"), JSON.stringify([value]));
		let now = Date.now();
		const store = new AuthSessionStore(dir, () => now);
		expect(store.has(prefix, value)).toBe(true);
		// Legacy entries adopt boot time as their issue time → expire normally.
		now += AUTH_SESSION_TTL_MS + DAY;
		expect(store.has(prefix, value)).toBe(false);
	});

	test("issuedAt-pair persistence files keep their original issue time", () => {
		const dir = makeDir();
		const prefix = sessionPrefixFor("pairs");
		const ancient = `${prefix}.old001`;
		const fresh = `${prefix}.new002`;
		const issueTime = Date.now() - AUTH_SESSION_TTL_MS - DAY; // already expired on disk
		fs.writeFileSync(
			path.join(dir, "auth-sessions.json"),
			JSON.stringify([
				[ancient, issueTime],
				[fresh, Date.now()],
			]),
		);
		const store = new AuthSessionStore(dir);
		expect(store.has(prefix, ancient)).toBe(false); // expired long ago
		expect(store.has(prefix, fresh)).toBe(true);
	});
});
