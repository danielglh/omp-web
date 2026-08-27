/**
 * Unit tests for the browser-side logout decision helper.
 *
 * Contract (matches the LogoutButton's "no-op when auth is disabled" doc):
 * logging out may only re-gate the UI when the server genuinely requires auth
 * and no longer accepts our cookie. On an open server (auth disabled) the
 * button must be a visual no-op instead of trapping the user behind an
 * unsatisfiable token prompt.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { logoutDeterminesGate } from "../src/lib/logout";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function stubFetch(responses: Array<{ status: number; body?: string }>): number[] {
	const calls: number[] = [];
	let index = 0;
	globalThis.fetch = (async () => {
		const call = responses[Math.min(index, responses.length - 1)];
		calls.push(call?.status ?? 0);
		index++;
		return new Response(call?.body ?? "", { status: call?.status ?? 500 });
	}) as typeof fetch;
	return calls;
}

describe("logoutDeterminesGate", () => {
	test("open server (auth disabled): logout stays a visual no-op", async () => {
		// POST /api/auth/logout succeeds, GET /api/auth says no auth required.
		stubFetch([
			{ status: 200, body: '{"ok":true}' },
			{ status: 200, body: '{"authRequired":false}' },
		]);
		expect(await logoutDeterminesGate()).toBe(false);
	});

	test("tokened server: revoked cookie flips the gate back on", async () => {
		stubFetch([
			{ status: 200, body: '{"ok":true}' },
			{ status: 401, body: '{"error":"unauthorized"}' },
		]);
		expect(await logoutDeterminesGate()).toBe(true);
	});

	test("network failure after logout fails safe (gate)", async () => {
		globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
		expect(await logoutDeterminesGate()).toBe(true);
	});
});
