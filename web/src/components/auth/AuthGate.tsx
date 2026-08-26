import { ArrowRight } from "lucide-react";
import * as React from "react";
import { api } from "../../api";

type Phase = "checking" | "locked" | "open";

/**
 * Full-screen access gate. While the server's access token (OMP_WEB_TOKEN) is
 * unauthenticated — or a mid-session request turns 401 — the whole app is
 * replaced by a centered token prompt.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
	const [phase, setPhase] = React.useState<Phase>("checking");

	React.useEffect(() => {
		let alive = true;
		api.authCheck()
			.then(ok => {
				if (alive) setPhase(ok ? "open" : "locked");
			})
			.catch(() => {
				if (alive) setPhase("locked"); // server unreachable → still show the gate
			});
		const onUnauthorized = () => setPhase("locked");
		window.addEventListener("omp-web:unauthorized", onUnauthorized);
		return () => {
			alive = false;
			window.removeEventListener("omp-web:unauthorized", onUnauthorized);
		};
	}, []);

	if (phase === "open") return children;
	if (phase === "checking") {
		return <div className="fixed inset-0 z-[100] bg-surface-0" aria-hidden="true" />;
	}
	return <TokenPrompt onAuthorized={() => setPhase("open")} />;
}

function TokenPrompt({ onAuthorized }: { onAuthorized: () => void }) {
	const [token, setToken] = React.useState("");
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState(false);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!token.trim() || busy) return;
		setBusy(true);
		setError("");
		try {
			await api.authLogin(token.trim());
			onAuthorized();
		} catch (err) {
			setError(err instanceof Error ? err.message : "login failed");
			setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0 px-6">
			<div className="w-full max-w-[340px]">
				<div className="flex flex-col items-center text-center">
					<img src="/favicon.svg" alt="omp" className="h-10 w-10" />
					<h1 className="mt-3 font-mono text-[14px] font-semibold uppercase tracking-[0.18em] text-fg-0">
						omp web
					</h1>
					<p className="mt-1 font-mono text-[10.5px] text-fg-3">enter access token to continue</p>
				</div>
				<form onSubmit={submit} className="mt-6">
					<div
						className={[
							"flex items-center gap-2 rounded-lg border bg-surface-1 px-3 transition-colors",
							error ? "border-sev-error" : "border-border focus-within:border-border-strong",
						].join(" ")}
					>
						<input
							autoFocus
							type="password"
							inputMode="text"
							autoComplete="off"
							spellCheck={false}
							value={token}
							onChange={e => {
								setToken(e.target.value);
								if (error) setError("");
							}}
							placeholder="access token"
							aria-label="Access token"
							className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg-0 outline-none placeholder:text-fg-3"
						/>
						<button
							type="submit"
							disabled={busy || token.trim().length === 0}
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-fg-2 transition-colors hover:border-border-strong hover:text-fg-0 disabled:opacity-40"
							aria-label="Submit access token"
						>
							<ArrowRight className="h-3.5 w-3.5" />
						</button>
					</div>
					{error ? <p className="mt-2 text-center font-mono text-[10.5px] text-sev-error">{error}</p> : null}
				</form>
			</div>
		</div>
	);
}
