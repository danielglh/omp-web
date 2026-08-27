import type { WireExtensionUiRequest } from "@omp-web/shared";
import { Check, ExternalLink, Loader2, ShieldAlert, X } from "lucide-react";
import * as React from "react";
import type { SessionSnapshot, SessionStore } from "../../api";
import { isHttpUrl } from "../../lib/url";

type ActiveRequest = Extract<WireExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }> & {
	receivedAt?: number;
};

/**
 * Everything the agent pushes at the human between prompts: open_url links
 * (login flows), persistent widgets + status lines, and — most importantly —
 * the interactive extension-UI dialogs (select/confirm/input/editor). Tool
 * approvals arrive as `select` with ["Approve", "Deny"]; unanswered dialogs
 * block the agent, so the oldest one is always rendered.
 */
export function ExtensionSurfaces({ store, snapshot }: { store: SessionStore; snapshot: SessionSnapshot }) {
	const request = snapshot.extensionRequests[0] as ActiveRequest | undefined;
	const widgetEntries = Object.entries(snapshot.widgets);
	const statusText = Object.values(snapshot.statusEntries).join(" · ");
	const lastOutput = snapshot.commandOutputs.at(-1);

	return (
		<div className="space-y-2">
			{/* Local slash-command output (command_output frames) */}
			{lastOutput ? <CommandOutput text={lastOutput.text} /> : null}

			{/* open_url (login): clickable link + copyable loopback short URL.
			    Agent-supplied URL is only linkable when absolute http(s); anything
			    else renders inert so it can't become a navigation payload. */}
			{snapshot.openUrls.map(link => {
				const hrefOk = isHttpUrl(link.url);
				return (
					<div
						key={link.id}
						className="flex items-center gap-2 rounded-lg border border-cat-meta/40 bg-surface-1 px-3 py-2"
					>
						<ExternalLink className="h-3.5 w-3.5 shrink-0 text-cat-meta" />
						<div className="min-w-0 flex-1">
							{hrefOk ? (
								<a
									href={link.url}
									target="_blank"
									rel="noreferrer"
									className="block truncate font-mono text-[11px] text-cat-conversation hover:underline"
								>
									{link.instructions ?? link.url}
								</a>
							) : (
								<span
									title={`${link.url} (blocked: not an http(s) URL)`}
									className="block truncate font-mono text-[11px] text-sev-warning"
								>
									{link.instructions ?? link.url} — blocked: not http(s)
								</span>
							)}
							{link.launchUrl ? (
								<span className="block truncate font-mono text-[9.5px] text-fg-3" title={link.launchUrl}>
									copy: {link.launchUrl}
								</span>
							) : null}
						</div>
						<DismissButton onClick={() => store.dismissOpenUrl(link.id)} />
					</div>
				);
			})}

			{/* Persistent widgets (setWidget) */}
			{widgetEntries.map(([key, widget]) => (
				<div key={key} className="rounded-lg border border-border bg-surface-1">
					<div className="flex items-center gap-2 border-b border-border px-3 py-1">
						<span className="font-mono text-[9px] uppercase tracking-[0.15em] text-cat-subagent">{key}</span>
					</div>
					<pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-1">
						{widget.lines.join("\n")}
					</pre>
				</div>
			))}

			{request ? <ExtensionDialog store={store} request={request} /> : null}

			{!request && statusText ? (
				<div className="truncate px-1 font-mono text-[9.5px] text-fg-3" title={statusText}>
					{statusText}
				</div>
			) : null}
		</div>
	);
}

