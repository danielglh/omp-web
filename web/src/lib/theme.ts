/** Light/dark theme state persisted in localStorage, defaulting to the OS
 * preference. Applies by toggling `data-theme` on <html> (see theme.css). */

export type Theme = "light" | "dark";

const STORAGE_KEY = "omp-web-theme";

export function getStoredTheme(): Theme | null {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch {
		return null;
	}
}

export function getPreferredTheme(): Theme {
	const stored = getStoredTheme();
	if (stored) return stored;
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

export function applyTheme(theme: Theme): void {
	document.documentElement.setAttribute("data-theme", theme);
	document.documentElement.style.colorScheme = theme;
}

export function initTheme(): void {
	applyTheme(getPreferredTheme());
}

export function toggleTheme(): Theme {
	const next = getPreferredTheme() === "dark" ? "light" : "dark";
	applyTheme(next);
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// storage may be unavailable; theme still applies for this session.
	}
	return next;
}
