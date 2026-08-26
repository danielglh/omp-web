import type { WireImageContent } from "@omp-web/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import type { RenderedMessage, ToolExecution } from "../../api";
import { formatTime } from "../../lib/format";
import { AssistantContent } from "./AssistantContent";

interface MessageBubbleProps {
	entry: RenderedMessage;
	executions?: Map<string, ToolExecution>;
}

export function MessageBubble({ entry, executions }: MessageBubbleProps) {
	const { message, streaming } = entry;

	if (message.role === "user") {
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		const text = blocks.map(b => (b.type === "text" ? b.text : "")).join("\n");
		const images = blocks.filter((b): b is WireImageContent => b.type === "image");
		return (
			<div className="flex items-start gap-2 px-3 py-2 sm:gap-3 sm:px-4">
				<RoleLabel color="text-user" label="you" />
				<div className="min-w-0 flex-1">
					<div className="rounded-md border border-border bg-surface-2 px-3 py-2">
						{text ? (
							<div className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-0">{text}</div>
						) : null}
						{images.length > 0 ? (
							<div className="flex flex-wrap gap-1.5 pt-1">
								{images.map((image, index) => (
									<img
										// biome-ignore lint/suspicious/noArrayIndexKey: images carry no stable identity
										key={index}
										src={image.url ?? `data:${image.mimeType};base64,${image.data}`}
										alt="attached"
										className="max-h-40 rounded border border-border"
									/>
								))}
							</div>
						) : null}
					</div>
					<div className="mt-1 font-mono text-[9.5px] text-fg-3">{formatTime(message.timestamp)}</div>
				</div>
			</div>
		);
	}

	if (message.role === "toolResult") {
		return (
			<div className="flex items-start gap-2 px-3 py-2 sm:gap-3 sm:px-4">
				<RoleLabel color="text-tool" label="tool" />
				<div className="min-w-0 flex-1">
					<ToolResultCard message={message} />
				</div>
			</div>
		);
	}

	// Assistant
	return (
		<div className="flex items-start gap-2 px-3 py-2 sm:gap-3 sm:px-4">
			<RoleLabel color="text-assistant" label="omp" />
			<div className="min-w-0 flex-1">
				<div className="max-w-[860px]">
					<AssistantContent message={message} streaming={streaming} executions={executions} />
					<div className="mt-1 flex items-center gap-2 font-mono text-[9.5px] text-fg-3">
						<span>{formatTime(message.timestamp)}</span>
						{message.model ? <span>· {message.model}</span> : null}
						{message.stopReason && !streaming ? <span>· {message.stopReason}</span> : null}
						{streaming ? <span className="animate-pulse text-cat-assistant">streaming…</span> : null}
					</div>
				</div>
			</div>
		</div>
	);
}

/** Role label column — hidden on very small screens to save horizontal space. */
export function RoleLabel({ color, label }: { color: string; label: string }) {
	return (
		<div
			className={`hidden w-14 shrink-0 pt-0.5 text-right font-mono text-[10px] uppercase tracking-[0.1em] sm:block ${color}`}
		>
			{label}
		</div>
	);
}

/**
 * Standalone tool result (history replay). Defaults to collapsed: shows the
 * tool name and payload size; expanding reveals the content in a scrollable,
 * height-capped block so long outputs don't eat the screen.
 */
function ToolResultCard({ message }: { message: Extract<RenderedMessage["message"], { role: "toolResult" }> }) {
	const [open, setOpen] = React.useState(false);
	const text = message.content
		.map(b => (b.type === "text" ? b.text : ""))
		.join("\n")
		.trim();
	const name = message.toolName || "(tool)";
	const preview = text.split("\n").slice(0, 1).join(" ").slice(0, 80);

	return (
		<div className="rounded-md border border-border bg-surface-1">
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
				<span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-tool">tool</span>
				<span className="truncate font-mono text-[11px] text-fg-0">{name}</span>
				{!open && text ? (
					<span className="ml-auto truncate font-mono text-[10px] text-fg-3" title={preview}>
						{text.length} chars
					</span>
				) : null}
				{message.isError ? <span className="shrink-0 font-mono text-[10px] text-sev-error">error</span> : null}
			</button>
			{open && text ? (
				<div className="border-t border-border px-3 py-2">
					<pre className="max-h-64 overflow-auto font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-1">
						{text}
					</pre>
				</div>
			) : null}
			{!open && !text ? <div className="px-3 pb-1.5 font-mono text-[9.5px] text-fg-3">(empty result)</div> : null}
		</div>
	);
}
