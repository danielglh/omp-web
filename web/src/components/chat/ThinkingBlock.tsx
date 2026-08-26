import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

interface ThinkingBlockProps {
	thinking: string;
	streaming?: boolean;
}

export function ThinkingBlock({ thinking, streaming }: ThinkingBlockProps) {
	const [open, setOpen] = React.useState(false);
	return (
		<div className="my-1 rounded-md border border-border bg-surface-1">
			<button
				type="button"
				onClick={() => setOpen(o => !o)}
				className="flex w-full items-center gap-1.5 px-3 py-1.5 font-mono text-[10.5px] text-fg-2 hover:text-fg-1"
			>
				{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				<span className="uppercase tracking-[0.12em]">thinking</span>
				{streaming ? <span className="ml-1 animate-pulse text-cat-ephemeral">●</span> : null}
				<span className="ml-auto tabular text-fg-3">{thinking.length} chars</span>
			</button>
			{open ? (
				<div className="max-h-72 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-1">
					{thinking}
				</div>
			) : null}
		</div>
	);
}
