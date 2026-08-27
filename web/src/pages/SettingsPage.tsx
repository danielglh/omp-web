import { Check, Loader2, RotateCw, Search } from "lucide-react";
import * as React from "react";
import { api } from "../api";
import { ROLE_THINKING_LEVELS, joinRoleValue, parseRoleValue } from "../lib/modelRoles";

interface ConfigEntry {
	key: string;
	value?: unknown;
	type: string;
	description?: string;
}

const MODEL_ROLE_KEYS = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"tiny",
	"task",
	"advisor",
] as const;

/** Curated option lists for enum keys omp doesn't document options for. */
const ENUM_OPTIONS: Record<string, string[]> = {
	"tools.approvalMode": ["always-ask", "write", "yolo"],
	defaultThinkingLevel: ["minimal", "low", "medium", "high", "xhigh", "max", "auto"],
};

function formatValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/**
 * Server-wide omp settings, backed by `omp config list/set/reset` (there is no
 * config RPC). The model-roles card edits the `modelRoles` record as a whole
 * (omp rejects dotted sub-keys); everything else edits one key per row.
 */
export function SettingsPage() {
	const [configPath, setConfigPath] = React.useState("");
	const [entries, setEntries] = React.useState<ConfigEntry[]>([]);
	const [models, setModels] = React.useState<Array<{ provider: string; id: string; name?: string }>>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | undefined>();
	const [search, setSearch] = React.useState("");

	const refresh = React.useCallback(() => {
		setLoading(true);
		Promise.all([api.getConfig(), api.getModels().catch(() => [])])
			.then(([config, modelList]) => {
				setConfigPath(config.path);
				setEntries(config.entries);
				setModels(modelList);
				setError(undefined);
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, []);

	React.useEffect(() => refresh(), [refresh]);

	const modelRoles = React.useMemo(() => {
		const entry = entries.find(e => e.key === "modelRoles");
		const value = entry?.value;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
	}, [entries]);

	const query = search.trim().toLowerCase();
	const filtered = React.useMemo(
		() =>
			query
				? entries.filter(
						e => e.key.toLowerCase().includes(query) || (e.description ?? "").toLowerCase().includes(query),
					)
				: entries,
		[entries, query],
	);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl px-4 py-6">
				<div className="mb-1 flex items-center gap-3">
					<span className="font-mono text-[13px] font-semibold uppercase tracking-[0.2em] text-fg-0">
						settings
					</span>
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-3" /> : null}
					<button
						type="button"
						onClick={refresh}
						className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[10.5px] text-fg-1 hover:border-border-strong hover:bg-surface-2"
						title="Reload from omp config"
					>
						<RotateCw className="h-3 w-3" />
						refresh
					</button>
				</div>
				{configPath ? (
					<div className="mb-6 truncate font-mono text-[10px] text-fg-3" title={configPath}>
						{configPath}
					</div>
				) : null}
				{error ? (
					<div className="mb-4 rounded-md border border-sev-error/40 bg-sev-error/10 px-3 py-2 font-mono text-[11px] text-sev-error">
						{error}
					</div>
				) : null}

				<ModelRolesCard roles={modelRoles} models={models} onSaved={refresh} disabled={loading} />

				{/* Full catalog */}
				<div className="mb-2 mt-8 flex items-center gap-2">
					<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">
						all settings · {entries.length} keys
					</span>
				</div>
				<div className="relative mb-3">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
					<input
						value={search}
						onChange={e => setSearch(e.target.value)}
						placeholder="filter keys or descriptions…"
						className="w-full rounded-md border border-border bg-surface-0 py-1.5 pl-8 pr-3 font-mono text-[11.5px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
						spellCheck={false}
					/>
				</div>
				<div className="space-y-1.5 pb-10">
					{filtered.map(entry => (
						<SettingRow key={entry.key} entry={entry} onSaved={refresh} />
					))}
					{!loading && filtered.length === 0 ? (
						<div className="px-2 py-4 font-mono text-[11px] text-fg-3">no matching keys</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function ModelRolesCard({
	roles,
	models,
	onSaved,
	disabled,
}: {
	roles: Record<string, string>;
	models: Array<{ provider: string; id: string; name?: string }>;
	onSaved: () => void;
	disabled?: boolean;
}) {
	const [draft, setDraft] = React.useState<Record<string, string>>(roles);
	const [saving, setSaving] = React.useState(false);
	const [error, setError] = React.useState<string | undefined>();
	// Re-seed when a refresh delivers new values.
	const [seeded, setSeeded] = React.useState(false);
	React.useEffect(() => {
		if (!seeded || Object.keys(roles).length > 0) {
			setDraft(roles);
			setSeeded(true);
		}
	}, [roles, seeded]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(roles);

	async function save() {
		setSaving(true);
		setError(undefined);
		try {
			await api.setConfig("modelRoles", JSON.stringify(draft));
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const modelOptions = React.useMemo(() => {
		const seen = new Set<string>();
		const list: string[] = [];
		for (const model of models) {
			const value = `${model.provider}/${model.id}`;
			if (seen.has(value)) continue;
			seen.add(value);
			list.push(value);
		}
		return list.sort();
	}, [models]);

	return (
		<section className="rounded-lg border border-border-strong bg-surface-1">
			<div className="border-b border-border px-4 py-2.5">
				<div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-0">model roles</div>
				<div className="mt-0.5 font-mono text-[9.5px] text-fg-3">
					which model each agent role uses, plus an optional pinned thinking level (stored as
					<code className="mx-1 rounded bg-surface-2 px-1">provider/model:level</code>) —
					<span className="text-cat-subagent"> default</span> drives new sessions and the omp assistant (reset the
					assistant ↺ after changing it)
				</div>
			</div>
			<div className="grid grid-cols-1 gap-y-2 px-4 py-3">
				{MODEL_ROLE_KEYS.map(role => (
					<div key={role} className="flex items-center gap-2">
						<span
							className={`w-16 shrink-0 text-right font-mono text-[10.5px] ${role === "default" ? "text-cat-subagent" : "text-fg-3"}`}
							title={role === "default" ? "Used by new sessions and the omp assistant" : undefined}
						>
							{role === "default" ? "default ★" : role}
						</span>
						<input
							list="omp-model-options"
							value={parseRoleValue(draft[role]).model}
							placeholder={role === "default" ? "(omp built-in default)" : "(inherit default)"}
							onChange={e =>
								setDraft(d => ({
									...d,
									[role]: joinRoleValue(e.target.value, parseRoleValue(d[role]).thinking),
								}))
							}
							className="min-w-0 flex-1 rounded border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
							spellCheck={false}
						/>
						<select
							value={parseRoleValue(draft[role]).thinking}
							aria-label={`${role} thinking level`}
							title={`Pinned thinking level for ${role} (stored as provider/model:level)`}
							onChange={e =>
								setDraft(d => ({ ...d, [role]: joinRoleValue(parseRoleValue(d[role]).model, e.target.value) }))
							}
							className="w-28 shrink-0 rounded border border-border bg-surface-0 px-2 py-1 font-mono text-[10.5px] text-fg-0 outline-none focus:border-cat-conversation"
						>
							<option value="">default</option>
							{ROLE_THINKING_LEVELS.map(level => (
								<option key={level} value={level}>
									{level}
								</option>
							))}
						</select>
					</div>
				))}
			</div>
			<datalist id="omp-model-options">
				{modelOptions.slice(0, 300).map(option => (
					<option key={option} value={option} />
				))}
			</datalist>
			{error ? <div className="px-4 pb-2 font-mono text-[10.5px] text-sev-error">{error}</div> : null}
			<div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
				<button
					type="button"
					disabled={!dirty || saving || disabled}
					onClick={() => setDraft(roles)}
					className="rounded-md border border-border px-3 py-1 font-mono text-[10.5px] text-fg-1 hover:bg-surface-2 disabled:opacity-40"
				>
					revert
				</button>
				<button
					type="button"
					disabled={!dirty || saving || disabled}
					onClick={save}
					className="flex items-center gap-1.5 rounded-md border border-cat-conversation bg-cat-conversation px-3 py-1 font-mono text-[10.5px] font-semibold text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
					save roles
				</button>
			</div>
		</section>
	);
}

function SettingRow({ entry, onSaved }: { entry: ConfigEntry; onSaved: () => void }) {
	const initial = formatValue(entry.value);
	const [value, setValue] = React.useState(initial);
	const [state, setState] = React.useState<"idle" | "saving" | "error">("idle");
	const [error, setError] = React.useState<string | undefined>();
	// Re-seed when a refresh delivers a new server value.
	React.useEffect(() => setValue(initial), [initial]);

	const dirty = value !== initial;
	const options = ENUM_OPTIONS[entry.key];

	async function save() {
		setState("saving");
		setError(undefined);
		try {
			await api.setConfig(entry.key, value);
			setState("idle");
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setState("error");
		}
	}

	async function reset() {
		setState("saving");
		setError(undefined);
		try {
			await api.resetConfig(entry.key);
			setState("idle");
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setState("error");
		}
	}

	return (
		<div className="rounded-md border border-border bg-surface-1 px-3 py-2">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-0" title={entry.key}>
					{entry.key}
				</span>
				{dirty ? (
					<button
						type="button"
						onClick={save}
						disabled={state === "saving"}
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-cat-conversation text-cat-conversation hover:bg-cat-conversation/10 disabled:opacity-40"
						title="Save"
					>
						{state === "saving" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
					</button>
				) : null}
				<button
					type="button"
					onClick={reset}
					disabled={state === "saving" || entry.value === undefined}
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-fg-3 hover:text-fg-0 disabled:opacity-30"
					title={entry.value === undefined ? "not set" : "Reset to default"}
				>
					<RotateCw className="h-3 w-3" />
				</button>
			</div>
			{entry.description ? (
				<div
					className="mt-0.5 line-clamp-2 font-mono text-[9.5px] leading-snug text-fg-3"
					title={entry.description}
				>
					{entry.description}
				</div>
			) : null}
			<div className="mt-1.5">
				{entry.type === "boolean" ? (
					<BooleanEditor value={value === "true"} onChange={v => setValue(String(v))} />
				) : options ? (
					<select
						value={value}
						onChange={e => setValue(e.target.value)}
						className="w-full rounded border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-0 outline-none focus:border-cat-conversation"
					>
						{options.map(option => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				) : (
					<input
						value={value}
						onChange={e => setValue(e.target.value)}
						placeholder="(not set)"
						className="w-full rounded border border-border bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg-0 outline-none placeholder:text-fg-3 focus:border-cat-conversation"
						spellCheck={false}
					/>
				)}
			</div>
			{error ? <div className="mt-1 font-mono text-[10px] text-sev-error">{error}</div> : null}
		</div>
	);
}

function BooleanEditor({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
	return (
		<button
			type="button"
			onClick={() => onChange(!value)}
			className={[
				"flex h-6 w-11 items-center rounded-full border px-0.5 transition-colors",
				value ? "border-cat-conversation/60 bg-cat-conversation/20" : "border-border bg-surface-0",
			].join(" ")}
			role="switch"
			aria-checked={value}
		>
			<span
				className={[
					"h-4.5 w-4.5 rounded-full transition-transform",
					value ? "translate-x-[1.375rem] bg-cat-conversation" : "translate-x-0 bg-fg-3",
				].join(" ")}
			/>
		</button>
	);
}
