import { type Locator, expect, test } from "@playwright/test";
import { createSession, gotoPage } from "./helpers";

// The reported breakages were phone-width; the ladder covers phone (incl. the
// 320px floor), tablet (md), and the lg+ desktops where the layout switches.
const VIEWPORTS = [
	{ width: 320, height: 700 },
	{ width: 390, height: 844 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
	{ width: 1440, height: 900 },
];

/** Fail when `inner` pokes outside `outer` (the composer-overflow bug class). */
async function expectContained(outer: Locator, inner: Locator) {
	const outerBox = await outer.boundingBox();
	const innerBox = await inner.boundingBox();
	expect(outerBox, "composer container has a box").toBeTruthy();
	expect(innerBox, "primary button has a box").toBeTruthy();
	expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x);
	expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
	expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
}

for (const viewport of VIEWPORTS) {
	test(`layout ${viewport.width}x${viewport.height}: single header actions, no horizontal overflow, composer contained`, async ({
		page,
	}) => {
		const session = await (async () => {
			await gotoPage(page, "/");
			return createSession(page.request, { name: "layout-probe", cwd: "/tmp", approvalMode: "write" });
		})();
		await page.setViewportSize(viewport);
		await page.goto(`/sessions/${session.id}`);
		await expect(page.getByRole("textbox", { name: /^Prompt the agent/ })).toBeVisible();

		// The global actions live in exactly one place per viewport: the mobile
		// top bar below lg, the session header at lg+. Catches the "rendered
		// twice on phones" bug class.
		for (const label of ["Log out", "Settings", "Toggle theme"]) {
			await expect(page.locator(`button[aria-label="${label}"]:visible`)).toHaveCount(1);
		}

		// Nothing leaks horizontally at this size (generic overflow catcher).
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(overflow, "no horizontal overflow").toBeLessThanOrEqual(1);

		// The composer's primary button stays inside the composer box — idle,
		// mid-turn/queued, and after everything drains.
		const composerBox = page.locator("div.rounded-xl:has(textarea)");
		const primary = composerBox.locator("button.rounded-full.border-cat-conversation");

		const composer = page.getByRole("textbox", { name: /^Prompt the agent/ });
		await composer.fill("layout probe one");
		await composer.press("Enter");
		// Queue a second message while the first turn streams (the state the
		// reported overflow reproduced in); if the turn already drained this
		// simply starts the second turn — containment holds either way.
		await composer.fill("layout probe two");
		await composer.press("Enter");
		await expectContained(composerBox, primary);

		await expect(page.getByPlaceholder(/^Prompt the agent/)).toBeVisible({ timeout: 15_000 });
		await expectContained(composerBox, primary);
	});
}
