import { LogoutButton } from "../components/shared/LogoutButton";
import { SettingsLink } from "../components/shared/SettingsLink";
import { ThemeToggle } from "../components/shared/ThemeToggle";
import { useSessions } from "../hooks";

export function SessionListPage() {
	useSessions();

	return (
		<div className="relative flex h-full items-center justify-center">
			<div className="absolute right-3 top-3 hidden gap-2 lg:flex">
				<ThemeToggle />
				<SettingsLink />
				<LogoutButton />
			</div>
			<div className="max-w-md px-8 text-center">
				<img src="/omp-logomark.svg" alt="omp" className="mx-auto h-28 w-28" />
				<div className="mt-4 font-mono text-[13px] font-semibold uppercase tracking-[0.2em] text-fg-2">omp web</div>
				<div className="mt-2 font-mono text-[11px] text-fg-3">The Pi you love, with batteries included</div>
			</div>
		</div>
	);
}
