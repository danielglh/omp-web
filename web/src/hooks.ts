import type { SessionSummary } from "@omp-web/shared";
import * as React from "react";
import { useSyncExternalStore } from "react";
import { type SessionSnapshot, type SessionStore, api, getSessionStore } from "./api";

/** Subscribe to a session's live snapshot. */
export function useSessionSnapshot(sessionId: string): SessionSnapshot {
	const store = getSessionStore(sessionId);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Live store instance (for sending commands). */
export function useSessionStore(sessionId: string): SessionStore {
	return getSessionStore(sessionId);
}

interface SessionListState {
	sessions: SessionSummary[];
	loading: boolean;
	error?: string;
	refresh: () => void;
}

/** Session list with refresh-on-focus. */
export function useSessions(): SessionListState {
	const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | undefined>();

	const refresh = React.useCallback(() => {
		setLoading(true);
		api.listSessions()
			.then(setSessions)
			.catch(err => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, []);

	React.useEffect(() => {
		refresh();
		const onFocus = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		const timer = setInterval(refresh, 30_000);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
			clearInterval(timer);
		};
	}, [refresh]);

	return { sessions, loading, error, refresh };
}