function ExtensionDialog({ store, request }: { store: SessionStore; request: ActiveRequest }) {
	const answer = (payload: { value: string } | { confirmed: boolean } | { cancelled: true; timedOut?: boolean }) =>
		store.answerExtensionRequest(request.id, payload);
	const cancel = () => answer({ cancelled: true });

	// Tool approvals surface as a two-option select; style them as a decision.
	const isApproval =
		request.method === "select" &&
		request.options.length === 2 &&
		request.options[0] === "Approve" &&
		request.options[1] === "Deny";

	const [titleLine, ...titleRest] = request.title.split("\n");

	return (
		<div
			className={[
				"rounded-xl border shadow-xl",
				isApproval ? "border-cat-approval/50 bg-surface-1" : "border-border-strong bg-surface-1",
			].join(" ")}
		>
			<div className="flex items-start gap-2 border-b border-border px-3 py-2">
				{isApproval ? (
					<ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cat-approval" />
				) : (
					<Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-cat-subagent" />
				)}
				<div className="min-w-0 flex-1">
					<div className="font-mono text-[11.5px] font-medium text-fg-0">{titleLine || "agent request"}</div>
					{titleRest.length > 0 ? (
						<pre className="mt-1 max-h-32 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-fg-2">
							{titleRest.join("\n")}
						</pre>
					) : null}
					{request.method === "confirm" && "message" in request && request.message ? (
						<div className="mt-1 font-mono text-[10.5px] text-fg-2">{request.message}</div>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<TimeoutBadge request={request} onTimeout={() => answer({ cancelled: true, timedOut: true })} />
					<DismissButton onClick={cancel} title="Cancel (agent gets no answer default)" />
				</div>
			</div>

			<div className="px-3 py-2">
				{request.method === "select" ? (
					<SelectBody request={request} isApproval={isApproval} onAnswer={answer} />
				) : request.method === "confirm" ? (
					<ConfirmBody onAnswer={answer} />
				) : request.method === "input" ? (
					<InputBody request={request} onAnswer={answer} />
				) : (
					<EditorBody request={request} onAnswer={answer} />
				)}
			</div>

			<div className="border-t border-border px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-3">
				{snapshotCountLabel(request)}
			</div>
		</div>
	);
}

function SelectBody({
	request,
	isApproval,
	onAnswer,
}: {
	request: Extract<ActiveRequest, { method: "select" }>;
	isApproval: boolean;
	onAnswer: (payload: { value: string } | { cancelled: true }) => void;
}) {
	const [filter, setFilter] = React.useState("");
	const showFilter = request.options.length > 8;
	const filtered = request.options.filter(option => option.toLowerCase().includes(filter.toLowerCase()));

	return (
		<div>
			{showFilter ? (
				<input
					value={filter}
					onChange={e => setFilter(e.target.value)}
					placeholder="filter…"
					className="mb-2 w-full rounded-md border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
					spellCheck={false}
				/>
			) : null}
			<div className="max-h-64 space-y-1 overflow-y-auto">
				{filtered.map((option, index) => {
					const detail = request.optionDetails?.[index]?.description;
					const approvalPrimary = isApproval && option === "Approve";
					const approvalDeny = isApproval && option === "Deny";
					return (
						<button
							key={option}
							type="button"
							onClick={() => onAnswer({ value: option })}
							className={[
								"block w-full rounded-md border px-2.5 py-1.5 text-left font-mono text-[11.5px] transition-colors",
								approvalPrimary
									? "border-sev-success/50 text-sev-success hover:bg-sev-success/10"
									: approvalDeny
										? "border-sev-error/50 text-sev-error hover:bg-sev-error/10"
										: "border-border text-fg-0 hover:border-border-strong hover:bg-surface-2",
							].join(" ")}
						>
							<span className="flex items-center gap-2">
								<Check className="h-3 w-3 shrink-0 opacity-0" />
								<span className="min-w-0 truncate">{option}</span>
							</span>
							{detail ? (
								<span className="mt-0.5 block truncate pl-5 font-mono text-[9.5px] text-fg-3" title={detail}>
									{detail}
								</span>
							) : null}
						</button>
					);
				})}
				{filtered.length === 0 ? (
					<div className="px-2 py-1.5 font-mono text-[10.5px] text-fg-3">no matching options</div>
				) : null}
			</div>
		</div>
	);
}

function ConfirmBody({
	onAnswer,
}: {
	onAnswer: (payload: { confirmed: boolean } | { cancelled: true }) => void;
}) {
	return (
		<div className="flex gap-2">
			<button
				type="button"
				onClick={() => onAnswer({ confirmed: true })}
				className="flex-1 rounded-md border border-sev-success/50 px-3 py-1.5 font-mono text-[11.5px] text-sev-success hover:bg-sev-success/10"
			>
				Yes
			</button>
			<button
				type="button"
				onClick={() => onAnswer({ confirmed: false })}
				className="flex-1 rounded-md border border-border px-3 py-1.5 font-mono text-[11.5px] text-fg-1 hover:bg-surface-2"
			>
				No
			</button>
		</div>
	);
}

function InputBody({
	request,
	onAnswer,
}: {
	request: Extract<ActiveRequest, { method: "input" }>;
	onAnswer: (payload: { value: string } | { cancelled: true }) => void;
}) {
	const [value, setValue] = React.useState("");
	return (
		<div className="flex gap-2">
			<input
				autoFocus
				value={value}
				onChange={e => setValue(e.target.value)}
				placeholder={request.placeholder}
				onKeyDown={e => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) {
						e.preventDefault();
						onAnswer({ value: value });
					}
				}}
				className="min-w-0 flex-1 rounded-md border border-border bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
				spellCheck={false}
			/>
			<button
				type="button"
				onClick={() => onAnswer({ value })}
				className="shrink-0 rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1.5 font-mono text-[11px] text-on-accent hover:opacity-90"
			>
				reply
			</button>
		</div>
	);
}

