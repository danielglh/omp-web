import { Moon, Sun } from "lucide-react";
import * as React from "react";
import { getPreferredTheme, toggleTheme } from "../../lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
	const [theme, setTheme] = React.useState(getPreferredTheme());
	const isDark = theme === "dark";
	return (
		<button
			type="button"
			onClick={() => setTheme(toggleTheme())}
			className={[
				"flex h-6 w-6 items-center justify-center rounded border border-border text-fg-3 hover:border-border-strong hover:text-fg-0",
				className ?? "",
			].join(" ")}
			title={`Switch to ${isDark ? "light" : "dark"} theme`}
			aria-label="Toggle theme"
		>
			{isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
		</button>
	);
}
