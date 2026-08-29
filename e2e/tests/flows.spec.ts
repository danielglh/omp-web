import { expect, test } from "@playwright/test";
import { TOKEN, gotoPage } from "./helpers";

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
});
