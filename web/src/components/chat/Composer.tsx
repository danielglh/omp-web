import type { WireImageContent, WireModel } from "@omp-web/shared";
import {
	AtSign,
	Brain,
	ChevronDown,
	CornerUpRight,
	ListPlus,
	Loader2,
	Paperclip,
	Pencil,
	Plus,
	Send,
	Sparkles,
	Square,
	Terminal,
	Trash2,
	X,
	Zap,
} from "lucide-react";
import * as React from "react";
import type { SessionSnapshot, SessionStore } from "../../api";
import { api } from "../../api";
import { type ImageAttachment, filesToAttachments } from "../../lib/images";
import { Popover, PopoverItem } from "../shared/Popover";

interface ComposerProps {
	store: SessionStore;
	snapshot: SessionSnapshot;
	/** Assistant sessions get a config-helper placeholder + starter chips. */
	assistant?: boolean;
}

interface PendingItem {
	id: string;
	text: string;
	images: ImageAttachment[];
}

type MenuId = "plus" | "mode" | "model" | "think" | "at" | "cmd";

const MAX_ATTACHMENTS = 8;

const ASSISTANT_STARTERS = [
	"show my model roles",
	"make my setup cheaper",
	"set approvals to prompt on exec",
	"which providers am I logged into?",
];

