/**
 * Filesystem browsing for the "working directory" picker.
 *
 * Two read-only operations, both listing directory NAMES only (never file
 * contents):
 *  - `listDir(path, showHidden)` — the subdirectories of `path` (defaults to
 *    $HOME). Hidden entries (`.`) are omitted unless `showHidden` is set.
 *  - `searchDir(prefix)` — directory candidates under the parent of `prefix`,
 *    for path auto-completion (hidden dirs excluded).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DirListing {
	path: string;
	/** Immediate parent, or `null` at the filesystem root. */
	parent: string | null;
	dirs: string[];
}

export interface DirSearch {
	prefix: string;
	/** Absolute paths of matching directories. */
	matches: string[];
}

export interface PathSearch {
	prefix: string;
	/** Absolute paths of matching files and directories. */
	matches: string[];
}

const MAX_DIRS = 500;

export function listDir(pathArg?: string, showHidden = false): DirListing {
	const home = os.homedir();
	const target = pathArg ? path.resolve(pathArg) : home;
	if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
		throw new Error(`not a directory: ${target}`);
	}
	const dirs = listSubdirs(target, showHidden);
	const parent = path.dirname(target);
	return {
		path: target,
		parent: target === parent ? null : parent,
		dirs,
	};
}

export function searchDir(prefix: string): DirSearch {
	if (!prefix) return { prefix: "", matches: [] };
	const abs = path.resolve(prefix);

	// If the prefix is itself an existing directory, offer its subdirectories.
	if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
		return { prefix: abs, matches: listSubdirs(abs, false).map(name => path.join(abs, name)) };
	}

	// Otherwise match directory names in the parent that start with the basename.
	const parent = path.dirname(abs);
	const base = path.basename(abs).toLowerCase();
	if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
		return { prefix: abs, matches: [] };
	}
	const matches = fs
		.readdirSync(parent, { withFileTypes: true })
		.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name.toLowerCase().startsWith(base))
		.map(e => path.join(parent, e.name));
	return { prefix: abs, matches };
}

/**
 * Path auto-completion for the composer's `@context` picker: matches files
 * AND directories under the parent of `prefix` (hidden entries excluded).
 * Matches are absolute paths; directories carry a trailing `/` so the picker
 * can drill down on the next keystroke.
 */
export function searchPaths(prefix: string, cwd: string): PathSearch {
	if (!prefix) return { prefix: "", matches: [] };
	const abs = path.resolve(cwd, prefix);

	// If the prefix is itself an existing directory, offer its entries.
	if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
		return { prefix: abs, matches: listEntryPaths(abs).slice(0, MAX_PATHS) };
	}

	const parent = path.dirname(abs);
	const base = path.basename(abs).toLowerCase();
	if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
		return { prefix: abs, matches: [] };
	}
	const matches = listEntryPaths(parent).filter(p => path.basename(p).toLowerCase().startsWith(base));
	return { prefix: abs, matches: matches.slice(0, MAX_PATHS) };
}

const MAX_PATHS = 50;

/** Immediate children of `dir` as absolute paths (dirs with trailing `/`). */
function listEntryPaths(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(e => !e.name.startsWith("."))
		.map(e => (e.isDirectory() ? path.join(dir, `${e.name}/`) : path.join(dir, e.name)))
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function listSubdirs(dir: string, showHidden: boolean): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(e => e.isDirectory() && (showHidden || !e.name.startsWith(".")))
		.map(e => e.name)
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
		.slice(0, MAX_DIRS);
}

/**
 * Delete an omp session file and its artifacts directory, mirroring omp's
 * `deleteSessionWithArtifacts` (`/session delete`): the artifacts live in the
 * directory formed by stripping the `.jsonl` suffix from the session file.
 */
export function deleteOmpSession(sessionFile: string): void {
	if (!sessionFile.endsWith(".jsonl")) return;
	const filePath = sessionFile;
	const artifactsDir = sessionFile.slice(0, -".jsonl".length);
	try {
		fs.rmSync(filePath, { force: true });
	} catch {
		// best-effort
	}
	try {
		if (fs.existsSync(artifactsDir)) fs.rmSync(artifactsDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}
