// Seeds the throwaway environment the e2e server runs against: the server
// data dir (fresh per run — the server reopens sessions.json) and a fixture
// project for the files-panel / @-picker tests. Mirrors the root path
// computed in e2e/tests/helpers.ts.
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(process.env.TMPDIR ?? "/tmp", "omp-web-e2e");
fs.rmSync(root, { recursive: true, force: true });

const dataDir = path.join(root, "data");
const project = path.join(root, "project");
for (const dir of [dataDir, path.join(project, "sub")]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(project, "README.md"), "# layout probe project\n\nSeeded for e2e assertions.\n");
fs.writeFileSync(path.join(project, "sub", "note.txt"), "note\n");
