import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import * as React from "react";
import type { ToolExecution } from "../../api";
import { formatDuration } from "../../lib/format";
import { JsonViewer } from "../shared/JsonViewer";

interface ToolCallCardProps {
	name: string;
	args: unknown;
	intent?: string;
	execution?: ToolExecution;
}

function sizeOf(value: unknown): number {
	if (typeof value === "string") return value.length;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

export function ToolCallCard({ name, args, intent, execution }: ToolCallCardProps) {
	const [open, setOpen] = React.useState(false);
	const running = execution?.status === "running";
	const isError = execution?.isError === true;
	const result = execution?.result;
	const resultSize = result !== undefined ? sizeOf(result) : 0;

	return (
		<div
			className={[
				"my-1 rounded-md border bg-surface-1",
				running ? "border-cat-tools/60" : isError ? "border-sev-error/60" : "border-border",
			].join(" ")}
		>
			<button
				type="button"
				onClick={() => setOpen(o => !o)}
				className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
			>
				{open ? (
					<ChevronDown className="h-3 w-3 shrink-0 text-fg-3" />
				) : (
					<ChevronRight className="h-3 w-3 shrink-0 text-fg-3" />
				)}
				<span
					className={[
						"shrink-0 font-mono text-[10px] uppercase tracking-[0.12em]",
						running ? "text-cat-tools" : isError ? "text-sev-error" : "text-cat-tools",
					].join(" ")}
				>
					{running ? "running" : isError ? "failed" : "tool"}
				</span>
				<span className="truncate font-mono text-[11.5px] text-fg-0">{name}</span>
				{running ? <Loader2 className="ml-1 h-3 w-3 shrink-0 animate-spin text-cat-tools" /> : null}
				{intent ? (
					<span className="hidden truncate font-mono text-[10.5px] text-fg-2 min-[480px]:inline">— {intent}</span>
				) : null}
				{!open && !running && result !== undefined ? (
					<span className="ml-auto shrink-0 font-mono text-[10px] tabular text-fg-3">
						{isError ? "error · " : ""}
						{resultSize} chars
					</span>
				) : (
					<span className="ml-auto shrink-0 font-mono text-[10px] tabular text-fg-3">
						{execution ? formatDuration(Date.now() - execution.startedAt) : ""}
					</span>
				)}
			</button>
			{open ? (
				<div className="space-y-2 border-t border-border px-3 py-2">
					<div>
						<div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-3">args</div>
						<JsonViewer value={args} />
					</div>
					{result !== undefined ? (
						<div>
							<div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-3">
								{running ? "result (streaming)" : "result"}
							</div>
							<JsonViewer value={result} />
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
