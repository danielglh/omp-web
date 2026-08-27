/**
 * Unit tests for the filesystem helpers behind the directory/file pickers and
 * — most importantly — `deleteOmpSession`, the only function in the codebase
 * that destroys user files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteOmpSession, listDir, searchDir, searchPaths } from "../src/fs";

let root: string;
let scratch: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fs-root-"));
	fs.mkdirSync(path.join(root, "alpha"));
	fs.mkdirSync(path.join(root, "alpha", "nested"));
	fs.mkdirSync(path.join(root, "alphabet"));
	fs.mkdirSync(path.join(root, ".hidden"));
	fs.writeFileSync(path.join(root, "file.txt"), "x");
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fs-scratch-"));
});

afterAll(() => {
	for (const dir of [root, scratch]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

describe("listDir", () => {
	test("lists subdirectories only, resolves parent, hides hidden by default", () => {
		const listing = listDir(root);
		expect(listing.path).toBe(root);
		expect(listing.parent).toBe(path.dirname(root));
		expect(listing.dirs.sort()).toEqual(["alpha", "alphabet"]);
	});

	test("showHidden reveals dot directories", () => {
		expect(listDir(root, true).dirs.sort()).toEqual([".hidden", "alpha", "alphabet"]);
	});

	test("defaults to the home directory", () => {
		expect(listDir().path).toBe(os.homedir());
	});

	test("filesystem root has no parent", () => {
		expect(listDir("/").parent).toBe(null);
	});

	test("files and missing paths are rejected", () => {
		expect(() => listDir(path.join(root, "file.txt"))).toThrow();
		expect(() => listDir(path.join(root, "missing"))).toThrow();
	});
});

describe("searchDir", () => {
	test("an existing directory offers its subdirectories", () => {
		const res = searchDir(root);
		expect(res.matches.sort()).toEqual([path.join(root, "alpha"), path.join(root, "alphabet")].sort());
	});

	test("basename prefix matches subdirectories case-insensitively", () => {
		expect(searchDir(path.join(root, "ALPH")).matches.sort()).toEqual([
			path.join(root, "alpha"),
			path.join(root, "alphabet"),
		]);
	});

	test("no basename match, missing parent, or empty prefix yields no matches", () => {
		expect(searchDir(path.join(root, "zzz")).matches).toEqual([]);
		expect(searchDir("/definitely/not/here/xx").matches).toEqual([]);
		expect(searchDir("").matches).toEqual([]);
	});
});

describe("searchPaths", () => {
	test("an existing directory lists files and dirs (dirs with trailing slash)", () => {
		const res = searchPaths("./", root);
		expect(res.matches).toEqual([
			`${path.join(root, "alpha")}/`,
			`${path.join(root, "alphabet")}/`,
			path.join(root, "file.txt"),
		]);
	});

	test("prefix narrows entries under the parent, hidden excluded", () => {
		expect(searchPaths("alph", root).matches).toEqual([
			`${path.join(root, "alpha")}/`,
			`${path.join(root, "alphabet")}/`,
		]);
		expect(searchPaths("file", root).matches).toEqual([path.join(root, "file.txt")]);
		expect(searchPaths(".hidden", root).matches).toEqual([]);
	});

	test("empty prefix yields no matches", () => {
		expect(searchPaths("", root).matches).toEqual([]);
	});
});

describe("deleteOmpSession", () => {
	test("removes the session file and its artifacts directory", () => {
		const file = path.join(scratch, "session-1.jsonl");
		fs.writeFileSync(file, "{}");
		const artifacts = path.join(scratch, "session-1");
		fs.mkdirSync(artifacts);
		fs.writeFileSync(path.join(artifacts, "img.png"), "x");

		deleteOmpSession(file);

		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(artifacts)).toBe(false);
	});

	test("refuses paths that do not end in .jsonl", () => {
		const file = path.join(scratch, "keep-me.txt");
		fs.writeFileSync(file, "precious");
		deleteOmpSession(file);
		expect(fs.existsSync(file)).toBe(true);
	});

	test("a missing session file does not throw", () => {
		expect(() => deleteOmpSession(path.join(scratch, "nope.jsonl"))).not.toThrow();
	});
});
