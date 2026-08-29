import type { APIRequestContext, Page } from "@playwright/test";

/** Pre-shared token the server under test is started with (see playwright.config). */
export const TOKEN = "e2e-token";

/** Exchange the access token for a session cookie, API-level (no UI roundtrip). */
export async function login(request: APIRequestContext): Promise<void> {
	const res = await request.post("/api/auth", { data: { token: TOKEN } });
	if (!res.ok()) throw new Error(`login failed (${res.status()})`);
}

export async function createSession(
	request: APIRequestContext,
	opts: { name: string; cwd: string; approvalMode?: "always-ask" | "write" | "yolo" },
): Promise<{ id: string }> {
	const res = await request.post("/api/sessions", { data: opts });
	if (!res.ok()) throw new Error(`create session failed (${res.status()})`);
	const body = (await res.json()) as { session: { id: string } };
	return body.session;
}

/** Log in and land on a page with the given path. */
export async function gotoPage(page: Page, path: string): Promise<void> {
	await login(page.request);
	await page.goto(path);
}
