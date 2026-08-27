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
 * clients out. Entries expire server-side after AUTH_SESSION_TTL_MS (the same
 * lifetime the browser cookie carries); expiry is enforced on every `has`.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const AUTH_COOKIE = "ompweb_session";
export const AUTH_COOKIE_MAX_AGE = 30 * 24 * 3600;
/** Server-side mirror of the cookie lifetime. */
export const AUTH_SESSION_TTL_MS = AUTH_COOKIE_MAX_AGE * 1000;

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

export function sessionCookieHeader(value: string, secure = false): string {
	return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;
}

/** Expiring twin of {@link sessionCookieHeader}, used on logout. */
export function clearedSessionCookieHeader(secure = false): string {
	return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
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

interface StoredValue {
	value: string;
	issuedAt: number;
}

/** Server-side table of live session values, persisted across restarts. */
export class AuthSessionStore {
	#values = new Map<string, StoredValue>(); // value → issue metadata (insertion-ordered)
	#file: string;
	#now: () => number;

	constructor(dataDir: string, now: () => number = Date.now) {
		this.#now = now;
		this.#file = path.join(dataDir, "auth-sessions.json");
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.#file, "utf8"));
			if (!Array.isArray(parsed)) return;
			for (const entry of parsed) {
				// v2: [value, issuedAt] pairs. v1 (legacy): bare strings adopt boot
				// time as their issue moment, so they expire a full window from now.
				if (typeof entry === "string") {
					this.#values.set(entry, { value: entry, issuedAt: now() });
				} else if (
					Array.isArray(entry) &&
					entry.length === 2 &&
					typeof entry[0] === "string" &&
					typeof entry[1] === "number"
				) {
					this.#values.set(entry[0], { value: entry[0], issuedAt: entry[1] });
				}
			}
		} catch {
			// missing or corrupt file → start with no live sessions
		}
	}

	issue(prefix: string): string {
		this.#pruneExpired();
		const value = `${prefix}.${randomBytes(16).toString("hex")}`;
		this.#values.set(value, { value, issuedAt: this.#now() });
		while (this.#values.size > MAX_SESSIONS) {
			const oldest = this.#values.keys().next().value;
			if (oldest === undefined) break;
			this.#values.delete(oldest);
		}
		this.#persist();
		return value;
	}

	has(prefix: string, value: string | undefined): boolean {
		if (value === undefined || !value.startsWith(`${prefix}.`)) return false;
		const stored = this.#values.get(value);
		if (stored === undefined) return false;
		if (this.#now() - stored.issuedAt >= AUTH_SESSION_TTL_MS) {
			this.#values.delete(value);
			this.#persist();
			return false;
		}
		return true;
	}

	revoke(value: string | undefined): void {
		if (value === undefined) return;
		if (this.#values.delete(value)) this.#persist();
	}

	#pruneExpired(): void {
		const now = this.#now();
		let pruned = 0;
		for (const [value, stored] of this.#values) {
			if (now - stored.issuedAt >= AUTH_SESSION_TTL_MS) {
				this.#values.delete(value);
				pruned++;
			}
		}
		if (pruned > 0) this.#persist();
	}

	#persist(): void {
		try {
			const payload = [...this.#values.values()].map(entry => [entry.value, entry.issuedAt]);
			fs.writeFileSync(this.#file, JSON.stringify(payload, null, "\t"), { mode: 0o600 });
		} catch {
			// best effort — in-memory state stays authoritative for this boot
		}
	}
}
