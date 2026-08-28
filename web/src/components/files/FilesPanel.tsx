import * as React from "react";
import { api } from "../../api";
import { Markdown } from "../../lib/markdown";

interface WorkspaceEntry {
	name: string;
	type: "dir" | "file";
	size: number;
	mtime: number;
}

interface PreviewData {
	kind: "text" | "image" | "binary";
	mime: string;
	size: number;
	truncated: boolean;
	text?: string;
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Workspace file manager: a lazy-loading tree rooted at the session's working
 * directory plus a full-screen viewer (rendered markdown, sandboxed HTML,
 * images, plain text; binaries offer a download).
 */
export function FilesPanel({ cwd }: { cwd: string }) {
	const [dirs, setDirs] = React.useState<Record<string, WorkspaceEntry[]>>({});
	const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
	const [loadingDirs, setLoadingDirs] = React.useState<Record<string, boolean>>({});
	const [error, setError] = React.useState<string | undefined>();
	const [viewerPath, setViewerPath] = React.useState<string | undefined>();

	const loadDir = React.useCallback(async (dir: string) => {
		setLoadingDirs(state => ({ ...state, [dir]: true }));
		try {
			const res = await api.fsEntries(dir);
			setDirs(state => ({ ...state, [dir]: res.entries }));
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingDirs(state => {
				const next = { ...state };
				delete next[dir];
				return next;
			});
		}
	}, []);

	React.useEffect(() => {
		setDirs({});
		setExpanded({});
		setViewerPath(undefined);
		setError(undefined);
		if (cwd) void loadDir(cwd);
	}, [cwd, loadDir]);

	function toggleDir(dir: string) {
		const isOpen = expanded[dir];
		setExpanded(state => ({ ...state, [dir]: !isOpen }));
		if (!isOpen && !dirs[dir]) void loadDir(dir);
	}

	function openFile(file: string) {
		setViewerPath(file);
	}

	return (
		<div className="px-3 py-2">
			{error ? (
				<div className="rounded border border-sev-error/40 bg-sev-error/10 px-2 py-1 font-mono text-[10px] text-sev-error">
					{error}
				</div>
			) : null}
			<DirRows
				dir={cwd}
				entries={dirs[cwd] ?? []}
				depth={0}
				expanded={expanded}
				dirs={dirs}
				loadingDirs={loadingDirs}
				onToggle={toggleDir}
				onOpenFile={openFile}
			/>
			{viewerPath ? <FileViewer path={viewerPath} onClose={() => setViewerPath(undefined)} /> : null}
		</div>
	);
}

interface DirRowsProps {
	dir: string;
	entries: WorkspaceEntry[];
	depth: number;
	expanded: Record<string, boolean>;
	dirs: Record<string, WorkspaceEntry[]>;
	loadingDirs: Record<string, boolean>;
	onToggle: (dir: string) => void;
	onOpenFile: (file: string) => void;
}

function DirRows(props: DirRowsProps) {
	const { entries, depth } = props;
	if (entries.length === 0) {
		return <div className="py-1 pl-2 font-mono text-[10px] text-fg-3">(empty)</div>;
	}
	return (
		<>
			{entries.map(entry => {
				const fullPath = `${props.dir === "/" ? "" : props.dir}/${entry.name}`;
				if (entry.type === "dir") {
					const isOpen = props.expanded[fullPath];
					return (
						<React.Fragment key={fullPath}>
							<button
								type="button"
								onClick={() => props.onToggle(fullPath)}
								className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[11px] text-fg-1 hover:bg-surface-2"
								style={{ paddingLeft: depth * 12 + 4 }}
								title={fullPath}
							>
								<span className="w-3 shrink-0 text-fg-3">{isOpen ? "▾" : "▸"}</span>
								<span className="truncate">{entry.name}</span>
							</button>
							{isOpen ? (
								props.loadingDirs[fullPath] ? (
									<div
										style={{ paddingLeft: (depth + 1) * 12 + 4 }}
										className="py-0.5 font-mono text-[10px] text-fg-3"
									>
										loading…
									</div>
								) : (
									<DirRows
										dir={fullPath}
										entries={props.dirs[fullPath] ?? []}
										depth={depth + 1}
										expanded={props.expanded}
										dirs={props.dirs}
										loadingDirs={props.loadingDirs}
										onToggle={props.onToggle}
										onOpenFile={props.onOpenFile}
									/>
								)
							) : null}
						</React.Fragment>
					);
				}
				return (
					<button
						key={fullPath}
						type="button"
						onClick={() => props.onOpenFile(fullPath)}
						className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-0"
						style={{ paddingLeft: depth * 12 + 16 }}
						title={`${fullPath} · ${fmtBytes(entry.size)}`}
					>
						<span className="truncate">{entry.name}</span>
						<span className="ml-auto shrink-0 text-[9px] tabular text-fg-3">{fmtBytes(entry.size)}</span>
					</button>
				);
			})}
		</>
	);
}

// ── viewer ───────────────────────────────────────────────────────────────────

function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
	const [state, setState] = React.useState<{ loading: boolean; data?: PreviewData; error?: string }>({
		loading: true,
	});
	const [showSource, setShowSource] = React.useState(false);

