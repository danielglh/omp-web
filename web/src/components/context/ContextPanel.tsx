import { Download, FileCode2, RotateCw } from "lucide-react";
import * as React from "react";
import type { SessionSnapshot, SessionStore } from "../../api";
import { formatTokens } from "../../lib/format";

export function ContextPanel({ store, snapshot }: { store: SessionStore; snapshot: SessionSnapshot }) {
	const state = snapshot.state;
	const usage = state?.contextUsage;
	const percent = usage?.percent ?? null;
	const stats = snapshot.sessionStats;

	// Fetch stats when the panel mounts / reconnects; the refresh button
	// re-fetches after turns. The extra deps are intentional refetch triggers.
	const messagesLength = snapshot.messages.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch as the transcript grows / after stats arrive
	React.useEffect(() => {
		if (snapshot.phase === "connected") store.fetchSessionStats();
	}, [store, snapshot.phase, messagesLength, snapshot.sessionStats === undefined]);

	return (
		<div className="space-y-4 px-4 py-4">
			<section>
				<div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">context window</div>
				{percent === null ? (
					<div className="font-mono text-[10.5px] text-fg-3">—</div>
				) : (
					<div>
						<div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
							<div
								className={[
									"h-full rounded-full",
									percent > 80 ? "bg-sev-error" : percent > 50 ? "bg-sev-warning" : "bg-cat-conversation",
								].join(" ")}
								style={{ width: `${Math.min(100, percent)}%` }}
							/>
						</div>
						<div className="mt-1 flex justify-between font-mono text-[10px] tabular text-fg-2">
							<span>
								{usage?.tokens !== null && usage?.tokens !== undefined ? formatTokens(usage.tokens) : "—"}
							</span>
							<span>{percent.toFixed(1)}%</span>
							<span>
								{usage?.contextWindow !== null && usage?.contextWindow !== undefined
									? formatTokens(usage.contextWindow)
									: "—"}
							</span>
						</div>
					</div>
				)}
			</section>

			<section className="space-y-1.5">
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">agent state</div>
				<StatRow label="model" value={state?.model ? `${state.model.provider}/${state.model.id}` : "—"} />
				<StatRow label="thinking" value={state?.thinkingLevel ?? "inherit"} />
				<StatRow
					label="streaming"
					value={state?.isStreaming ? "yes" : "no"}
					accent={state?.isStreaming ? "text-cat-assistant" : undefined}
				/>
				<StatRow label="messages" value={state?.messageCount !== undefined ? String(state.messageCount) : "—"} />
				<StatRow label="tokens/s" value={state?.tokensPerSecond != null ? String(state.tokensPerSecond) : "—"} />
				<StatRow label="auto-compact" value={state?.autoCompactionEnabled ? "on" : "off"} />
				<StatRow label="fast mode" value={state?.fastModeActive ? "on" : "off"} />
				<StatRow label="session id" value={state?.sessionId ?? "—"} mono />
			</section>

			<section className="space-y-1.5">
				<div className="flex items-center justify-between">
					<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">session stats</span>
					<button
						type="button"
						onClick={() => store.fetchSessionStats()}
						className="flex h-5 w-5 items-center justify-center rounded text-fg-3 hover:text-fg-0"
						title="Refresh stats"
					>
						<RotateCw className="h-3 w-3" />
					</button>
				</div>
				{stats ? (
					<>
						<StatRow label="user msgs" value={String(stats.userMessages)} />
						<StatRow label="assistant msgs" value={String(stats.assistantMessages)} />
						<StatRow label="tool calls" value={String(stats.toolCalls)} />
						<StatRow label="tokens in" value={formatTokens(stats.tokens.input)} />
						<StatRow label="tokens out" value={formatTokens(stats.tokens.output)} />
						<StatRow label="cache read" value={formatTokens(stats.tokens.cacheRead)} />
						<StatRow label="cost" value={`$${stats.cost.toFixed(4)}`} />
					</>
				) : (
					<div className="font-mono text-[10.5px] text-fg-3">—</div>
				)}
			</section>

			<section className="space-y-1.5">
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">export</div>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => store.exportHtml()}
						className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 font-mono text-[10.5px] text-fg-1 hover:border-border-strong hover:bg-surface-2"
						title="Export this session to a standalone HTML file (agent side)"
					>
						<FileCode2 className="h-3 w-3 text-cat-meta" />
						export html
					</button>
					{snapshot.exportPath ? (
						<a
							href={`/api/fs/file?download=1&path=${encodeURIComponent(snapshot.exportPath)}`}
							className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-cat-conversation/50 px-2 py-1.5 font-mono text-[10.5px] text-cat-conversation hover:bg-cat-conversation/10"
							title={snapshot.exportPath}
						>
							<Download className="h-3 w-3" />
							download
						</a>
					) : null}
				</div>
			</section>
		</div>
	);
}

function StatRow({ label, value, accent, mono }: { label: string; value: string; accent?: string; mono?: boolean }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<span className="shrink-0 font-mono text-[10.5px] text-fg-3">{label}</span>
			<span
				className={[
					"min-w-0 truncate text-right font-mono text-[10.5px]",
					mono ? "text-fg-1" : "text-fg-2",
					accent ?? "",
				].join(" ")}
				title={value}
			>
				{value}
			</span>
		</div>
	);
}
