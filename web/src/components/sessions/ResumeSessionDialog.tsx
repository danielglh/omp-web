import { History, Loader2, X } from "lucide-react";
import * as React from "react";
import { api } from "../../api";
import { formatRelativeTime } from "../../lib/format";

interface ResumeSessionDialogProps {
	onClose: () => void;
	/** Initial cwd to list (defaults to the server default). */
	initialCwd?: string;
	onOpened: (sessionId: string) => void;
}

/**
 * Browse resumable omp sessions from `~/.omp/agent/sessions` for a cwd and
 * open one as a new web session (the underlying omp session is reopened with
 * full history via `--session <id>`).
 */
export function ResumeSessionDialog({ onClose, initialCwd, onOpened }: ResumeSessionDialogProps) {
	const [cwd, setCwd] = React.useState(initialCwd ?? "");
	const [sessions, setSessions] = React.useState<Awaited<ReturnType<typeof api.listOmpSessions>>>([]);
	const [loading, setLoading] = React.useState(false);
	const [opening, setOpening] = React.useState<string | undefined>();
	const [error, setError] = React.useState<string | undefined>();

	React.useEffect(() => {
		let cancelled = false;
		const effective = cwd.trim() || initialCwd?.trim() || "";
		if (!effective) {
			api.serverInfo().then(info => {
				if (!cancelled) setCwd(info.defaultCwd);
			});
			return;
		}
		setLoading(true);
		api.listOmpSessions(effective)
			.then(list => {
				if (!cancelled) {
					setSessions(list);
					setError(undefined);
				}
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, initialCwd]);

	async function open(session: (typeof sessions)[number]) {
		setOpening(session.id);
		setError(undefined);
		try {
			const created = await api.createSession({
				cwd: session.cwd ?? cwd,
				name: session.title || undefined,
				resumeOmpSessionId: session.id,
			});
			onOpened(created.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setOpening(undefined);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="Resume omp session"
		>
			<form
				className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
				onClick={e => e.stopPropagation()}
			>
				<div className="flex items-center gap-2 border-b border-border px-4 py-3">
					<History className="h-3.5 w-3.5 text-cat-subagent" />
					<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-2">
						Resume omp session
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

				<div className="border-b border-border px-4 py-2.5">
					<input
						value={cwd}
						onChange={e => setCwd(e.target.value)}
						className="w-full rounded-md border border-border bg-surface-0 px-3 py-1.5 font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
						placeholder="/path/to/workspace"
						spellCheck={false}
					/>
					<div className="mt-1 font-mono text-[9.5px] text-fg-3">
						omp session history for this working directory (~/.omp/agent/sessions)
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{loading ? (
						<div className="flex items-center gap-2 px-4 py-6 font-mono text-[11px] text-fg-3">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							scanning sessions…
						</div>
					) : sessions.length === 0 ? (
						<div className="px-4 py-6 font-mono text-[11px] text-fg-3">no sessions found for this directory</div>
					) : (
						sessions.map(session => (
							<button
								key={session.id}
								type="button"
								disabled={opening !== undefined}
								onClick={() => open(session)}
								className="block w-full border-b border-border px-4 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
							>
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-0">
										{session.title || "(untitled)"}
									</span>
									<span className="shrink-0 font-mono text-[10px] text-fg-3">
										{formatRelativeTime(session.updatedAt)}
									</span>
									{opening === session.id ? (
										<Loader2 className="h-3 w-3 shrink-0 animate-spin text-cat-conversation" />
									) : null}
								</div>
								<div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-fg-3">
									<span className="truncate">{session.id}</span>
									{session.createdAt ? (
										<span className="shrink-0">{new Date(session.createdAt).toLocaleDateString()}</span>
									) : null}
								</div>
							</button>
						))
					)}
				</div>

				{error ? (
					<div className="border-t border-border px-4 py-2 font-mono text-[10.5px] text-sev-error">{error}</div>
				) : null}
			</form>
		</div>
	);
}
