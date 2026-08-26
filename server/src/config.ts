/**
 * Server configuration. Environment variables win over config-file values,
 * which win over defaults, so the server can be deployed anywhere without
 * code changes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ServerConfig {
	host: string;
	port: number;
	/** Directory for the server's own state (session registry JSON). */
	dataDir: string;
	/** Absolute path to the `omp` binary; falls back to PATH lookup. */
	ompBin: string;
	/** Directory of the built web app (dist/) served at `/`. */
	webDistDir: string;
	/** Default workspace directory for new sessions when none is given. */
	defaultCwd: string;
	/** Extra args passed to every `omp --mode rpc` spawn. */
	ompExtraArgs: string[];
	/** Spawn the bundled mock RPC host instead of real omp (offline dev/testing). */
	mockMode: boolean;
	/** Path to the mock RPC host script (used when mockMode is set). */
	mockScriptPath: string;
	/** Pre-shared access token; empty disables auth (local dev default). */
	authToken: string;
	/** Where the effective authToken came from (for the startup log). */
	authTokenSource: "cli" | "env" | "file" | "disabled";
}

/** Values read from `<dataDir>/config.json` (unknown keys are ignored). */
interface ConfigFileValues {
	authToken?: string;
}

function envPath(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value : fallback;
}

/**
 * Read `<dataDir>/config.json`. Prefer a locked-down file: warn when it is
 * group/world readable since it may hold the access token.
 */
function readConfigFile(dataDir: string): ConfigFileValues {
	const file = path.join(dataDir, "config.json");
	try {
		if (!fs.existsSync(file)) return {};
		const mode = fs.statSync(file).mode & 0o777;
		if (mode & 0o077) {
			console.warn(`[omp-web] ${file} is group/world readable — chmod 600 it (it may hold the access token).`);
		}
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFileValues;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error) {
		console.warn(`[omp-web] cannot read ${file}: ${error}`);
		return {};
	}
}

function resolveAuthToken(
	overrides: Partial<ServerConfig>,
	dataDir: string,
): Pick<ServerConfig, "authToken" | "authTokenSource"> {
	if (overrides.authToken !== undefined) {
		return { authToken: overrides.authToken, authTokenSource: overrides.authToken ? "cli" : "disabled" };
	}
	const env = process.env.OMP_WEB_TOKEN;
	if (env !== undefined && env.trim().length > 0) {
		return { authToken: env, authTokenSource: "env" };
	}
	const fromFile = String(readConfigFile(dataDir).authToken ?? "").trim();
	if (fromFile) return { authToken: fromFile, authTokenSource: "file" };
	return { authToken: "", authTokenSource: "disabled" };
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
	const dataDir = path.resolve(overrides.dataDir ?? envPath("OMP_WEB_DATA_DIR", path.join(os.homedir(), ".omp-web")));
	const webDistDir = path.resolve(
		overrides.webDistDir ?? envPath("OMP_WEB_DIST_DIR", path.join(import.meta.dir, "..", "..", "web", "dist")),
	);
	return {
		host: overrides.host ?? envPath("OMP_WEB_HOST", "0.0.0.0"),
		port: overrides.port ?? Number(envPath("OMP_WEB_PORT", "7367")),
		dataDir,
		ompBin: overrides.ompBin ?? envPath("OMP_WEB_OMP_BIN", "omp"),
		webDistDir,
		defaultCwd: overrides.defaultCwd ?? envPath("OMP_WEB_CWD", os.homedir()),
		ompExtraArgs: overrides.ompExtraArgs ?? process.env.OMP_WEB_OMP_ARGS?.split(/\s+/) ?? [],
		mockMode: overrides.mockMode ?? process.env.OMP_WEB_MOCK === "1",
		mockScriptPath: overrides.mockScriptPath ?? path.join(import.meta.dir, "..", "scripts", "mock-rpc-host.ts"),
		...resolveAuthToken(overrides, dataDir),
	};
}

export const DEFAULT_PORT = 7367;
