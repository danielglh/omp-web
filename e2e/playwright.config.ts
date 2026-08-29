import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { TOKEN } from "./tests/helpers";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 7399;
const baseURL = `http://127.0.0.1:${port}`;
// Fresh state per run: the server reopens whatever sessions.json holds, so a
// dirty dir would leak sessions from a previous run into the rail.
const dataDir = path.join(process.env.TMPDIR ?? "/tmp", "omp-web-e2e");

export default defineConfig({
	testDir: path.join(here, "tests"),
	timeout: 30_000,
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL,
		viewport: { width: 1280, height: 800 },
	},
	webServer: {
		command: `rm -rf ${dataDir} && bun run start`,
		cwd: path.resolve(here, ".."),
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		env: {
			OMP_WEB_MOCK: "1",
			OMP_WEB_TOKEN: TOKEN,
			OMP_WEB_HOST: "127.0.0.1",
			OMP_WEB_PORT: String(port),
			OMP_WEB_DATA_DIR: dataDir,
		},
	},
});
