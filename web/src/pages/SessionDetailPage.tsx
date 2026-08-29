import { PanelRight, RotateCcw } from "lucide-react";
import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { SubagentPanel } from "../components/agents/SubagentPanel";
import { Composer } from "../components/chat/Composer";
import { ExtensionSurfaces } from "../components/chat/ExtensionUi";
import { Transcript } from "../components/chat/Transcript";
import { ContextPanel } from "../components/context/ContextPanel";
import { FilesPanel } from "../components/files/FilesPanel";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { LogoutButton } from "../components/shared/LogoutButton";
import { SettingsLink } from "../components/shared/SettingsLink";
import { ThemeToggle } from "../components/shared/ThemeToggle";
import { useLiveSession } from "../hooks";
import { shortId } from "../lib/format";

type TabId = "chat" | "agents" | "context" | "files";

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: "chat", label: "chat" },
	{ id: "agents", label: "agents" },
	{ id: "context", label: "context" },
	{ id: "files", label: "files" },
];

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const live = useLiveSession(sessionId ?? "");
	const { snapshot, store } = live;
	const [activeTab, setActiveTab] = React.useState<TabId>("chat");
	// Desktop starts with the side column open; narrow screens start collapsed
	// (there it opens as an overlay drawer instead).
	const [showSide, setShowSide] = React.useState(() => typeof window === "undefined" || window.innerWidth >= 1024);
	const autoStartRef = React.useRef(false);
	const [confirmResetAssistant, setConfirmResetAssistant] = React.useState(false);

	// Auto-start the agent when the session isn't running (e.g. after a server
	// restart), so opening a session is always ready to chat.
	React.useEffect(() => {
		if (!sessionId) return;
		const status = snapshot.session?.status;
		if ((status === "created" || status === "stopped" || status === "error") && !autoStartRef.current) {
			autoStartRef.current = true;
			let cancelled = false;
			const attempt = (retries: number) => {
				api.startSession(sessionId).catch(() => {
					autoStartRef.current = false; // a later status change may retry
					// Also retry on our own: the server may still be restarting
					// (dev --watch) or briefly out of processes.
					if (!cancelled && retries > 0) {
						setTimeout(() => {
							if (!cancelled && !autoStartRef.current) {
								autoStartRef.current = true;
								attempt(retries - 1);
							}
						}, 5000);
					}
				});
			};
			attempt(3);
			return () => {
				cancelled = true;
			};
		}
	}, [sessionId, snapshot.session?.status]);

	if (!sessionId || !store) {
		return (
			<div className="p-6 font-mono text-[12px] text-fg-3">
				{sessionId ? "connecting to session…" : "(no session id)"}
			</div>
		);
	}

	const session = snapshot.session;
	const isAssistant = session?.kind === "assistant";
	// Assistant reset: discard the (state-stale) conversation and start fresh —
	// the seeded workspace and configured defaults stay intact.
	async function resetAssistant() {
		if (!sessionId) return;
		const created = await api.createSession({ cwd: session?.cwd ?? "/", assistant: true });
		await api.deleteSession(sessionId).catch(() => {});
		setConfirmResetAssistant(false);
		navigate(`/sessions/${created.id}`);
	}

	const status = session?.status ?? "created";
	const running = status === "running" || status === "starting";

	const sideTabs: TabId[] = ["agents", "context", "files"];
	const sideTab = sideTabs.includes(activeTab) ? activeTab : "chat";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Header — the assistant keeps only identity + reset: no id/cwd/model
				    noise (it is a special, fixed-purpose session). */}
			<div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-4">
				<div className="flex min-w-0 items-center gap-2">
					<span
						className={[
							"inline-block h-2 w-2 shrink-0 rounded-full",
							running ? "bg-sev-success" : status === "error" ? "bg-sev-error" : "bg-fg-3",
						].join(" ")}
					/>
					<span
						className={`truncate font-mono text-fg-0 ${isAssistant ? "text-[12px] font-semibold uppercase tracking-[0.14em]" : "text-[13px]"}`}
						title={session?.name}
					>
						{session?.name ?? "…"}
					</span>
					{isAssistant ? (
						<button
							type="button"
							onClick={() => setConfirmResetAssistant(true)}
							className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-fg-3 hover:text-fg-0"
							title="Reset the assistant (discard conversation, keep configuration)"
							aria-label="Reset assistant"
						>
							<RotateCcw className="h-3 w-3" />
						</button>
					) : (
						<span className="shrink-0 font-mono text-[10px] text-fg-3">{shortId(sessionId, 10)}</span>
					)}
				</div>

				{!isAssistant ? (
					<div className="hidden min-w-0 items-center gap-2 font-mono text-[10.5px] text-fg-2 md:flex">
						<span className="truncate" title={session?.cwd}>
							{session?.cwd}
						</span>
						{session?.model ? <span className="text-fg-3">· {session.model}</span> : null}
					</div>
				) : null}

				<div className="ml-auto flex items-center gap-2">
					{/* The mobile top bar already carries these three — a second copy
						    here would show them twice on narrow screens. */}
					<div className="hidden items-center gap-2 lg:flex">
						<ThemeToggle />
						<SettingsLink />
						<LogoutButton />
					</div>
					<button
						type="button"
						onClick={() => setShowSide(s => !s)}
						className={[
							"rounded-md border p-1.5",
							showSide
								? "border-cat-conversation text-cat-conversation"
								: "border-border text-fg-3 hover:text-fg-1",
						].join(" ")}
						title="Toggle side panel"
						aria-label="Toggle side panel"
					>
						<PanelRight className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{/* Status error strip */}
			{session?.error ? (
				<div className="shrink-0 border-b border-sev-error/30 bg-sev-error/10 px-4 py-1.5 font-mono text-[10.5px] text-sev-error">
					{session.error}
				</div>
			) : null}

			{/* Body */}
			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
					<Transcript snapshot={snapshot} />
					<div className="shrink-0 px-4 pt-3">
						<ExtensionSurfaces store={store} snapshot={snapshot} />
					</div>
					<Composer store={store} snapshot={snapshot} assistant={session?.kind === "assistant"} />
				</div>

				{/* Side panel: static column on lg+, overlay drawer below */}
				<>
					{showSide ? (
						<div
							className="fixed inset-0 z-40 bg-black/50 lg:hidden"
							onClick={() => setShowSide(false)}
							aria-hidden="true"
						/>
					) : null}
					<aside
						className={[
							"w-[300px] flex-col border-l border-border bg-surface-1",
							showSide ? "flex" : "hidden",
							// Narrow: right-anchored drawer over the transcript.
							"max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:max-w-[88vw] max-lg:shadow-2xl",
							// Desktop: static column.
							"lg:static lg:shrink-0",
						].join(" ")}
					>
						<div className="flex shrink-0 items-center border-b border-border px-2">
							{TABS.filter(t => t.id !== "chat").map(tab => (
								<button
									key={tab.id}
									type="button"
									onClick={() => setActiveTab(tab.id)}
									className={[
										"px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors",
										sideTab === tab.id
											? "border-b-2 border-cat-conversation text-fg-0"
											: "text-fg-3 hover:text-fg-1",
									].join(" ")}
								>
									{tab.label}
								</button>
							))}
							<button
								type="button"
								onClick={() => setShowSide(false)}
								className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center text-fg-3 hover:text-fg-0 lg:hidden"
								aria-label="Close side panel"
							>
								×
							</button>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{sideTab === "agents" ? <SubagentPanel snapshot={snapshot} /> : null}
							{sideTab === "context" ? <ContextPanel store={store} snapshot={snapshot} /> : null}
							{sideTab === "files" && session?.cwd ? <FilesPanel cwd={session.cwd} /> : null}
						</div>
					</aside>
				</>
			</div>

			{confirmResetAssistant ? (
				<ConfirmDialog
					title="Reset omp assistant"
					message="Discard this conversation and start a fresh assistant? Your configuration is not touched — this is also how a changed default model takes effect."
					confirmLabel="reset"
					onCancel={() => setConfirmResetAssistant(false)}
					onConfirm={() => void resetAssistant()}
				/>
			) : null}
		</div>
	);
}
