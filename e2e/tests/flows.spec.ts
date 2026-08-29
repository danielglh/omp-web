import { expect, test } from "@playwright/test";
import { PROJECT_DIR, TOKEN, createSession, gotoPage, login } from "./helpers";

test.describe("flows against the mock host", () => {
	test("token gate: wrong token is refused, correct token unlocks", async ({ page }) => {
		await page.goto("/");
		const tokenInput = page.getByLabel("Access token", { exact: true });
		await expect(tokenInput).toBeVisible();

		await tokenInput.fill("not-the-token");
		await tokenInput.press("Enter");
		await expect(page.getByText("invalid token")).toBeVisible();
		await expect(tokenInput).toBeVisible();

		await tokenInput.fill(TOKEN);
		await tokenInput.press("Enter");
		await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
	});

	test("new session dialog: create, approve the tool call, run a turn to idle", async ({ page }) => {
		await gotoPage(page, "/");
		await page.getByRole("button", { name: "New session", exact: true }).click();

		const dialog = page.getByRole("dialog", { name: "New session" });
		await expect(dialog).toBeVisible();
		await dialog.getByPlaceholder("my-project-session").fill("e2e-flow");
		await dialog.getByPlaceholder("/home/user/project").fill("/tmp");
		await dialog.getByRole("button", { name: "create" }).click();

		// Landed in the session; the mock spawns and immediately asks for a
		// tool approval, which flows through as a dialog.
		await expect(page.getByText("Allow tool: read_file")).toBeVisible();
		await page.getByRole("button", { name: "Approve" }).click();
		await expect(page.getByText("Allow tool: read_file")).toBeHidden();

		// A full turn: user echo, thinking block, tool card, composer idle again.
		const composer = page.getByRole("textbox", { name: /Prompt the agent/ });
		await composer.fill("Map the repo layout");
		await composer.press("Enter");
		const main = page.getByRole("main");
		await expect(main.getByText("Map the repo layout")).toBeVisible();
		await expect(page.getByRole("button", { name: /thinking/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /read_file/ })).toBeVisible();
		// The composer must return to idle once the turn drains — a stuck
		// "Queue a prompt" here means streaming state never cleared.
		await expect(page.getByPlaceholder(/^Prompt the agent/)).toBeVisible({ timeout: 15_000 });
	});

	test("assistant session opens from the rail with its reset control", async ({ page }) => {
		await gotoPage(page, "/");
		await page.getByRole("button", { name: /omp assistant configure omp through chat/ }).click();
		await expect(page.getByRole("button", { name: "Reset assistant" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: /Ask the assistant/ })).toBeVisible();
	});

	test("logout revokes the browser session", async ({ page }) => {
		await gotoPage(page, "/");
		await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Log out" }).click();
		await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
		// Revocation is server-side: a reload stays gated.
		await page.reload();
		await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
	});

	test("denying the tool call answers the dialog too", async ({ page }) => {
		await gotoPage(page, "/");
		const session = await createSession(page.request, { name: "e2e-deny", cwd: PROJECT_DIR, approvalMode: "write" });
		await page.goto(`/sessions/${session.id}`);

		await expect(page.getByText("Allow tool: read_file")).toBeVisible();
		await page.getByRole("button", { name: "Deny", exact: true }).click();
		await expect(page.getByText("Allow tool: read_file")).toBeHidden();
		await expect(page.getByText(/extension ui answered .*value=Deny/)).toBeVisible();
	});

	test("stopped sessions auto-restart when opened", async ({ page, request }) => {
		await login(request);
		await gotoPage(page, "/");
		const session = await createSession(request, { name: "e2e-recover", cwd: PROJECT_DIR, approvalMode: "write" });
		await request.post(`/api/sessions/${session.id}/stop`);
		await expect
			.poll(async () => {
				const body = (await (await request.get(`/api/sessions/${session.id}`)).json()) as {
					session: { status: string };
				};
				return body.session.status;
			})
			.toBe("stopped");

		// Opening the page auto-starts the agent: the header dot flips to the
		// running color (the rail copy on this page is a point-in-time snapshot).
		await page.goto(`/sessions/${session.id}`);
		await expect(page.locator("main span.h-2.w-2")).toHaveClass(/bg-sev-success/, { timeout: 15_000 });
		await expect(page.locator(".border-sev-error\\/30")).toHaveCount(0);
	});

	test("resume dialog lists the mock history and resumes it", async ({ page }) => {
		await gotoPage(page, "/");
		await page.getByRole("button", { name: "Resume omp session" }).click();
		// Mock mode serves a canned history entry for the default cwd.
		await expect(page.getByText("mock history session")).toBeVisible({ timeout: 10_000 });
		await page.getByText("mock history session").click();

		// Resuming creates a fresh web session pointed at the omp history.
		await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
		await expect(page.getByText("Welcome! This is a mock session.")).toBeVisible();
	});

	test("a second browser joins a live session and sees the turn", async ({ browser, page }) => {
		const session = await (async () => {
			await gotoPage(page, "/");
			return createSession(page.request, { name: "e2e-live", cwd: PROJECT_DIR, approvalMode: "write" });
		})();
		await page.goto(`/sessions/${session.id}`);

		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		await gotoPage(pageB, `/sessions/${session.id}`);
		await expect(pageB.getByRole("textbox", { name: /^Prompt the agent/ })).toBeVisible();

		// Dismiss A's pending approval, then run a turn from A only.
		await page.getByRole("button", { name: "Approve" }).click();
		await expect(page.getByText("Allow tool: read_file")).toBeHidden();
		const composer = page.getByRole("textbox", { name: /^Prompt the agent/ });
		await composer.fill("live join probe");
		await composer.press("Enter");

		await expect(pageB.getByRole("main").getByText("live join probe")).toBeVisible();
		await expect(pageB.getByRole("button", { name: /thinking/ })).toBeVisible();
		await ctxB.close();
	});
});
