import { expect, test } from "@playwright/test";
import { PROJECT_DIR, createSession, gotoPage } from "./helpers";

test.describe("side panels and settings", () => {
	async function openSession(page: import("@playwright/test").Page, name: string) {
		await gotoPage(page, "/");
		const session = await createSession(page.request, { name, cwd: PROJECT_DIR, approvalMode: "write" });
		await page.goto(`/sessions/${session.id}`);
		await expect(page.getByRole("textbox", { name: /^Prompt the agent/ })).toBeVisible();
		// Clear the mock's startup approval so its "path: README.md" card can't
		// collide with files-panel assertions below.
		const approve = page.getByRole("button", { name: "Approve", exact: true });
		if (await approve.isVisible()) {
			await approve.click();
			await expect(approve).toBeHidden();
		}
	}

	test("files panel lists the cwd and previews markdown", async ({ page }) => {
		await openSession(page, "files");
		await page.getByRole("button", { name: "files", exact: true }).click();
		const panel = page.locator("aside").filter({ has: page.getByRole("button", { name: "files", exact: true }) });
		await expect(panel.getByText("README.md")).toBeVisible();
		await expect(panel.getByText("sub", { exact: true })).toBeVisible();

		await panel.getByText("README.md").click();
		await expect(page.getByText("layout probe project")).toBeVisible();
		await expect(page.getByText("Seeded for e2e assertions.")).toBeVisible();
	});

	test("context panel shows usage, stats, and the export path", async ({ page }) => {
		await openSession(page, "context");
		await page.getByRole("button", { name: "context", exact: true }).click();
		await expect(page.getByText("context window")).toBeVisible();
		await expect(page.getByText("session stats")).toBeVisible();

		await page.getByTitle("Export this session to a standalone HTML file (agent side)").click();
		await expect(page.locator('a[title="/mock/export.html"]')).toBeVisible();
	});

	test("agents panel lists subagents from the snapshot", async ({ page }) => {
		await openSession(page, "agents");
		await page.getByRole("button", { name: "agents", exact: true }).click();
		await expect(page.getByText("explorer")).toBeVisible();
		await expect(page.getByText("map the repository layout")).toBeVisible();
	});

	test("settings: roles editor, catalog filter, save without errors", async ({ page }) => {
		await gotoPage(page, "/settings");
		await expect(page.getByText(/model roles/i)).toBeVisible();
		await expect(page.getByText("defaultThinkingLevel")).toBeVisible();

		const filter = page.getByPlaceholder(/filter keys or descriptions/i);
		await filter.fill("approval");
		await expect(page.getByText("tools.approvalMode")).toBeVisible();
		await expect(page.getByText("autoResume")).toBeHidden();
		await filter.fill("");

		// Dirty the draft so save becomes enabled; the mock answers the
		// config PUT with ok, so no error strip may appear.
		await page.getByPlaceholder("(omp built-in default)").fill("mock/mock-model");
		await page.getByRole("button", { name: /save roles/i }).click();
		await expect(page.locator(".text-sev-error")).toHaveCount(0);
	});

	test("theme toggle flips data-theme and persists across reloads", async ({ page }) => {
		await gotoPage(page, "/");
		const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
		await page.getByRole("button", { name: "Toggle theme" }).click();
		const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
		expect(after).toBeTruthy();
		expect(after).not.toBe(before);

		await page.reload();
		await expect(page.evaluate(() => document.documentElement.getAttribute("data-theme"))).resolves.toBe(after);
	});
});