	React.useEffect(() => {
		let cancelled = false;
		setState({ loading: true });
		api.fsPreview(path)
			.then(data => {
				if (!cancelled) setState({ loading: false, data });
			})
			.catch(err => {
				if (!cancelled) setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	React.useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const data = state.data;
	const isMarkdown = /\.mdx?$/i.test(path);
	const isHtml = /\.html?$/i.test(path);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
			<div
				className="flex h-[85vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-0 shadow-2xl"
				onClick={e => e.stopPropagation()}
			>
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
					<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-1" title={path}>
						{path}
					</span>
					{data?.kind === "text" && (isMarkdown || isHtml) ? (
						<button
							type="button"
							onClick={() => setShowSource(v => !v)}
							className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg-2 hover:text-fg-0"
						>
							{showSource ? "rendered" : "source"}
						</button>
					) : null}
					{data ? (
						<a
							href={api.fsDownloadUrl(path)}
							className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg-2 hover:text-fg-0"
						>
							download
						</a>
					) : null}
					<button
						type="button"
						onClick={onClose}
						className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-fg-2 hover:text-fg-0"
					>
						close
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-auto">
					{state.loading ? (
						<div className="p-4 font-mono text-[11px] text-fg-3">loading…</div>
					) : state.error ? (
						<div className="p-4 font-mono text-[11px] text-sev-error">{state.error}</div>
					) : data?.kind === "image" ? (
						<div className="flex h-full items-center justify-center p-4">
							<img src={api.fsRawUrl(path)} alt={path} className="max-h-full max-w-full object-contain" />
						</div>
					) : data?.kind === "binary" ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 font-mono text-[11px] text-fg-3">
							<span>binary file · {fmtBytes(data.size)}</span>
							<a
								href={api.fsDownloadUrl(path)}
								className="rounded border border-border px-3 py-1 text-fg-1 hover:text-fg-0"
							>
								download
							</a>
						</div>
					) : data?.kind === "text" ? (
						<>
							{data.truncated ? (
								<div className="border-b border-border bg-surface-1 px-3 py-1 font-mono text-[10px] text-sev-warning">
									preview truncated at 512KB — download for the full file
								</div>
							) : null}
							{data.mime === "text/markdown" && !showSource ? (
								<div className="p-4">
									<Markdown text={data.text ?? ""} />
								</div>
							) : isHtml && !showSource ? (
								<iframe
									title="html preview"
									sandbox=""
									srcDoc={data.text ?? ""}
									className="h-full min-h-[60vh] w-full bg-white"
								/>
							) : (
								<pre className="whitespace-pre-wrap p-4 font-mono text-[11.5px] leading-relaxed text-fg-1">
									{data.text}
								</pre>
							)}
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}
