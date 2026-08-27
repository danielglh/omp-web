/**
 * Unit tests for the markdown rendering pipeline's less-traveled halves: the
 * entity unescape → re-escape round trip and the omp-extension tag stripping
 * inside raw HTML tokens. The link/image safety gates have their own suite in
 * markdown.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";

describe("raw html handling", () => {
	test("omp extension tags are unwrapped: tags stripped, inner text kept", () => {
		expect(renderMarkdown("<advisory>temp note</advisory>kept")).toContain("temp notekept");
		expect(renderMarkdown('<span class="x">dropped</span>after')).toContain("droppedafter");
		expect(renderMarkdown("<text>y</text>z")).toContain("yz");
	});

	test("self-closing extension tags disappear entirely", () => {
		expect(renderMarkdown("before<advisory/>after")).toContain("beforeafter");
	});

	test("entities inside raw html survive as escaped text, never live markup", () => {
		const out = renderMarkdown("&lt;img src=x onerror=alert(1)&gt;");
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img");
	});

	test("stripping an extension tag re-escapes what remains", () => {
		const out = renderMarkdown("<span>a &amp; b</span>&lt;b&gt;bold&lt;/b&gt;");
		expect(out).not.toContain("<b>bold</b>");
		expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
	});

	test("entity decoding covers named, decimal and hex references; unknowns survive verbatim", () => {
		// Block-level html arrives as one raw token, exercising the full
		// unescape → re-escape pipeline on its content.
		const out = renderMarkdown("<div>a&nbsp;b&amp;c&#65;&#x42;&unknown;&#999999999;</div>");
		expect(out).not.toContain("&nbsp;");
		// decoded nbsp/&#65;/&#x42;, while decoded '&' is re-escaped
		expect(out).toContain("a b&amp;cAB");
		expect(out).toContain("&amp;unknown;");
		expect(out).not.toContain("&#999999999;");
	});

	test("entity decoding covers named, decimal and hex references; unknowns survive verbatim", () => {
		const out = renderMarkdown("<div>a&nbsp;b&amp;c&#65;&#x42;&unknown;&#999999999;</div>");
		expect(out).not.toContain("&nbsp;");
		// decoded nbsp/&#65;/&#x42;, while decoded '&' is re-escaped
		expect(out).toContain("a b&amp;cAB");
		expect(out).toContain("&amp;unknown;");
		expect(out).not.toContain("&#999999999;");
	});

	test("the remaining named entities decode inside block-level html", () => {
		// decode → re-escape is a round trip for lt/gt/quot/apos
		const out = renderMarkdown("<div>&lt; &gt; &quot; &apos;</div>");
		expect(out).toContain("&lt; &gt; &quot;");
		expect(out).not.toContain("<div>");
	});
});

describe("basic rendering", () => {
	test("code blocks keep their content escaped", () => {
		const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
	});

	test("inline code is escaped", () => {
		const out = renderMarkdown("`<b>x</b>`");
		expect(out).toContain("<code>&lt;b&gt;x&lt;/b&gt;</code>");
	});

	test("links render with title attributes when given", () => {
		const out = renderMarkdown('[t](https://e.com "the title")');
		expect(out).toContain('title="the title"');
	});
});