function EditorBody({
	request,
	onAnswer,
}: {
	request: Extract<ActiveRequest, { method: "editor" }>;
	onAnswer: (payload: { value: string } | { cancelled: true }) => void;
}) {
	const [value, setValue] = React.useState(request.prefill ?? "");
	const promptStyle = request.promptStyle === true;
	const submit = () => onAnswer({ value });
	if (promptStyle) {
		return (
			<div className="flex gap-2">
				<input
					autoFocus
					value={value}
					onChange={e => setValue(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder="> type your answer…"
					className="min-w-0 flex-1 rounded-md border border-border bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
					spellCheck={false}
				/>
				<button
					type="button"
					onClick={submit}
					className="shrink-0 rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1.5 font-mono text-[11px] text-on-accent hover:opacity-90"
				>
					reply
				</button>
			</div>
		);
	}
	return (
		<div>
			<textarea
				autoFocus
				value={value}
				onChange={e => setValue(e.target.value)}
				onKeyDown={e => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						submit();
					}
				}}
				rows={Math.min(10, Math.max(3, value.split("\n").length))}
				className="max-h-48 w-full resize-none rounded-md border border-border bg-surface-0 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-fg-0 outline-none focus:border-cat-conversation"
				spellCheck={false}
			/>
			<div className="mt-1.5 flex items-center justify-between">
				<span className="font-mono text-[9px] text-fg-3">⌘/ctrl+enter to submit</span>
				<button
					type="button"
					onClick={submit}
					className="rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1 font-mono text-[11px] text-on-accent hover:opacity-90"
				>
					reply
				</button>
			</div>
		</div>
	);
}

/** Countdown for requests carrying a timeout (ms since received). */
function TimeoutBadge({ request, onTimeout }: { request: ActiveRequest; onTimeout: () => void }) {
	const timeout = "timeout" in request ? request.timeout : undefined;
	const receivedAt = request.receivedAt ?? Date.now();
	const [now, setNow] = React.useState(() => Date.now());
	const [expired, setExpired] = React.useState(false);
	const onTimeoutRef = React.useRef(onTimeout);
	onTimeoutRef.current = onTimeout;

	React.useEffect(() => {
		if (!timeout) return;
		const tick = () => {
			const t = Date.now();
			setNow(t);
			if (receivedAt + timeout - t <= 0) setExpired(true);
		};
		tick();
		const timer = setInterval(tick, 500);
		return () => clearInterval(timer);
	}, [timeout, receivedAt]);

	React.useEffect(() => {
		if (expired) onTimeoutRef.current();
	}, [expired]);

	if (!timeout) return null;
	const seconds = Math.ceil(Math.max(0, receivedAt + timeout - now) / 1000);
	return (
		<span
			className={`shrink-0 font-mono text-[9.5px] tabular ${seconds <= 10 ? "text-sev-error" : "text-fg-3"}`}
			title="auto-dismiss countdown"
		>
			{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
		</span>
	);
}

function DismissButton({ onClick, title }: { onClick: () => void; title?: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-3 hover:text-fg-0"
			title={title ?? "dismiss"}
		>
			<X className="h-3.5 w-3.5" />
		</button>
	);
}

/** Newest local-command output (e.g. /model listing) in a collapsible block. */
function CommandOutput({ text }: { text: string }) {
	const [open, setOpen] = React.useState(false);
	const preview = text.split("\n").slice(0, 1).join(" ").slice(0, 100);
	return (
		<div className="rounded-lg border border-border bg-surface-1">
			<button
				type="button"
				onClick={() => setOpen(o => !o)}
				className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
			>
				<span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-cat-meta">output</span>
				{!open ? (
					<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-2" title={preview}>
						{preview}
					</span>
				) : null}
				<span className="ml-auto shrink-0 font-mono text-[9.5px] text-fg-3">{text.length} chars</span>
			</button>
			{open ? (
				<pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-1">
					{text}
				</pre>
			) : null}
		</div>
	);
}

function snapshotCountLabel(request: ActiveRequest) {
	const kind =
		request.method === "select"
			? "choose an option"
			: request.method === "confirm"
				? "confirm"
				: request.method === "input"
					? "input"
					: "editor";
	return `${kind} · agent is waiting`;
}
