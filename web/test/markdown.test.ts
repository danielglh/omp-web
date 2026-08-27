/**
 * Unit tests for the browser's URL-safety + markdown rendering primitives
 * (both gate agent-controlled content before it can become markup).
 *
 * Run from the repo root via `bun run test` or directly: `cd web && bun test`.
 */
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";
import { isHttpUrl, safeHref } from "../src/lib/url";

describe("safeHref", () => {
	test("allows http(s), mailto, and same-document references", () => {
		for (const ok of [
			"https://example.com/a?b=c#d",
			"http://localhost:7367/x",
			"mailto:user@example.com",
			"#section",
			"relative/path.html",
		]) {
			expect(safeHref(ok)).toBe(ok);
		}
	});

	test("rejects script-executing and exotic schemes", () => {
		for (const bad of [
			"javascript:alert(1)",
			"JAVASCRIPT:alert(1)",
			"data:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox",
			"file:///etc/passwd",
		]) {
			expect(safeHref(bad)).toBe(null);
		}
	});
});

describe("isHttpUrl", () => {
	test("only absolute http(s) URLs qualify for window.open / <a> targets", () => {
		expect(isHttpUrl("https://oauth.example/cb")).toBe(true);
		expect(isHttpUrl("http://127.0.0.1:9/ping")).toBe(true);
		expect(isHttpUrl("javascript:alert(1)")).toBe(false);
		expect(isHttpUrl("data:text/html,x")).toBe(false);
		expect(isHttpUrl("relative")).toBe(false);
	});
});

describe("renderMarkdown", () => {
	test("escapes raw HTML, including tags that look like omp extensions", () => {
		const out = renderMarkdown("before <script>alert(1)</script> after\n\n<img src=x onerror=alert(2)>");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("<img src=x");
		expect(out).toContain("&lt;script&gt;");
	});

	test("links keep their href but drop dangerous schemes entirely", () => {
		const ok = renderMarkdown("[click](https://ok.example)");
		expect(ok).toContain('href="https://ok.example"');
		const evil = renderMarkdown("[click](javascript:alert(1))");
		expect(evil).not.toContain("<a ");
		expect(evil).not.toContain("javascript:");
	});

	test("images never emit a src for non-http schemes", () => {
		const out = renderMarkdown("![pic](javascript:alert(1))");
		expect(out).not.toContain("<img");
		const outData = renderMarkdown("![pic](data:text/html;base64,AAA)");
		expect(outData).not.toContain("<img");
	});

	test("image alt text cannot break out of its attribute", () => {
		const out = renderMarkdown("![<img src=q onerror=alert(3)>](https://example.com/a.png)");
		expect(out).toContain("<img");
		expect(out).not.toContain('alt="<img');
	});

	test("trusted image URLs survive rendering", () => {
		const out = renderMarkdown("![logo](https://cdn.example/logo.png)");
		expect(out).toContain('src="https://cdn.example/logo.png"');
	});
});
