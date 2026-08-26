import { Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

/** Icon-button twin of {@link ThemeToggle}: opens the raw config editor. */
export function SettingsLink({ className }: { className?: string }) {
	const navigate = useNavigate();
	const location = useLocation();
	const active = location.pathname === "/settings";
	return (
		<button
			type="button"
			onClick={() => (active ? navigate(-1) : navigate("/settings"))}
			className={[
				"flex h-6 w-6 items-center justify-center rounded border text-fg-3 hover:text-fg-0",
				active ? "border-cat-conversation text-cat-conversation" : "border-border hover:border-border-strong",
				className ?? "",
			].join(" ")}
			title="Settings (omp config)"
			aria-label="Settings"
		>
			<Settings className="h-3.5 w-3.5" />
		</button>
	);
}
