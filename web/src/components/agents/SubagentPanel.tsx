import { GitBranch, Loader2 } from "lucide-react";
import type { SessionSnapshot } from "../../api";
import { formatDuration, formatTokens } from "../../lib/format";

export function SubagentPanel({ snapshot }: { snapshot: SessionSnapshot }) {
	const subagents = snapshot.subagents;

	if (subagents.length === 0) {
		return <div className="px-4 py-8 text-center font-mono text-[10.5px] text-fg-3">no subagents yet</div>;
	}

	return (
		<div className="space-y-2 px-3 py-3">
			{subagents.map(sub => (
				<SubagentRow key={sub.id} sub={sub} />
			))}
		</div>
	);
}

import type { WireSubagentSnapshot } from "@omp-web/shared";

function SubagentRow({ sub }: { sub: WireSubagentSnapshot }) {
	const running = sub.status === "running";
	const progress = sub.progress;
	return (
		<div className="rounded-md border border-border bg-surface-1">
			<div className="flex items-center gap-2 px-3 py-2">
				{running ? (
					<Loader2 className="h-3 w-3 shrink-0 animate-spin text-cat-subagent" />
				) : (
					<GitBranch className="h-3 w-3 shrink-0 text-cat-subagent/70" />
				)}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-mono text-[11px] text-fg-0">{sub.agent}</span>
						<span
							className={[
								"shrink-0 font-mono text-[9px] uppercase tracking-[0.1em]",
								running
									? "text-cat-subagent"
									: sub.status === "completed"
										? "text-sev-success"
										: sub.status === "failed" || sub.status === "aborted"
											? "text-sev-error"
											: "text-fg-3",
							].join(" ")}
						>
							{sub.status}
						</span>
					</div>
					{sub.task ? (
						<div className="mt-0.5 truncate font-mono text-[10px] text-fg-2" title={sub.task}>
							{sub.task}
						</div>
					) : null}
					{progress ? (
						<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9.5px] tabular text-fg-3">
							{progress.currentTool ? <span className="text-cat-tools">{progress.currentTool}</span> : null}
							<span>{progress.toolCount} tools</span>
							<span>{formatTokens(progress.tokens)} tok</span>
							<span>{formatDuration(progress.durationMs)}</span>
							{progress.resolvedModel ? <span>{progress.resolvedModel}</span> : null}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
