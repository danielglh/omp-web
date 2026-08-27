import type { SessionSummary } from "@omp-web/shared";
import * as React from "react";
import {
	type SessionSnapshot,
	type SessionStore,
	acquireSessionStore,
	api,
	emptySnapshot,
	releaseSessionStore,
} from "./api";

export interface LiveSession {
	/** False before the ownership effect has acquired this session's store. */
	ready: boolean;
	snapshot: SessionSnapshot;
	store: SessionStore | undefined;
}

const PLACEHOLDER_SNAPSHOT = emptySnapshot();

/**
 * Acquire + subscribe to the session's live store for this component tree.
 *
 * Ownership lives inside an effect: every acquire is paired with exactly one
 * release (React's dev mount→cleanup→mount cycle stays balanced), navigating
 * between sessions releases the previous id, and the last component holding a
 * session closes its WebSocket instead of leaking it.
 */
export function useLiveSession(sessionId: string): LiveSession {
	const [live, setLive] = React.useState<LiveSession>({
		ready: false,
		snapshot: PLACEHOLDER_SNAPSHOT,
		store: undefined,
	});
	React.useEffect(() => {
		if (!sessionId) return;
		const store = acquireSessionStore(sessionId);
		const update = () => setLive({ ready: true, snapshot: store.getSnapshot(), store });
		update();
		const unsubscribe = store.subscribe(update);
		return () => {
			unsubscribe();
			releaseSessionStore(sessionId);
			setLive({ ready: false, snapshot: PLACEHOLDER_SNAPSHOT, store: undefined });
		};
	}, [sessionId]);
	return live;
}

interface SessionListState {
	sessions: SessionSummary[];
	loading: boolean;
	error?: string;
	refresh: () => void;
}

/** Session list with refresh-on-focus. Responses are sequence-guarded so a
 * slow stale fetch can never clobber fresher data. */
export function useSessions(): SessionListState {
	const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | undefined>();

	const refreshSeq = React.useRef(0);
	const refresh = React.useCallback(() => {
		const seq = ++refreshSeq.current;
		setLoading(true);
		api.listSessions()
			.then(list => {
				if (seq !== refreshSeq.current) return;
				setSessions(list);
				setError(undefined);
			})
			.catch(err => {
				if (seq !== refreshSeq.current) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (seq === refreshSeq.current) setLoading(false);
			});
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
