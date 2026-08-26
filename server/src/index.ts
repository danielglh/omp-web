/**
 * omp-web server entrypoint.
 *
 *   bun run dev          — dev mode (bun --watch)
 *   OMP_WEB_PORT=7367    — port override
 *   OMP_WEB_TOKEN=…      — access token (env; overrides the config file)
 *
 * The auth token can also live in <dataDir>/config.json (recommended, chmod 600):
 *   { "authToken": "…" }
 * With no token configured anywhere, auth is disabled (local dev default).
 *
 * The server spawns `omp --mode rpc` subprocesses per session and bridges the
 * JSON-lines RPC protocol to browser WebSockets; it also serves the built web
 * app from `web/dist`.
 */
import * as fs from "node:fs";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { SessionManager } from "./sessions/manager";

async function main(): Promise<void> {
	const config = loadConfig();

	// Ensure the data dir exists before the manager persists to it.
	try {
		fs.mkdirSync(config.dataDir, { recursive: true });
	} catch (error) {
		console.error(`[omp-web] cannot create data dir ${config.dataDir}: ${error}`);
		process.exit(1);
	}

	const manager = new SessionManager(config);
	await manager.load();

	const { server, port } = createApp({ config, manager });

	console.log(`[omp-web] listening on http://${config.host}:${port}`);
	console.log(`[omp-web] data dir: ${config.dataDir}`);
	console.log(`[omp-web] agent binary: ${config.mockMode ? `mock (${config.mockScriptPath})` : config.ompBin}`);
	console.log(
		`[omp-web] auth: ${
			config.authToken
				? `token required (${config.authTokenSource === "file" ? `${config.dataDir}/config.json` : "OMP_WEB_TOKEN"})`
				: "disabled (set authToken in <dataDir>/config.json or OMP_WEB_TOKEN to enable)"
		}`,
	);
	if (!fs.existsSync(config.webDistDir)) {
		console.warn(`[omp-web] web dist not found at ${config.webDistDir} — run \`bun run build\` in the repo root.`);
	}
	console.log(`[omp-web] sessions: ${manager.list().length} on disk`);

	const shutdown = async (signal: string) => {
		console.log(`\n[omp-web] ${signal} received, shutting down…`);
		await manager.shutdown();
		server.stop(true);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch(error => {
	console.error("[omp-web] fatal:", error);
	process.exit(1);
});
