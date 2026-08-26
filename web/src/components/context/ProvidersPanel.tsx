import { Check, KeyRound, Loader2 } from "lucide-react";
import * as React from "react";
import type { SessionSnapshot, SessionStore } from "../../api";

/**
 * OAuth providers (get_login_providers) and their auth state. Starting a login
 * (`login` RPC) makes the agent push an open_url link + an input dialog for
 * the pasted code through the extension-UI surfaces above the composer — the
 * same flow the terminal runs interactively. Auth is stored globally in
 * ~/.omp/agent/agent.db, so logging in from any session works for all of them.
 */
export function ProvidersPanel({ store, snapshot }: { store: SessionStore; snapshot: SessionSnapshot }) {
	const providers = snapshot.loginProviders;
	const [starting, setStarting] = React.useState<string | undefined>();

	React.useEffect(() => {
		if (snapshot.phase === "connected") store.fetchLoginProviders();
	}, [store, snapshot.phase]);

	// Clear the starting marker once auth state refreshes.
	React.useEffect(() => {
		if (starting && providers.some(p => p.id === starting && p.authenticated)) {
			setStarting(undefined);
		}
	}, [providers, starting]);

	if (providers.length === 0) {
		return (
			<div className="flex items-center gap-2 px-4 py-8 font-mono text-[10.5px] text-fg-3">
				<Loader2 className="h-3 w-3 animate-spin" />
				loading providers…
			</div>
		);
	}

	return (
		<div className="space-y-1.5 px-3 py-3">
			<div className="px-1 pb-1 font-mono text-[9.5px] leading-relaxed text-fg-3">
				oauth logins are shared across sessions (~/.omp/agent) — the flow opens a link and asks for the pasted code
				above the composer
			</div>
			{providers.map(provider => (
				<div
					key={provider.id}
					className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2"
				>
					<KeyRound
						className={`h-3.5 w-3.5 shrink-0 ${provider.authenticated ? "text-sev-success" : "text-fg-3"}`}
					/>
					<div className="min-w-0 flex-1">
						<div className="truncate font-mono text-[11px] text-fg-0">{provider.name}</div>
						<div className="font-mono text-[9px] text-fg-3">{provider.id}</div>
					</div>
					{provider.authenticated ? (
						<span className="flex shrink-0 items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-sev-success">
							<Check className="h-3 w-3" />
							in
						</span>
					) : provider.available ? (
						<button
							type="button"
							disabled={starting !== undefined}
							onClick={() => {
								setStarting(provider.id);
								store.loginProvider(provider.id);
							}}
							className="shrink-0 rounded-md border border-cat-conversation/50 px-2 py-1 font-mono text-[10px] text-cat-conversation hover:bg-cat-conversation/10 disabled:opacity-40"
						>
							{starting === provider.id ? "…" : "log in"}
						</button>
					) : (
						<span
							className="shrink-0 font-mono text-[9.5px] text-fg-3"
							title="Needs interactive terminal login or an API key"
						>
							cli only
						</span>
					)}
				</div>
			))}
		</div>
	);
}
