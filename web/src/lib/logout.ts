/**
 * Logout decision logic, split out of the component so the gating contract is
 * unit testable: logging out may only re-gate the UI when the server genuinely
 * requires auth and no longer accepts our cookie. On an open server (auth
 * disabled) logout must stay a visual no-op instead of trapping the user
 * behind an unsatisfiable token prompt.
 */

/** Perform the server-side revocation, then report whether the app should re-gate. */
export async function logoutDeterminesGate(): Promise<boolean> {
	try {
		await fetch("/api/auth/logout", { method: "POST" });
	} catch {
		// network hiccup — fall through to the auth probe below
	}
	try {
		const res = await fetch("/api/auth");
		return res.status === 401;
	} catch {
		return true; // can't confirm access → fail safe behind the gate
	}
}