const THINKING_LEVELS: Array<{ value: string; label: string; hint?: string }> = [
	{ value: "inherit", label: "auto", hint: "model default" },
	{ value: "off", label: "off" },
	{ value: "minimal", label: "min" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "med" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
];

/**
 * Effort-style models advertise the levels they accept (`thinking.efforts` on
 * the state's model); narrow the picker to those when present.
 */
function thinkingLevelsFor(model: WireModel | undefined): typeof THINKING_LEVELS {
	const thinking = (model as { thinking?: { mode?: string; efforts?: string[] } } | undefined)?.thinking;
	if (thinking?.mode !== "effort" || !Array.isArray(thinking.efforts) || thinking.efforts.length === 0) {
		return THINKING_LEVELS;
	}
	return THINKING_LEVELS.filter(
		level => level.value === "inherit" || level.value === "off" || thinking.efforts?.includes(level.value),
	);
}

function toWireImages(attachments: ImageAttachment[]): WireImageContent[] {
	return attachments.map(a => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Composer bar: auto-growing textarea + attachment chips + pending queue,
 * with a bottom control row — [+] menu (image / @context / /command), agent
 * mode, model, thinking level, and a state-aware primary button. Everything
 * maps to real omp RPC commands; nothing is a placeholder.
 */
export function Composer({ store, snapshot, assistant = false }: ComposerProps) {
	const [text, setText] = React.useState("");
	const [pending, setPending] = React.useState<PendingItem[]>([]);
	const [attachments, setAttachments] = React.useState<ImageAttachment[]>([]);
	const [openMenu, setOpenMenu] = React.useState<MenuId | null>(null);
	const [addingImages, setAddingImages] = React.useState(false);
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const isStreaming = snapshot.state?.isStreaming === true;
	const disabled = snapshot.phase !== "connected";
	const cwd = snapshot.session?.cwd;

	const toggleMenu = (menu: MenuId) => setOpenMenu(current => (current === menu ? null : menu));
	const closeMenu = (menu: MenuId) => setOpenMenu(current => (current === menu ? null : current));

	// Fetch the model list + slash commands once connected.
	React.useEffect(() => {
		if (snapshot.phase === "connected" && snapshot.availableModels.length === 0) {
			store.sendCommand({ type: "get_available_models", id: "ui:models" });
		}
		if (snapshot.phase === "connected" && snapshot.availableCommands.length === 0) {
			store.sendCommand({ type: "get_available_commands", id: "ui:commands" });
		}
	}, [snapshot.phase, snapshot.availableModels.length, snapshot.availableCommands.length, store]);

	// Agent-pushed editor prefill (set_editor_text): replace the draft once per push.
	const editorSeqRef = React.useRef(0);
	const editorText = snapshot.editorText;
	React.useEffect(() => {
		if (editorText && editorText.seq !== editorSeqRef.current) {
			editorSeqRef.current = editorText.seq;
			setText(editorText.text);
			textareaRef.current?.focus();
		}
	}, [editorText]);

	// When the agent is idle and we have queued messages, send them in order.
	// Flushes back-to-back in one tick; omp queues anything that arrives while
	// it spins up (state.queuedMessageCount) and the badge reflects both.
	React.useEffect(() => {
		if (disabled || isStreaming || pending.length === 0) return;
		const first = pending[0];
		if (!first) return;
		const images = toWireImages(first.images);
		store.sendCommand({ type: "prompt", message: first.text, ...(images.length > 0 ? { images } : {}) });
		setPending(prev => prev.slice(1));
	}, [isStreaming, disabled, pending, store]);

	const hasContent = text.trim().length > 0 || attachments.length > 0;

	function submit() {
		if (disabled || !hasContent) return;
		const message = text.trim();
		const images = toWireImages(attachments);
		if (isStreaming) {
			// Agent busy: queue the message (shown above, editable/deletable/steerable).
			setPending(p => [...p, { id: crypto.randomUUID(), text: message, images: attachments }]);
		} else if (images.length > 0) {
			store.sendCommand({ type: "prompt", message, images });
		} else {
			store.sendCommand({ type: "prompt", message });
		}
		setText("");
		setAttachments([]);
		textareaRef.current?.focus();
	}

	function updatePending(id: string, next: string) {
		setPending(p => p.map(item => (item.id === id ? { ...item, text: next } : item)));
	}

	function deletePending(id: string) {
		setPending(p => p.filter(item => item.id !== id));
	}

	function steerPending(item: PendingItem) {
		const images = toWireImages(item.images);
		store.sendCommand({ type: "steer", message: item.text, ...(images.length > 0 ? { images } : {}) });
		deletePending(item.id);
	}

	async function addFiles(files: FileList | File[]) {
		if (disabled) return;
		setAddingImages(true);
		try {
			const added = await filesToAttachments(files);
			setAttachments(prev => [...prev, ...added].slice(0, MAX_ATTACHMENTS));
		} finally {
			setAddingImages(false);
		}
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
		if (e.key === "Escape" && !openMenu) {
			if (isStreaming) {
				store.sendCommand({ type: "abort" });
			} else {
				textareaRef.current?.blur();
			}
		}
	}

	function onChangeText(next: string) {
		setText(next);
		// Typing "/x…" (at least one filter char) opens a compact autocomplete;
		// a bare "/" stays quiet — a 30-command wall over the input helps no one.
		const slashToken = /^\/(\S+)$/.exec(next);
		if (slashToken) {
			setOpenMenu(current => (current === "cmd" || current === null ? "cmd" : current));
		} else {
			setOpenMenu(current => (current === "cmd" ? null : current));
		}
	}

	/** Insert text at the caret, replacing a trailing `@token` when present. */
	function insertAtCaret(insert: string, replaceToken: "@" | "/" | null) {
		const el = textareaRef.current;
		const pos = el?.selectionStart ?? text.length;
		let start = pos;
		if (replaceToken) {
			const before = text.slice(0, pos);
			const tokenStart = before.lastIndexOf(replaceToken);
			if (tokenStart >= 0 && !/\s/.test(before.slice(tokenStart + 1, pos))) start = tokenStart;
		}
		const next = `${text.slice(0, start)}${insert} ${text.slice(pos)}`;
		setText(next);
		const caret = start + insert.length + 1;
		requestAnimationFrame(() => {
			textareaRef.current?.focus();
			textareaRef.current?.setSelectionRange(caret, caret);
		});
	}

	function insertPath(absolute: string) {
		const rel = cwd && absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
		insertAtCaret(`@${rel}`, "@");
		setOpenMenu(null);
	}

	function insertCommand(name: string) {
		if (/^\/\S*$/.test(text)) {
			setText(`/${name} `);
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
				const end = name.length + 2;
				textareaRef.current?.setSelectionRange(end, end);
			});
		} else {
			insertAtCaret(`/${name}`, "/");
		}
		setOpenMenu(null);
	}

	function switchModel(modelId: string) {
		const [provider, ...rest] = modelId.split("/");
		const model = rest.join("/");
		store.sendCommand({ type: "set_model", provider, modelId: model });
		setOpenMenu(null);
	}

	function refreshState() {
		store.sendCommand({ type: "get_state", id: "ui:state" });
	}

	// ── derived labels ─────────────────────────────────────────────────────────

	const modelLabel = snapshot.state?.model ? `${snapshot.state.model.provider}/${snapshot.state.model.id}` : undefined;
	const currentModel = snapshot.availableModels.find(m => `${m.provider}/${m.id}` === modelLabel);
	const thinkingLevel = snapshot.state?.thinkingLevel ?? "inherit";
	const thinkingLabel = THINKING_LEVELS.find(l => l.value === thinkingLevel)?.label ?? thinkingLevel;
	const fastMode = snapshot.state?.fastModeEnabled === true;
	const interruptMode = snapshot.state?.interruptMode ?? "immediate";
	const autoCompact = snapshot.state?.autoCompactionEnabled === true;
	const queuedCount = pending.length + (snapshot.state?.queuedMessageCount ?? 0);

	return (
		<div className="shrink-0 border-t border-border bg-surface-1 px-4 py-3">
			<div className="w-full">
				{/* Assistant starter chips (until the conversation gets going) */}
				{assistant && snapshot.messages.length === 0 && pending.length === 0 ? (
					<div className="mb-2 flex flex-wrap gap-1.5">
						{ASSISTANT_STARTERS.map(starter => (
							<button
								key={starter}
								type="button"
								onClick={() => {
									setText(starter);
									textareaRef.current?.focus();
								}}
								className="rounded-full border border-border bg-surface-0 px-2.5 py-1 font-mono text-[10.5px] text-fg-2 hover:border-cat-subagent/60 hover:text-cat-subagent"
							>
								{starter}
							</button>
						))}
					</div>
				) : null}

				{/* Queued messages (editable / deletable / steerable pills) */}
				{pending.length > 0 ? (
					<div className="mb-2 space-y-1.5">
						{pending.map(item => (
							<PendingPill
								key={item.id}
								item={item}
								streaming={isStreaming}
								onUpdate={next => updatePending(item.id, next)}
								onDelete={() => deletePending(item.id)}
								onSteer={() => steerPending(item)}
							/>
						))}
					</div>
				) : null}

				{/* Composer box: attachment chips + textarea + control bar */}
				<div className="rounded-xl border border-border-strong bg-surface-0 transition-colors focus-within:border-cat-conversation">
					{attachments.length > 0 ? (
						<div className="flex flex-wrap gap-2 px-3 pt-3">
							{attachments.map(attachment => (
								<div key={attachment.id} className="group relative">
									<img
										src={attachment.dataUrl}
										alt={attachment.name}
										title={`${attachment.name} · ${formatBytes(attachment.bytes)}`}
										className="h-16 w-16 rounded-md border border-border object-cover"
									/>
									<button
										type="button"
										onClick={() => setAttachments(prev => prev.filter(a => a.id !== attachment.id))}
										className="absolute -right-1.5 -top-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-fg-2 opacity-0 transition-opacity hover:text-sev-error group-hover:opacity-100"
										title="Remove"
									>
										<X className="h-2.5 w-2.5" />
									</button>
								</div>
							))}
						</div>
					) : null}

					<textarea
						ref={textareaRef}
						value={text}
						onChange={e => onChangeText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={e => {
							const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
							if (files.length === 0) return;
							e.preventDefault();
							addFiles(files);
						}}
						rows={Math.min(8, Math.max(2, text.split("\n").length))}
						placeholder={
							disabled
								? "session not connected…"
								: assistant
									? "Ask the assistant — e.g. show my model roles, make it cheaper…"
									: isStreaming
										? "Queue a prompt (enter to queue, esc to abort)"
										: "Prompt the agent (enter to send, / for commands, @ for files)"
						}
						className="max-h-56 min-h-[44px] w-full resize-none bg-transparent px-3 pt-3 pb-1 font-mono text-[12.5px] leading-relaxed text-fg-0 outline-none placeholder:text-fg-3"
						spellCheck={false}
					/>

					{/* Control bar */}
					<div className="flex items-center gap-2 px-3 pb-2 pt-1">
						{/* + menu: image / @context / command — hidden for the assistant
						    (config chat needs none of it). */}
						{assistant ? null : (
							<div className="relative shrink-0">
								<button
									type="button"
									onClick={() => toggleMenu("plus")}
									title="Insert image, @context, or command"
									className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-fg-2 hover:border-border-strong hover:text-fg-0"
								>
									<Plus
										className={`h-3.5 w-3.5 transition-transform ${openMenu === "plus" ? "rotate-45" : ""}`}
									/>
								</button>
								<Popover
									open={openMenu === "plus"}
									onClose={() => closeMenu("plus")}
									direction="up"
									align="left"
									className="w-64 py-1"
								>
									<MenuRow
										icon={<Paperclip className="h-3.5 w-3.5 shrink-0 text-cat-approval" />}
										title="Add image"
										sub="pick or paste an image"
										disabled={disabled || addingImages || attachments.length >= MAX_ATTACHMENTS}
										onClick={() => {
											setOpenMenu(null);
											fileInputRef.current?.click();
										}}
									/>
									<MenuRow
										icon={<AtSign className="h-3.5 w-3.5 shrink-0 text-cat-config" />}
										title="Add context"
										sub="reference a file with @"
										disabled={disabled}
										onClick={() => setOpenMenu("at")}
									/>
									<MenuRow
										icon={<Terminal className="h-3.5 w-3.5 shrink-0 text-cat-meta" />}
										title="Command"
										sub="run a slash command"
										disabled={disabled}
										onClick={() => setOpenMenu("cmd")}
									/>
								</Popover>

								{/* @file picker (opens over the + menu's slot) */}
								<ContextPicker
									open={openMenu === "at"}
									onClose={() => closeMenu("at")}
									cwd={cwd}
									onPick={insertPath}
								/>
								{/* slash-command picker */}
								<CommandPicker
									open={openMenu === "cmd"}
									onClose={() => closeMenu("cmd")}
									commands={snapshot.availableCommands}
									fromSlashToken={/^\/\S*$/.test(text)}
									filter={/^\//.test(text) ? (text.slice(1).split(/\s/)[0] ?? "") : ""}
									onPick={insertCommand}
								/>
							</div>
						)}

						{/* Agent mode (fast / interrupt / compaction) — fixed for the
						    assistant: its model/behavior come from configured defaults. */}
						{assistant ? null : (
							<div className="relative shrink-0">
								<button
									type="button"
									onClick={() => toggleMenu("mode")}
									title="Agent mode — fast mode, interruption, compaction"
									className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 font-mono text-[10.5px] text-fg-1 hover:border-border-strong"
								>
									<Zap className={`h-3 w-3 ${fastMode ? "text-cat-ephemeral" : "text-fg-3"}`} />
									<span className={`hidden sm:inline ${fastMode ? "text-cat-ephemeral" : ""}`}>
										{fastMode ? "fast" : "normal"}
									</span>
									<ChevronDown className="hidden h-3 w-3 text-fg-3 sm:block" />
								</button>
								<Popover
									open={openMenu === "mode"}
									onClose={() => closeMenu("mode")}
									className="w-72 max-w-[calc(100vw-2rem)] py-1"
								>
									<div className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-fg-3">
										agent mode
									</div>
									<ToggleRow
										icon={<Zap className="h-3.5 w-3.5 text-cat-ephemeral" />}
										label="Fast mode"
										hint="prioritize speed over quality"
										enabled={fastMode}
										disabled={disabled}
										onClick={() => {
											store.sendCommand({ type: "set_fast_mode", enabled: !fastMode });
											refreshState();
										}}
									/>
									<div className="flex items-center gap-2 px-3 py-1.5">
										<span className="w-[5.5rem] shrink-0 font-mono text-[11px] text-fg-1">Interrupt</span>
										<div className="flex overflow-hidden rounded-md border border-border">
											{(["immediate", "wait"] as const).map(mode => (
												<button
													key={mode}
													type="button"
													disabled={disabled}
													onClick={() => {
														store.sendCommand({ type: "set_interrupt_mode", mode });
														refreshState();
													}}
													className={[
														"px-2 py-0.5 font-mono text-[10px]",
														interruptMode === mode
															? "bg-surface-3 text-cat-conversation"
															: "text-fg-2 hover:bg-surface-3",
													].join(" ")}
												>
													{mode === "immediate" ? "immediate" : "wait"}
												</button>
											))}
										</div>
									</div>
									<ToggleRow
										icon={<Brain className="h-3.5 w-3.5 text-cat-subagent" />}
										label="Auto-compact"
										hint="compact context when full"
										enabled={autoCompact}
										disabled={disabled}
										onClick={() => {
											store.sendCommand({ type: "set_auto_compaction", enabled: !autoCompact });
											refreshState();
										}}
									/>
									<div className="my-1 border-t border-border" />
									<PopoverItem
										onClick={() => {
											store.sendCommand({ type: "compact" });
											setOpenMenu(null);
										}}
									>
										Compact now
									</PopoverItem>
								</Popover>
							</div>
						)}

						<div className="ml-auto flex shrink-0 items-center gap-2">
							{/* Queued message count */}
							{queuedCount > 0 ? (
								<span
									className="flex h-7 items-center gap-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-[10px] text-fg-2"
									title={`${queuedCount} message(s) queued`}
								>
									<ListPlus className="h-3 w-3" />
									{queuedCount}
								</span>
							) : null}

							{/* Model + thinking selectors — hidden for the assistant. */}
							{assistant ? null : (
								<>
									{/* Model selector */}
									<div className="relative min-w-0">
										<button
											type="button"
											onClick={() => toggleMenu("model")}
											title="Switch model"
											className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 font-mono text-[10.5px] text-fg-1 hover:border-border-strong"
										>
											<Sparkles className="h-3 w-3 shrink-0 text-cat-meta" />
											<span className="max-w-[7.5rem] truncate sm:max-w-44">
												{modelLabel ??
													(currentModel ? `${currentModel.provider}/${currentModel.id}` : "model")}
											</span>
											<ChevronDown className="hidden h-3 w-3 shrink-0 text-fg-3 sm:block" />
										</button>
										<Popover
											open={openMenu === "model"}
											onClose={() => closeMenu("model")}
											align="right"
											className="max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto py-1"
										>
											{snapshot.availableModels.length === 0 ? (
												<div className="px-3 py-2 font-mono text-[10.5px] text-fg-3">no models listed</div>
											) : (
												snapshot.availableModels.map(model => {
													const label = `${model.provider}/${model.id}`;
													return (
														<PopoverItem
															key={label}
															active={label === modelLabel}
															onClick={() => switchModel(label)}
														>
															{label}
														</PopoverItem>
													);
												})
											)}
										</Popover>
									</div>

									{/* Thinking level */}
									<div className="relative">
										<button
											type="button"
											onClick={() => toggleMenu("think")}
											title="Thinking level"
											className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 font-mono text-[10.5px] text-fg-1 hover:border-border-strong"
										>
											<Brain className="h-3 w-3 text-cat-subagent" />
											{thinkingLabel}
											<ChevronDown className="h-3 w-3 text-fg-3" />
										</button>
										<Popover
											open={openMenu === "think"}
											onClose={() => closeMenu("think")}
											align="right"
											className="w-44 py-1"
										>
											{thinkingLevelsFor(snapshot.state?.model).map(level => (
												<PopoverItem
													key={level.value}
													active={level.value === thinkingLevel}
													title={level.hint}
													onClick={() => {
														store.sendCommand({ type: "set_thinking_level", level: level.value });
														setOpenMenu(null);
													}}
												>
													{level.label}
												</PopoverItem>
											))}
										</Popover>
									</div>
								</>
							)}

							{/* Primary: idle = send; running + text = queue; running = stop */}
							<button
								type="button"
								onClick={() => {
									if (isStreaming && !hasContent) store.sendCommand({ type: "abort" });
									else submit();
								}}
								disabled={disabled || (!isStreaming && !hasContent)}
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cat-conversation bg-cat-conversation text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:border-border-strong disabled:bg-transparent disabled:text-fg-3 disabled:opacity-40"
								title={isStreaming ? (hasContent ? "Queue (enter)" : "Stop (esc)") : "Send prompt (enter)"}
							>
								{disabled ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : isStreaming ? (
									hasContent ? (
										<ListPlus className="h-4 w-4" />
									) : (
										<Square className="h-3.5 w-3.5" />
									)
								) : (
									<Send className="h-4 w-4" />
								)}
							</button>
						</div>
					</div>
				</div>

				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={e => {
						if (e.target.files?.length) addFiles(e.target.files);
						e.target.value = "";
					}}
				/>
			</div>
		</div>
	);
}

/** Row inside the + menu. */
function MenuRow({
	icon,
	title,
	sub,
	onClick,
	disabled,
}: {
	icon: React.ReactNode;
	title: string;
	sub: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
		>
			<span className="pt-0.5">{icon}</span>
			<span className="min-w-0">
				<span className="block font-mono text-[11.5px] text-fg-0">{title}</span>
				<span className="block font-mono text-[10px] text-fg-3">{sub}</span>
			</span>
		</button>
	);
}

/** Toggle row inside the mode popover. */
function ToggleRow({
	icon,
	label,
	hint,
	enabled,
	onClick,
	disabled,
}: {
	icon: React.ReactNode;
	label: string;
	hint: string;
	enabled: boolean;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{icon}
			<span className="min-w-0 flex-1">
				<span className="block font-mono text-[11px] text-fg-0">{label}</span>
				<span className="block font-mono text-[9.5px] text-fg-3">{hint}</span>
			</span>
			<span
				className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
					enabled ? "border-cat-ephemeral/60 text-cat-ephemeral" : "border-border text-fg-3"
				}`}
			>
				{enabled ? "on" : "off"}
			</span>
		</button>
	);
}

/** @file context picker backed by /api/fs/paths (relative to the session cwd). */
function ContextPicker({
	open,
	onClose,
	cwd,
	onPick,
}: {
	open: boolean;
	onClose: () => void;
	cwd?: string;
	onPick: (path: string) => void;
}) {
	const [query, setQuery] = React.useState("");
	const [matches, setMatches] = React.useState<string[]>([]);
	const [loading, setLoading] = React.useState(false);

	React.useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			setLoading(true);
			// Empty query lists the cwd's entries; typed queries narrow under it.
			api.fsPaths(query || "./", cwd)
				.then(r => {
					if (!cancelled) setMatches(r.matches);
				})
				.catch(() => {
					if (!cancelled) setMatches([]);
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, query, cwd]);

	return (
		<Popover open={open} onClose={onClose} className="w-80 max-w-[calc(100vw-2rem)] py-1">
			<div className="border-b border-border px-2 py-1.5">
				<input
					autoFocus
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={cwd ? `search under ${cwd.split("/").filter(Boolean).pop() ?? "/"}` : "search files…"}
					className="w-full bg-transparent px-1 font-mono text-[11px] text-fg-0 outline-none placeholder:text-fg-3"
					spellCheck={false}
				/>
			</div>
			<div className="max-h-60 overflow-y-auto py-0.5">
				{loading ? (
					<div className="px-3 py-2 font-mono text-[10.5px] text-fg-3">searching…</div>
				) : matches.length === 0 ? (
					<div className="px-3 py-2 font-mono text-[10.5px] text-fg-3">no matches</div>
				) : (
					matches.map(path => (
						<PopoverItem key={path} onClick={() => onPick(path)} title={path}>
							<span className="block truncate">
								{cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path}
							</span>
						</PopoverItem>
					))
				)}
			</div>
		</Popover>
	);
}

/** Slash-command picker fed by available_commands_update. */
function CommandPicker({
	open,
	onClose,
	commands,
	fromSlashToken,
	filter,
	onPick,
}: {
	open: boolean;
	onClose: () => void;
	commands: SessionSnapshot["availableCommands"];
	/** True when the textarea itself holds the filter (typing "/…"). */
	fromSlashToken: boolean;
	filter: string;
	onPick: (name: string) => void;
}) {
	const [menuFilter, setMenuFilter] = React.useState("");
	const effectiveFilter = (fromSlashToken ? filter : menuFilter).toLowerCase();
	const filtered = commands.filter(c => c.name.toLowerCase().includes(effectiveFilter));

	return (
		<Popover open={open} onClose={onClose} className="w-80 max-w-[calc(100vw-2rem)] py-1">
			{!fromSlashToken ? (
				<div className="border-b border-border px-2 py-1.5">
					<input
						autoFocus
						value={menuFilter}
						onChange={e => setMenuFilter(e.target.value)}
						placeholder="filter commands…"
						className="w-full bg-transparent px-1 font-mono text-[11px] text-fg-0 outline-none placeholder:text-fg-3"
						spellCheck={false}
					/>
				</div>
			) : null}
			<div className={fromSlashToken ? "max-h-44 overflow-y-auto py-0.5" : "max-h-60 overflow-y-auto py-0.5"}>
				{filtered.length === 0 ? (
					<div className="px-3 py-2 font-mono text-[10.5px] text-fg-3">no matching commands</div>
				) : (
					<>
						{(fromSlashToken ? filtered.slice(0, 8) : filtered).map(command => (
							<button
								key={command.name}
								type="button"
								onClick={() => onPick(command.name)}
								className="block w-full px-3 py-1.5 text-left hover:bg-surface-3"
							>
								<span className="block font-mono text-[11px] text-fg-0">/{command.name}</span>
								{command.description ? (
									<span className="block truncate font-mono text-[9.5px] text-fg-3">
										{command.description}
									</span>
								) : null}
							</button>
						))}
						{fromSlashToken && filtered.length > 8 ? (
							<div className="px-3 py-1 font-mono text-[9.5px] text-fg-3">
								+{filtered.length - 8} more — keep typing to narrow, esc to dismiss
							</div>
						) : null}
					</>
				)}
			</div>
		</Popover>
	);
}

/** A queued message shown as an editable pill above the composer. */
function PendingPill({
	item,
	streaming,
	onUpdate,
	onDelete,
	onSteer,
}: {
	item: PendingItem;
	streaming: boolean;
	onUpdate: (text: string) => void;
	onDelete: () => void;
	onSteer: () => void;
}) {
	const [editing, setEditing] = React.useState(false);
	const [draft, setDraft] = React.useState(item.text);

	function commit() {
		if (draft.trim()) onUpdate(draft.trim());
		setEditing(false);
	}

	return (
		<div className="flex items-center gap-2 rounded-lg border border-border bg-surface-0 px-3 py-2">
			<img src="/favicon.svg" alt="omp" className="h-5 w-5 shrink-0" />
			{editing ? (
				<input
					value={draft}
					onChange={e => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={e => {
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						}
						if (e.key === "Escape") {
							setDraft(item.text);
							setEditing(false);
						}
					}}
					autoFocus
					className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg-0 outline-none"
					spellCheck={false}
				/>
			) : (
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1" title={item.text}>
					{item.text}
				</span>
			)}
			{item.images.length > 0 ? (
				<div className="flex shrink-0 items-center gap-1">
					{item.images.slice(0, 3).map(image => (
						<img
							key={image.id}
							src={image.dataUrl}
							alt=""
							className="h-5 w-5 rounded border border-border object-cover"
						/>
					))}
					{item.images.length > 3 ? (
						<span className="font-mono text-[9.5px] text-fg-3">+{item.images.length - 3}</span>
					) : null}
				</div>
			) : null}
			<div className="flex shrink-0 items-center gap-1">
				{editing ? (
					<button
						type="button"
						onClick={() => {
							setDraft(item.text);
							setEditing(false);
						}}
						className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-fg-0"
						title="Cancel edit"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				) : (
					<button
						type="button"
						onClick={() => {
							setDraft(item.text);
							setEditing(true);
						}}
						className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-fg-0"
						title="Edit"
					>
						<Pencil className="h-3.5 w-3.5" />
					</button>
				)}
				<button
					type="button"
					onClick={onDelete}
					className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-sev-error"
					title="Delete"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					onClick={onSteer}
					disabled={!streaming}
					className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-cat-subagent disabled:opacity-30"
					title={streaming ? "Steer the agent with this" : "Steer available while running"}
				>
					<CornerUpRight className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
