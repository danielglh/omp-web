/**
 * Markdown renderer with the same safety posture as omp's collab-web:
 * raw HTML is escaped (never emitted), link AND image destinations are
 * restricted to safe schemes, external links open in a new tab, and image alt
 * text is always attribute-escaped.
 */
import { Marked } from "marked";
import { memo, useMemo } from "react";
import type { ReactNode } from "react";
import { escapeHtml, safeHref } from "./url";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {
				// invalid code point
			}
		}
		return "";
	};
	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = String(entity).toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				if (lower.startsWith("#")) return parseCodePoint(Number(lower.slice(1)));
				return match;
			}
		}
	});
}

const md = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			const cleaned = String(text).replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
		image({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens, this.parser.textRenderer);
			const url = safeHref(href);
			// Unsafe destination → render only the alt text, never an <img>.
			if (url === null) return escapeHtml(text);
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttr}>`;
		},
	},
});

/** Render untrusted agent markdown to an HTML string (safe for innerHTML). */
export function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false }) as string;
	} catch {
		return escapeHtml(text);
	}
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	// biome-ignore lint/security/noDangerouslySetInnerHtml: raw HTML is escaped by the renderer above
	return <div className={className ? `md-body ${className}` : "md-body"} dangerouslySetInnerHTML={{ __html: html }} />;
});
