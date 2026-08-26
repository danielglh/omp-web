/**
 * Token-based access control: one pre-shared access token (OMP_WEB_TOKEN or
 * <dataDir>/config.json) is exchanged for a server-tracked session cookie via
 * POST /api/auth. Every other /api route and the session WebSocket require
 * that cookie; with no token configured, auth is disabled (local dev default).
 *
 * Session values are `<hmac-of-token>.<random>`: the prefix ties a session to
 * the current token (rotating the token invalidates old cookies), the random
 * suffix makes each login a distinct revocable session. The set of live
 * sessions persists to <dataDir>/auth-sessions.json so restarts don't log
 * clients out.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const AUTH_COOKIE = "ompweb_session";
export const AUTH_COOKIE_MAX_AGE = 30 * 24 * 3600;

/** Keep the live-session table bounded (each login adds one entry). */
const MAX_SESSIONS = 100;

/** Constant-time token comparison (hash first so length never leaks). */
export function tokenEquals(presented: string, expected: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/** Deterministic per-token prefix shared by that token's sessions. */
export function sessionPrefixFor(expectedToken: string): string {
	return createHmac("sha256", expectedToken).update("omp-web-session-v1").digest("hex");
}

export function sessionCookieHeader(value: string): string {
	return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`;
}

export function parseCookies(header: string | null): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of (header ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
	}
	return map;
}

/** Server-side table of live session values, persisted across restarts. */
export class AuthSessionStore {
	#values = new Map<string, number>(); // value → issuedAt (insertion-ordered)
	#file: string;

	constructor(dataDir: string) {
		this.#file = path.join(dataDir, "auth-sessions.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#file, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const value of parsed) {
					if (typeof value === "string") this.#values.set(value, Date.now());
				}
			}
		} catch {
			// missing or corrupt file → start with no live sessions
		}
	}

	issue(prefix: string): string {
		const value = `${prefix}.${randomBytes(16).toString("hex")}`;
		this.#values.set(value, Date.now());
		while (this.#values.size > MAX_SESSIONS) {
			const oldest = this.#values.keys().next().value;
			if (oldest === undefined) break;
			this.#values.delete(oldest);
		}
		this.#persist();
		return value;
	}

	has(prefix: string, value: string | undefined): boolean {
		return value !== undefined && value.startsWith(`${prefix}.`) && this.#values.has(value);
	}

	revoke(value: string | undefined): void {
		if (value === undefined) return;
		this.#values.delete(value);
		this.#persist();
	}

	#persist(): void {
		try {
			fs.writeFileSync(this.#file, JSON.stringify([...this.#values.keys()], null, "\t"), { mode: 0o600 });
		} catch {
			// best effort — in-memory state stays authoritative for this boot
		}
	}
}
