/**
 * URL safety helpers shared by markdown rendering and extension-UI surfaces.
 * Everything the agent pushes at the browser (links, images, open_url frames)
 * passes through these gates before it can become markup or navigation.
 */

export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Link/image destinations for rendered markup: http(s) and mailto pass
 * through, same-document and relative references are kept, every other scheme
 * (javascript:, data:, vbscript:, file:, …) is rejected so the caller can drop
 * the href entirely.
 */
export function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme
	return trimmed; // relative / fragment
}

/** Only absolute http(s) URLs may drive window.open or direct link targets. */
export function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url.trim());
}
