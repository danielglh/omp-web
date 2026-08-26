import { Bot, Folder, History, Menu, Plus, Search, X } from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { useSessions } from "../../hooks";
import { formatRelativeTime } from "../../lib/format";
import { NewSessionDialog } from "../sessions/NewSessionDialog";
import { ResumeSessionDialog } from "../sessions/ResumeSessionDialog";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { LogoutButton } from "../shared/LogoutButton";
import { SettingsLink } from "../shared/SettingsLink";
import { ThemeToggle } from "../shared/ThemeToggle";

/** Assistant conversations older than this are reset on open (stale config context misleads). */
const ASSISTANT_STALE_MS = 24 * 60 * 60 * 1000;

export function AppShell({ children }: { children: ReactNode }) {
	const [railOpen, setRailOpen] = React.useState(false);
	return (
		<div className="flex h-full min-h-0 bg-surface-0 text-fg-0">
			<SessionRail open={railOpen} onClose={() => setRailOpen(false)} />
			<main className="flex min-w-0 flex-1 flex-col">
				<MobileTopBar onOpen={() => setRailOpen(true)} />
				{children}
			</main>
		</div>
	);
}

function MobileTopBar({ onOpen }: { onOpen: () => void }) {
	return (
		<div className="flex items-center gap-2 border-b border-border bg-surface-1 px-3 py-2 lg:hidden">
			<button
				type="button"
				onClick={onOpen}
				className="flex h-7 w-7 items-center justify-center rounded border border-border text-fg-1 hover:border-border-strong hover:text-fg-0"
				aria-label="Open session list"
			>
				<Menu className="h-4 w-4" />
			</button>
			<img src="/favicon.svg" alt="omp" className="h-5 w-5" />
			<span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-fg-2">omp web</span>
			<span className="ml-auto flex items-center gap-2">
				<ThemeToggle />
				<SettingsLink />
				<LogoutButton />
			</span>
		</div>
	);
}

