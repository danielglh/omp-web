import { ArrowUp, Check, ChevronRight, Folder, Search, X } from "lucide-react";
import * as React from "react";
import { api } from "../../api";

interface FolderPickerProps {
	initialPath: string;
	onSelect: (path: string) => void;
	onClose: () => void;
}

/**
 * Directory browser for the working-directory field. Lists subdirectories of
 * the current path, supports navigation via breadcrumbs / up / click, and
 * fuzzy-filtering. Hidden (`.`) entries are hidden by default, with a toggle to
 * reveal them. Selecting "use this folder" returns the current path.
 */
export function FolderPicker({ initialPath, onSelect, onClose }: FolderPickerProps) {
	const [path, setPath] = React.useState(initialPath || "");
	const [parent, setParent] = React.useState<string | null>(null);
	const [dirs, setDirs] = React.useState<string[]>([]);
	const [filter, setFilter] = React.useState("");
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	const [showHidden, setShowHidden] = React.useState(false);
	// Tracks the currently browsed directory so toggling "hidden" reloads it.
	const pathRef = React.useRef(initialPath || "");
	pathRef.current = path;

	const load = React.useCallback(async (target: string, hidden: boolean) => {
		setLoading(true);
		setError(undefined);
		try {
			const list = await api.fsList(target || undefined, hidden);
			setPath(list.path);
			setParent(list.parent);
			setDirs(list.dirs);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setDirs([]);
			setParent(null);
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial load for the starting directory.
	React.useEffect(() => {
		void load(initialPath, false);
	}, [initialPath, load]);

	function goTo(target: string) {
		setFilter("");
		void load(target, showHidden);
	}

	function toggleHidden(value: boolean) {
		setShowHidden(value);
		void load(pathRef.current, value);
	}

	const visibleDirs = React.useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return dirs;
		return dirs.filter(d => d.toLowerCase().includes(q));
	}, [dirs, filter]);

	const crumbs = React.useMemo(() => {
		if (!path) return [];
		const parts = path.split("/").filter(Boolean);
		const out: Array<{ label: string; path: string }> = [];
		let acc = "";
		for (const part of parts) {
			acc = `${acc}/${part}`;
			out.push({ label: part, path: acc });
		}
		return out;
	}, [path]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
		>
			<div
				className="flex max-h-[62vh] w-full max-w-lg flex-col rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
				onClick={e => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
					<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-2">
						Choose directory
					</span>
					<button
						type="button"
						onClick={onClose}
						className="ml-auto flex h-6 w-6 items-center justify-center rounded border border-border text-fg-3 hover:text-fg-0"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* Breadcrumbs + up */}
				<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2">
					<button
						type="button"
						onClick={() => parent && goTo(parent)}
						disabled={!parent}
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-2 hover:bg-surface-2 hover:text-fg-0 disabled:opacity-30"
						title="Parent directory"
						aria-label="Parent directory"
					>
						<ArrowUp className="h-4 w-4" />
					</button>
					<Breadcrumbs crumbs={crumbs} onNavigate={goTo} />
				</div>

				{/* Filter + hidden toggle */}
				<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
					<Search className="h-3.5 w-3.5 shrink-0 text-fg-3" />
					<input
						value={filter}
						onChange={e => setFilter(e.target.value)}
						className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg-0 outline-none placeholder:text-fg-3"
						placeholder="filter this directory…"
						spellCheck={false}
					/>
					<label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5">
						<input
							type="checkbox"
							checked={showHidden}
							onChange={e => toggleHidden(e.target.checked)}
							className="h-3 w-3 accent-[var(--color-cat-conversation)]"
						/>
						<span className="font-mono text-[10px] text-fg-3">show hidden</span>
					</label>
				</div>

				{/* Directory list */}
				<div className="min-h-0 flex-1 overflow-y-auto py-1">
					{loading ? (
						<div className="px-4 py-8 text-center font-mono text-[11px] text-fg-3">loading…</div>
					) : error ? (
						<div className="px-4 py-6 font-mono text-[11px] text-sev-error">{error}</div>
					) : visibleDirs.length === 0 ? (
						<div className="px-4 py-8 text-center font-mono text-[11px] text-fg-3">
							{filter
								? "no matches"
								: showHidden
									? "no subdirectories"
									: "no subdirectories (hidden entries are hidden)"}
						</div>
					) : (
						visibleDirs.map(dir => (
							<button
								key={dir}
								type="button"
								onClick={() => goTo(`${path === "/" ? "" : path}/${dir}`)}
								className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[12px] text-fg-1 hover:bg-surface-2 hover:text-fg-0"
							>
								<Folder className="h-3.5 w-3.5 shrink-0 text-cat-config" />
								<span className="truncate">{dir}</span>
								<ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-3" />
							</button>
						))
					)}
				</div>

				{/* Footer */}
				<div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
					<div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg-2">
						<span className="shrink-0 text-fg-3">current:</span>
						<span className="truncate" title={path}>
							{path || "~"}
						</span>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-fg-1 hover:bg-surface-2"
						>
							cancel
						</button>
						<button
							type="button"
							onClick={() => onSelect(path || "/")}
							disabled={!path}
							className="flex items-center gap-1.5 rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1.5 font-mono text-[11px] font-semibold text-on-accent hover:opacity-90 disabled:opacity-40"
						>
							<Check className="h-3.5 w-3.5" />
							use this folder
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function Breadcrumbs({
	crumbs,
	onNavigate,
}: {
	crumbs: Array<{ label: string; path: string }>;
	onNavigate: (path: string) => void;
}) {
	if (crumbs.length === 0) {
		return <span className="font-mono text-[11px] text-fg-3">~</span>;
	}
	return (
		<div className="flex min-w-0 items-center">
			<button
				type="button"
				onClick={() => onNavigate("/")}
				className="shrink-0 rounded px-1 font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-0"
			>
				/
			</button>
			{crumbs.map((crumb, index) => {
				const isLast = index === crumbs.length - 1;
				return (
					<span key={crumb.path} className="flex min-w-0 items-center">
						<span className="shrink-0 text-fg-3">/</span>
						{isLast ? (
							<span className="truncate px-1 font-mono text-[11px] text-fg-0">{crumb.label}</span>
						) : (
							<button
								type="button"
								onClick={() => onNavigate(crumb.path)}
								className="shrink-0 truncate rounded px-1 font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-0"
							>
								{crumb.label}
							</button>
						)}
					</span>
				);
			})}
		</div>
	);
}
