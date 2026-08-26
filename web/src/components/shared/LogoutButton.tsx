import { LogOut } from "lucide-react";
import { api } from "../../api";

/** Icon-button twin of {@link SettingsLink}: clears the auth session and
 * re-gates the app (no-op when auth is disabled). */
export function LogoutButton({ className }: { className?: string }) {
	return (
		<button
			type="button"
			onClick={() => {
				void api
					.authLogout()
					.catch(() => {})
					.finally(() => {
						window.dispatchEvent(new Event("omp-web:unauthorized"));
					});
			}}
			className={[
				"flex h-6 w-6 items-center justify-center rounded border border-border text-fg-3 hover:border-border-strong hover:text-fg-0",
				className ?? "",
			].join(" ")}
			title="Log out (clear access session)"
			aria-label="Log out"
		>
			<LogOut className="h-3.5 w-3.5" />
		</button>
	);
}
