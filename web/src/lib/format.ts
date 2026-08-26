/** Time / size / misc formatting helpers. */

export function formatRelativeTime(timestamp: number | string | undefined): string {
	if (timestamp === undefined) return "—";
	const ms = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	if (Number.isNaN(ms)) return "—";
	const diff = Date.now() - ms;
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? "ago" : "ahead";
	if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s ${suffix}`;
	if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
	if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
	return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

export function formatTime(timestamp: number | string | undefined): string {
	if (timestamp === undefined) return "";
	const ms = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	if (Number.isNaN(ms)) return "";
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

export function formatTokens(tokens: number | null | undefined): string {
	if (tokens === null || tokens === undefined) return "—";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

export function formatCost(cost: { total: number } | undefined): string {
	if (!cost || typeof cost.total !== "number" || cost.total === 0) return "";
	if (cost.total < 0.01) return `$${cost.total.toFixed(4)}`;
	return `$${cost.total.toFixed(2)}`;
}

export function shortId(id: string, length = 10): string {
	return id.length <= length ? id : id.slice(0, length);
}

export function truncate(text: string, max = 120): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}
