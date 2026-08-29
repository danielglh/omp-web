import { expect, test } from "@playwright/test";
import { PROJECT_DIR, createSession, gotoPage } from "./helpers";

test.describe("composer interactions", () => {
	/**
	 * Open a session and return the composer textbox. Note: resolve it as a
	 * bare textbox role — its accessible name comes from the placeholder, which
	 * flips to "Queue a prompt…" mid-turn, so a name-based locator would stop
	 * resolving exactly while the agent is streaming.
	 */
	async function openSession(page: import("@playwright/test").Page, name: string) {
		await gotoPage(page, "/");
		const session = await createSession(page.request, { name, cwd: PROJECT_DIR, approvalMode: "write" });
		await page.goto(`/sessions/${session.id}`);
		const composer = page.getByRole("textbox");
		await expect(composer).toBeVisible();
		await expect(composer).toHaveAttribute("placeholder", /^Prompt the agent/);
		return composer;
	}

	test("slash picker filters and inserts the command", async ({ page }) => {
		const composer = await openSession(page, "slash");
		await composer.pressSequentially("/c");
		await expect(page.getByText("/compact")).toBeVisible();
		await page.getByText("/compact").click();
		await expect(composer).toHaveValue("/compact ");
	});

	test("@ picker searches the session cwd and inserts a relative path", async ({ page }) => {
		const composer = await openSession(page, "at-picker");
		await page.getByRole("button", { name: "Insert image, @context, or command" }).click();
		await page.getByText("Add context").click();
		const search = page.getByPlaceholder(/search under/);
		await expect(search).toBeVisible();
		await search.fill("README");
		await page.getByText("README.md", { exact: true }).click();
		await expect(composer).toHaveValue(/@README.md/);
	});

	test("thinking level switch round-trips through the agent", async ({ page }) => {
		const composer = await openSession(page, "thinking");
		await page.getByRole("button", { name: "high", exact: true }).click();
		await page.getByRole("button", { name: "max", exact: true }).click();
		// The mock answers set_thinking_level with thinking_level_changed, so
		// the chip re-renders only after a full agent roundtrip.
		await expect(page.getByRole("button", { name: "max", exact: true })).toBeVisible();
		await expect(composer).toBeVisible();
	});

	test("model picker lists the agent's models", async ({ page }) => {
		const composer = await openSession(page, "model-picker");
		await page.getByRole("button", { name: /mock\/mock-model/ }).click();
		// Chip + one menu entry = the popover opened with the model listed.
		await expect(page.getByRole("button", { name: "mock/mock-model" })).toHaveCount(2);
		await composer.press("Escape");
	});

	test("queued messages can be steered away mid-turn", async ({ page }) => {
		const composer = await openSession(page, "queue");
		await composer.fill("first probe");
		await composer.press("Enter");
		// "streaming…" only renders mid-turn; the composer placeholder is not a
		// signal (the textarea is visible either way). Queue while this shows.
		await expect(page.getByText("streaming…")).toBeVisible();
		await composer.fill("queued one");
		await composer.press("Enter");
		// The pending pill (rounded-lg) — not the flushed user bubble (rounded-md)
		// that appears if the turn drains before the click lands.
		const pill = page.locator("div.rounded-lg", { hasText: "queued one" });
		await expect(pill).toBeVisible();
		await pill.getByTitle("Steer the agent with this").click();
		await expect(pill).toBeHidden();
	});

	test("esc aborts the running turn and the composer returns to idle", async ({ page }) => {
		const composer = await openSession(page, "abort");
		await composer.fill("abort probe");
		await composer.press("Enter");
		await expect(page.getByText("streaming…")).toBeVisible();
		await composer.press("Escape");
		await expect(page.getByPlaceholder(/^Prompt the agent/)).toBeVisible({ timeout: 15_000 });
	});
});
