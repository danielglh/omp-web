/**
 * omp CLI bridge + on-disk session listing.
 *
 * omp has no config RPC, but its CLI is machine-readable:
 *  - `omp config list --json` — every setting key with type/description/value
 *  - `omp config set|reset <key> [value]` — validated writes (record values
 *    are set as whole JSON strings; dotted sub-keys are NOT supported)
 *  - `omp models ls --json` — the resolved model catalog
 * Session history lives under `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`;
 * the first lines carry a fixed title slot + session header, which is all we
 * need to list resumable sessions for a cwd.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface OmpConfigEntry {
	key: string;
	value?: unknown;
	type: string;
	description?: string;
}

export interface OmpModelSummary {
	provider: string;
	id: string;
	name?: string;
}

export interface OmpSessionSummary {
	/** Absolute path to the session .jsonl file (for --session resume). */
	file: string;
	/** omp session id (from the header line). */
	id: string;
	title?: string;
	cwd?: string;
	createdAt?: number;
	updatedAt: number;
	sizeBytes: number;
}

const CLI_TIMEOUT_MS = 20_000;

/** Run the omp CLI and capture stdout; non-zero exit rejects with stderr. */
export function runOmpCli(bin: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = Bun.spawn([bin, ...args], {
			cwd: os.homedir(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`omp ${args[0]} timed out`));
		}, CLI_TIMEOUT_MS);
		timer.unref?.();
		proc.exited.then(async code => {
			clearTimeout(timer);
			const stdout = await new Response(proc.stdout).text();
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const stderr = await new Response(proc.stderr).text();
			reject(new Error(stderr.trim() || `omp ${args.join(" ")} exited with ${code}`));
		});
	});
}

function parseCliJson<T>(stdout: string): T {
	return JSON.parse(stdout) as T;
}

/** Full settings catalog (`omp config list --json`). */
export async function ompConfigList(bin: string): Promise<OmpConfigEntry[]> {
	const raw = parseCliJson<Record<string, { value?: unknown; type?: string; description?: string }>>(
		await runOmpCli(bin, ["config", "list", "--json"]),
	);
	return Object.entries(raw).map(([key, entry]) => ({
		key,
		value: entry.value,
		type: entry.type ?? "string",
		description: entry.description || undefined,
	}));
}

export function ompConfigPath(bin: string): Promise<string> {
	return runOmpCli(bin, ["config", "path"]).then(out => out.trim());
}

/**
 * Set a config key. Values are strings; records (e.g. `modelRoles`) must be
 * whole JSON objects — omp rejects dotted sub-keys.
 */
export async function ompConfigSet(bin: string, key: string, value: string): Promise<void> {
	await runOmpCli(bin, ["config", "set", key, value]);
}

export async function ompConfigReset(bin: string, key: string): Promise<void> {
	await runOmpCli(bin, ["config", "reset", key]);
}

/** Model catalog (`omp models ls --json`). */
export async function ompModelList(bin: string): Promise<OmpModelSummary[]> {
	const raw = parseCliJson<{ models?: OmpModelSummary[] }>(await runOmpCli(bin, ["models", "ls", "--json"]));
	return raw.models ?? [];
}

const MAX_SESSION_SCAN = 1000;

/**
 * List resumable omp sessions whose header cwd matches. The encoded directory
 * name is not decoded — instead every file's header line (first 2 KiB) is read
 * and matched by its recorded `cwd`, which is robust across encodings.
 */
export function listOmpSessions(cwd: string, limit = 100): OmpSessionSummary[] {
	const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const wanted = path.resolve(cwd);
	const out: OmpSessionSummary[] = [];
	const candidates: Array<{ file: string; mtime: number }> = [];
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		let files: fs.Dirent[];
		try {
			files = fs.readdirSync(path.join(sessionsRoot, dir.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.name.endsWith(".jsonl")) continue;
			const full = path.join(sessionsRoot, dir.name, file.name);
			try {
				candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs });
			} catch {
				// racing delete
			}
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);

	let scanned = 0;
	for (const candidate of candidates) {
		if (out.length >= limit || scanned >= MAX_SESSION_SCAN) break;
		scanned++;
		let sizeBytes = 0;
		try {
			sizeBytes = fs.statSync(candidate.file).size;
		} catch {
			continue;
		}
		const summary = parseSessionHeader(candidate.file);
		if (!summary || summary.cwd !== wanted) continue;
		out.push({ ...summary, updatedAt: candidate.mtime, sizeBytes });
	}
	return out;
}

/** Read the title + session header lines from a session file (first 2 KiB). */
function parseSessionHeader(file: string): Omit<OmpSessionSummary, "updatedAt" | "sizeBytes"> | undefined {
	let head: string;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(2048);
			const read = fs.readSync(fd, buf, 0, buf.length, 0);
			head = buf.subarray(0, read).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	let title: string | undefined;
	let header: { id?: string; cwd?: string; timestamp?: string } | undefined;
	for (const line of head.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			break; // header region ended (padded title line is valid JSON already)
		}
		if (parsed.type === "title" && typeof parsed.title === "string") {
			title = parsed.title;
		} else if (parsed.type === "session") {
			header = parsed as { id?: string; cwd?: string; timestamp?: string };
			break;
		}
	}
	if (!header?.id) return undefined;
	return {
		file,
		id: header.id,
		title,
		cwd: header.cwd,
		createdAt: header.timestamp ? Date.parse(header.timestamp) || undefined : undefined,
	};
}
