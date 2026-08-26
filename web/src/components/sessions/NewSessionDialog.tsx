import type { ApprovalMode, SessionInfo } from "@omp-web/shared";
import { FolderOpen, Lock, X } from "lucide-react";
import * as React from "react";
import { api } from "../../api";
import { FolderPicker } from "./FolderPicker";

const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string; hint: string }> = [
	{ value: "yolo", label: "Full access", hint: "auto-approve everything" },
	{ value: "write", label: "Confirm exec", hint: "approve shell commands in chat" },
	{ value: "always-ask", label: "Confirm exec + write", hint: "approve edits and commands" },
];

interface NewSessionDialogProps {
	onClose: () => void;
	onCreated: (session: SessionInfo) => void;
	/** Lock the working directory (workspace "+" action); path input is hidden. */
	fixedCwd?: string;
}

export function NewSessionDialog({ onClose, onCreated, fixedCwd }: NewSessionDialogProps) {
	const [name, setName] = React.useState("");
	const [cwd, setCwd] = React.useState(fixedCwd ?? "");
	const [prompt, setPrompt] = React.useState("");
	const [approvalMode, setApprovalMode] = React.useState<ApprovalMode>("yolo");
	const [submitting, setSubmitting] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	const [defaultCwd, setDefaultCwd] = React.useState("");
	const [showPicker, setShowPicker] = React.useState(false);
	// Path auto-complete suggestions.
	const [suggestions, setSuggestions] = React.useState<string[]>([]);
	const [suggestOpen, setSuggestOpen] = React.useState(false);
	const suggestTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	React.useEffect(() => {
		if (fixedCwd) return;
		api.serverInfo().then(info => {
			setDefaultCwd(info.defaultCwd);
			setCwd(info.defaultCwd);
		});
	}, [fixedCwd]);

	const cwdInputRef = React.useRef<HTMLInputElement>(null);
	React.useEffect(() => {
		if (fixedCwd) return;
		cwdInputRef.current?.focus();
	}, [fixedCwd]);

	// Debounced path auto-complete as the user types.
	function handleCwdChange(value: string) {
		setCwd(value);
		clearTimeout(suggestTimer.current);
		const trimmed = value.trim();
		if (!trimmed || trimmed.length < 2) {
			setSuggestions([]);
			setSuggestOpen(false);
			return;
		}
		suggestTimer.current = setTimeout(() => {
			api.fsSearch(trimmed)
				.then(res => {
					setSuggestions(res.matches);
					setSuggestOpen(res.matches.length > 0);
				})
				.catch(() => {
					setSuggestions([]);
					setSuggestOpen(false);
				});
		}, 220);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!cwd.trim()) {
			setError("working directory is required");
			return;
		}
		setSubmitting(true);
		setError(undefined);
		try {
			const session = await api.createSession({
				name: name.trim() || undefined,
				cwd: fixedCwd ?? cwd.trim(),
				prompt: prompt.trim() || undefined,
				approvalMode,
			});
			onCreated(session);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setSubmitting(false);
		}
	}

	function pickPath(path: string) {
		setCwd(path);
		setSuggestOpen(false);
		setSuggestions([]);
		setShowPicker(false);
		cwdInputRef.current?.focus();
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="New session"
		>
			<form
				className="w-full max-w-lg rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
				onClick={e => e.stopPropagation()}
				onSubmit={handleSubmit}
			>
				<div className="flex items-center border-b border-border px-4 py-3">
					<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-2">
						New session
					</span>
					<button
						type="button"
						onClick={onClose}
						className="ml-auto flex h-6 w-6 items-center justify-center text-fg-3 hover:text-fg-0"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="space-y-4 px-4 py-4">
					<Field label="Name (optional)">
						<input
							value={name}
							onChange={e => setName(e.target.value)}
							className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
							placeholder="my-project-session"
							spellCheck={false}
						/>
					</Field>

					<Field label="Working directory">
						{fixedCwd ? (
							<div
								className="flex items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[12px] text-fg-2"
								title={fixedCwd}
							>
								<Lock className="h-3.5 w-3.5 shrink-0 text-cat-config" />
								<span className="truncate">{fixedCwd}</span>
							</div>
						) : (
							<div className="relative">
								<div className="flex items-stretch gap-2">
									<input
										ref={cwdInputRef}
										value={cwd}
										onChange={e => handleCwdChange(e.target.value)}
										onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
										onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
										className="min-w-0 flex-1 rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
										placeholder="/home/user/project"
										spellCheck={false}
									/>
									<button
										type="button"
										onClick={() => setShowPicker(true)}
										className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-fg-1 hover:border-cat-conversation hover:text-cat-conversation"
										title="Browse directories"
										aria-label="Browse directories"
									>
										<FolderOpen className="h-4 w-4" />
									</button>
								</div>

								{/* Path auto-complete dropdown */}
								{suggestOpen && suggestions.length > 0 ? (
									<div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-border-strong bg-surface-2 shadow-xl">
										{suggestions.map(s => (
											<button
												key={s}
												type="button"
												onMouseDown={e => {
													e.preventDefault();
													pickPath(s);
												}}
												className="block w-full truncate px-3 py-1.5 text-left font-mono text-[11px] text-fg-1 hover:bg-surface-3 hover:text-fg-0"
												title={s}
											>
												{s}
											</button>
										))}
									</div>
								) : null}
							</div>
						)}
					</Field>

					<Field label="Tool approval" hint="how much the agent may do without asking">
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
							{APPROVAL_OPTIONS.map(option => (
								<button
									key={option.value}
									type="button"
									onClick={() => setApprovalMode(option.value)}
									className={[
										"rounded-md border px-2 py-2 text-left transition-colors",
										approvalMode === option.value
											? "border-cat-conversation bg-surface-2"
											: "border-border hover:border-border-strong",
									].join(" ")}
								>
									<span
										className={[
											"block font-mono text-[11px]",
											approvalMode === option.value ? "text-cat-conversation" : "text-fg-0",
										].join(" ")}
									>
										{option.label}
									</span>
									<span className="mt-0.5 block font-mono text-[9px] leading-tight text-fg-3">
										{option.hint}
									</span>
								</button>
							))}
						</div>
					</Field>

					<Field label="Initial prompt (optional)">
						<textarea
							value={prompt}
							onChange={e => setPrompt(e.target.value)}
							rows={3}
							className="w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
							placeholder="e.g. Summarize the current state of this repository"
							spellCheck={false}
						/>
					</Field>

					{error ? <div className="font-mono text-[11px] text-sev-error">{error}</div> : null}
				</div>

				<div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] uppercase text-fg-1 hover:bg-surface-2"
					>
						cancel
					</button>
					<button
						type="submit"
						disabled={submitting || !cwd.trim()}
						className="rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1.5 font-mono text-[11px] font-semibold uppercase text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{submitting ? "starting…" : "create"}
					</button>
				</div>
			</form>

			{showPicker ? (
				<FolderPicker
					initialPath={cwd || defaultCwd || "/"}
					onSelect={pickPath}
					onClose={() => setShowPicker(false)}
				/>
			) : null}
		</div>
	);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-1 flex items-baseline justify-between">
				<label className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-2">{label}</label>
				{hint ? <span className="font-mono text-[10px] text-fg-3">{hint}</span> : null}
			</div>
			{children}
		</div>
	);
}
