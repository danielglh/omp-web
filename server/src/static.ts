/**
 * Static file serving for the built web app.
 *
 * Serves the Vite `dist/` output with SPA fallback to index.html. If the dist
 * directory is missing (server started before `bun run build`), returns a
 * friendly placeholder telling the operator how to build the UI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>omp-web</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0d12; color: #e4e7ef;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { max-width: 560px; padding: 32px; border: 1px solid #1f2430; border-radius: 8px; background: #12151c; }
  h1 { font-size: 14px; letter-spacing: 0.2em; text-transform: uppercase; color: #6c7488; margin: 0 0 16px; }
  code { background: #1a1e27; padding: 2px 6px; border-radius: 4px; }
  p { font-size: 13px; line-height: 1.6; color: #a8afc0; }
</style>
</head>
<body>
<div class="card">
  <h1>omp-web</h1>
  <p>The web UI has not been built yet. Run <code>bun run build</code> in the repo root
     (or set <code>OMP_WEB_DIST_DIR</code> to a built copy), then reload this page.</p>
</div>
</body>
</html>`;

export function serveStatic(req: Request, webDistDir: string): Response {
	const url = new URL(req.url);
	let pathname = decodeURIComponent(url.pathname);

	// Path traversal guard.
	const root = path.resolve(webDistDir);
	const resolved = path.resolve(root, `.${pathname}`);
	if (!resolved.startsWith(root)) {
		return new Response("forbidden", { status: 403 });
	}

	if (pathname === "/" || pathname === "") {
		pathname = "/index.html";
	}

	// Serve an existing file (index.html at "/", hashed assets elsewhere).
	const fullPath = path.join(root, pathname);
	if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
		const ext = path.extname(fullPath).toLowerCase();
		return new Response(Bun.file(fullPath), {
			headers: {
				"content-type": MIME[ext] ?? "application/octet-stream",
				"cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
			},
		});
	}

	// SPA fallback: any non-file path serves index.html (client-side routing).
	const indexPath = path.join(root, "index.html");
	if (fs.existsSync(indexPath)) {
		return new Response(Bun.file(indexPath), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
		});
	}

	return new Response(FALLBACK_HTML, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
