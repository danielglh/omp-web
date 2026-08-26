import * as React from "react";
import type { SessionSnapshot } from "../../api";
import { MessageBubble, RoleLabel } from "./MessageBubble";

interface TranscriptProps {
	snapshot: SessionSnapshot;
}

export function Transcript({ snapshot }: TranscriptProps) {
	const scrollRef = React.useRef<HTMLDivElement>(null);
	const stickToBottomRef = React.useRef(true);

	const messages = snapshot.messages;
	const isStreaming = snapshot.state?.isStreaming === true || messages.some(m => m.streaming);

	// Auto-scroll to bottom when new content arrives, unless the user scrolled up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally keyed on stream activity
	React.useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages.length, isStreaming]);

	function handleScroll() {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickToBottomRef.current = distanceFromBottom < 120;
	}

	if (messages.length === 0) {
		return (
			<div ref={scrollRef} className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto">
				<div className="font-mono text-[11px] leading-relaxed text-fg-3">
					{snapshot.phase === "connected"
						? "No message yet - prompt the agent below."
						: snapshot.phase === "connecting"
							? "connecting to session…"
							: "session disconnected"}
				</div>
				{snapshot.error ? (
					<div className="mt-2 max-w-md text-center font-mono text-[10.5px] text-sev-error">{snapshot.error}</div>
				) : null}
			</div>
		);
	}

	return (
		<div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto py-3">
			{messages.map(entry => (
				<MessageBubble key={entry.key} entry={entry} executions={snapshot.toolExecutions} />
			))}
			{/* Latest agent/bridge notices (RPC rejections, compaction info, …) */}
			{snapshot.notices.slice(-3).map((notice, index) => (
				<div
					key={`${notice.at}-${notice.message.slice(0, 16)}-${index}`}
					className="flex items-start gap-2 px-3 py-1 sm:gap-3 sm:px-4"
					title={new Date(notice.at).toLocaleTimeString()}
				>
					<div className="hidden w-14 shrink-0 sm:block" aria-hidden="true" />
					<div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[10.5px] text-fg-3">
						<span
							className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
								notice.level === "error"
									? "bg-sev-error"
									: notice.level === "warning"
										? "bg-sev-warning"
										: "bg-sev-info"
							}`}
						/>
						<span className="min-w-0 flex-1 truncate">{notice.message}</span>
					</div>
				</div>
			))}
			{isStreaming ? (
				<div className="flex items-start gap-2 px-3 py-2 sm:gap-3 sm:px-4">
					<RoleLabel color="text-assistant" label="omp" />
					<div className="flex items-center gap-2 pt-0.5 font-mono text-[10.5px] text-fg-3">
						<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cat-assistant" />
						agent is working…
					</div>
				</div>
			) : null}
			<div className="h-2" />
		</div>
	);
}