function SessionRail({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { sessions, refresh } = useSessions();
	const location = useLocation();
	const navigate = useNavigate();
	const [showNew, setShowNew] = React.useState<string | true | null>(null);
	const [showResume, setShowResume] = React.useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
	const [assistantBusy, setAssistantBusy] = React.useState(false);

	// The omp assistant is a singleton-ish conversation: reuse the latest one,
	// spawn it on first use. It manages omp's own config through chat. A config
	// helper's old context goes stale (and misleads), so sessions untouched for
	// a day are reset automatically on open.
	async function openAssistant() {
		const existing = sessions.find(s => s.kind === "assistant");
		if (existing) {
			if (Date.now() - existing.updatedAt > ASSISTANT_STALE_MS) {
				setAssistantBusy(true);
				try {
					const info = await api.serverInfo();
					const session = await api.createSession({ cwd: info.defaultCwd, assistant: true });
					await api.deleteSession(existing.id).catch(() => {});
					refresh();
					navigate(`/sessions/${session.id}`);
				} finally {
					setAssistantBusy(false);
				}
				return;
			}
			navigate(`/sessions/${existing.id}`);
			return;
		}
		setAssistantBusy(true);
		try {
			const info = await api.serverInfo();
			const session = await api.createSession({ cwd: info.defaultCwd, assistant: true });
			refresh();
			navigate(`/sessions/${session.id}`);
		} finally {
			setAssistantBusy(false);
		}
	}
	const [filter, setFilter] = React.useState("");
	const [filterOpen, setFilterOpen] = React.useState(false);
	const activeId = /^\/sessions\/([^/]+)/.exec(location.pathname)?.[1];
	const assistant = sessions.find(s => s.kind === "assistant");
	const filtered = React.useMemo(() => {
		const q = filter.trim().toLowerCase();
		const workspace = sessions.filter(s => s.kind !== "assistant");
		if (!q) return workspace;
		return workspace.filter(s => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
	}, [sessions, filter]);

	// Sessions grouped by working directory, groups ordered by most recent
	// activity so the workspace you touched last sits on top.
	const workspaceGroups = React.useMemo(() => {
		const byCwd = new Map<string, typeof filtered>();
		for (const session of filtered) {
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		return [...byCwd.entries()]
			.map(([cwd, groupSessions]) => ({
				cwd,
				sessions: [...groupSessions].sort((a, b) => b.updatedAt - a.updatedAt),
			}))
			.sort((a, b) => Math.max(...b.sessions.map(s => s.updatedAt)) - Math.max(...a.sessions.map(s => s.updatedAt)));
	}, [filtered]);

	// Close the drawer when navigating (mobile).
	// biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on navigation
	React.useEffect(() => {
		onClose();
	}, [location.pathname]);

	return (
		<>
			{/* Scrim for the mobile drawer */}
			{open ? (
				<div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={onClose} aria-hidden="true" />
			) : null}

			<aside
				className={[
					"flex-col border-r border-border bg-surface-1",
					// Mobile: fixed overlay drawer; Desktop: static column.
					open ? "flex" : "hidden",
					"max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-72 max-lg:shadow-2xl",
					"lg:flex lg:w-[264px] lg:shrink-0",
				].join(" ")}
			>
				<div className="flex h-11 items-center gap-2 border-b border-border px-4">
					<img src="/favicon.svg" alt="omp" className="h-5 w-5" />
					<span className="font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-fg-2">
						omp web
					</span>
					<button
						type="button"
						onClick={onClose}
						className="ml-auto flex h-6 w-6 items-center justify-center text-fg-3 hover:text-fg-0 lg:hidden"
						aria-label="Close session list"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{/* Workspace header + actions (new / resume / filter) */}
					<div className="flex items-center gap-1 border-b border-border px-3 py-2">
						<span className="ml-1 font-mono text-[10.5px] text-fg-3">Workspace</span>
						<div className="ml-auto flex items-center gap-1">
							<button
								type="button"
								onClick={() => setShowNew(true)}
								className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-cat-conversation"
								title="New session"
								aria-label="New session"
							>
								<Plus className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={() => setShowResume(true)}
								className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-cat-subagent"
								title="Resume an omp session from history"
								aria-label="Resume omp session"
							>
								<History className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={() => setFilterOpen(o => !o)}
								className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg-0"
								title="Filter sessions"
								aria-label="Filter sessions"
							>
								<Search className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
					{filterOpen ? (
						<div className="border-b border-border px-3 py-2">
							<input
								value={filter}
								onChange={e => setFilter(e.target.value)}
								className="w-full rounded border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-0 outline-none focus:border-cat-conversation"
								placeholder="filter…"
								spellCheck={false}
							/>
						</div>
					) : null}
					{filtered.length === 0 ? (
						<div className="px-4 py-3 font-mono text-[11px] text-fg-3">
							{sessions.length === 0 ? "No sessions yet." : "No matches."}
						</div>
					) : (
						workspaceGroups.map(group => (
							<div key={group.cwd}>
								{/* Workspace group header: a heavier band so the parent
								    level reads clearly against the session rows. */}
								<div className="flex items-center gap-2 border-y border-border bg-surface-0 px-4 py-2">
									<Folder className="h-3.5 w-3.5 shrink-0 text-cat-config" />
									<span
										className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-1"
										title={group.cwd}
									>
										{workspaceLabel(group.cwd)}
									</span>
									<span className="shrink-0 rounded bg-surface-2 px-1.5 font-mono text-[9px] tabular text-fg-3">
										{group.sessions.length}
									</span>
									<button
										type="button"
										onClick={() => setShowNew(group.cwd)}
										className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-cat-conversation"
										title={`New session in ${group.cwd}`}
										aria-label={`New session in ${workspaceLabel(group.cwd)}`}
									>
										<Plus className="h-3.5 w-3.5" />
									</button>
								</div>
								{group.sessions.map(session => (
									<SessionRow
										key={session.id}
										sessionId={session.id}
										name={session.name}
										status={session.status}
										updatedAt={session.updatedAt}
										lastPrompt={session.lastPrompt}
										kind={session.kind}
										active={session.id === activeId}
										onDelete={() => setConfirmDeleteId(session.id)}
									/>
								))}
							</div>
						))
					)}
				</div>

				{/* Bottom: "manage omp" utilities. The assistant keeps its card UI
				    (icon box + two-line text + status dot); it never appears in
				    the workspace list and is never deletable — the rail recreates
				    it on demand. */}
				<div className="border-t border-border">
					<button
						type="button"
						onClick={openAssistant}
						disabled={assistantBusy}
						className={[
							"flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors disabled:opacity-50",
							assistant && assistant.id === activeId ? "bg-surface-2" : "hover:bg-surface-1",
						].join(" ")}
					>
						<span
							className={[
								"flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
								assistant && assistant.id === activeId
									? "border-cat-subagent/60 bg-cat-subagent/10"
									: "border-border bg-surface-2",
							].join(" ")}
						>
							<Bot className="h-4 w-4 text-cat-subagent" />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-0">
								omp assistant
							</span>
							<span className="block truncate font-mono text-[9.5px] text-fg-3">
								{assistantBusy ? "starting…" : "configure omp through chat"}
							</span>
						</span>
						{assistant ? (
							<span
								className={[
									"inline-block h-[7px] w-[7px] shrink-0 rounded-full",
									assistant.status === "running"
										? "bg-sev-success"
										: assistant.status === "error"
											? "bg-sev-error"
											: "bg-fg-3",
								].join(" ")}
							/>
						) : null}
					</button>
				</div>

				{showNew ? (
					<NewSessionDialog
						fixedCwd={typeof showNew === "string" ? showNew : undefined}
						onClose={() => setShowNew(null)}
						onCreated={session => {
							setShowNew(null);
							refresh();
							window.location.href = `/sessions/${session.id}`;
						}}
					/>
				) : null}

				{showResume ? (
					<ResumeSessionDialog
						onClose={() => setShowResume(false)}
						onOpened={sessionId => {
							setShowResume(false);
							refresh();
							navigate(`/sessions/${sessionId}`);
						}}
					/>
				) : null}
			</aside>

			{confirmDeleteId ? (
				<ConfirmDialog
					title="Delete session"
					message={
						<>Delete this session? This stops the agent and removes its conversation data from the server.</>
					}
					confirmLabel="delete"
					onCancel={() => setConfirmDeleteId(null)}
					onConfirm={() => {
						const id = confirmDeleteId;
						setConfirmDeleteId(null);
						void api.deleteSession(id).then(refresh);
					}}
				/>
			) : null}
		</>
	);
}

interface SessionRowProps {
	sessionId: string;
	name: string;
	status: string;
	updatedAt: number;
	lastPrompt?: string;
	kind?: string;
	active: boolean;
	onDelete: () => void;
}

/** Short workspace label: last two path segments (e.g. `owner/project`). */
function workspaceLabel(cwd: string): string {
	const segments = cwd.split("/").filter(Boolean);
	if (segments.length <= 1) return segments[0] ?? "/";
	return segments.slice(-2).join("/");
}

function SessionRow({ sessionId, name, status, updatedAt, lastPrompt, kind, active, onDelete }: SessionRowProps) {
	return (
		<div
			className={[
				"group relative border-b border-border transition-colors",
				active ? "bg-surface-2" : "hover:bg-surface-1",
			].join(" ")}
		>
			{active ? <span className="absolute inset-y-0 left-0 w-[2px] bg-cat-conversation" /> : null}
			{/* Indented under the workspace group header (child level). */}
			<Link to={`/sessions/${sessionId}`} className="block py-2 pl-9 pr-8">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<span
							className={[
								"inline-block h-[7px] w-[7px] shrink-0 rounded-full",
								status === "running" ? "bg-sev-success" : status === "error" ? "bg-sev-error" : "bg-fg-3",
							].join(" ")}
						/>
						<span className="truncate font-mono text-[12px] text-fg-0" title={name}>
							{name}
						</span>
						{kind === "assistant" ? (
							<span
								className="shrink-0 rounded border border-cat-subagent/50 px-1 font-mono text-[8.5px] uppercase tracking-[0.08em] text-cat-subagent"
								title="omp assistant session"
							>
								assistant
							</span>
						) : null}
					</div>
					<span className="shrink-0 font-mono text-[10.5px] tabular text-fg-3">
						{formatRelativeTime(updatedAt)}
					</span>
				</div>
				<div
					className="mt-0.5 truncate pl-[15px] font-mono text-[10.5px] text-fg-3"
					title={lastPrompt ?? undefined}
				>
					{lastPrompt ?? (status === "running" ? "running" : status === "starting" ? "starting…" : "stopped")}
				</div>
			</Link>
			<button
				type="button"
				onClick={e => {
					e.preventDefault();
					e.stopPropagation();
					onDelete();
				}}
				className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center border border-transparent text-fg-3 transition-colors hover:border-sev-error hover:text-sev-error"
				title={`Delete session ${name}`}
				aria-label={`Delete session ${name}`}
			>
				<TrashIcon />
			</button>
		</div>
	);
}

function TrashIcon() {
	return (
		<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
			<path d="M2 3 H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
			<path d="M4 3 V2 H8 V3" stroke="currentColor" strokeWidth="1.2" fill="none" />
			<path d="M3 4 H9 L8.5 10 H3.5 Z" stroke="currentColor" strokeWidth="1.2" fill="none" />
		</svg>
	);
}
