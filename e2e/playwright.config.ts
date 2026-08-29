import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { E2E_ROOT, TOKEN } from "./tests/helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 7399;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: path.join(here, "tests"),
	timeout: 30_000,
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL,
		viewport: { width: 1280, height: 800 },
	},
	webServer: {
		// prepare-env seeds a fresh data dir and the fixture project the
		// default cwd points at.
		command: "node e2e/scripts/prepare-env.mjs && bun run start",
		cwd: path.resolve(here, ".."),
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		env: {
			OMP_WEB_MOCK: "1",
			// Slower canned turns so tests can interact mid-turn (queue, abort).
			OMP_WEB_MOCK_STEP_MS: "600",
			OMP_WEB_TOKEN: TOKEN,
			OMP_WEB_HOST: "127.0.0.1",
			OMP_WEB_PORT: String(port),
			OMP_WEB_DATA_DIR: path.join(E2E_ROOT, "data"),
			OMP_WEB_CWD: path.join(E2E_ROOT, "project"),
		},
	},
});
