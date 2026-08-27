/**
 * Model-role value composition for the settings editor.
 *
 * omp stores each modelRoles entry as ONE string — `provider/model` or
 * `provider/model:thinking` — but the UI edits it as two fields (model +
 * thinking level). These helpers keep that mapping lossless: unknown suffixes
 * stay glued to the model so omp's own validation keeps handling them, and an
 * empty thinking field means "no pinned level" (there is deliberately no
 * "inherit" entry — absence of a suffix already means follow the default).
 */

export const ROLE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface RoleValueParts {
	model: string;
	/** Empty when no level is pinned to the role. */
	thinking: string;
}

export function parseRoleValue(value: string | undefined): RoleValueParts {
	const raw = (value ?? "").trim();
	const separator = raw.lastIndexOf(":");
	if (separator <= 0) return { model: raw, thinking: "" };
	const model = raw.slice(0, separator);
	const thinking = raw.slice(separator + 1);
	if (thinking === "") return { model, thinking: "" };
	if ((ROLE_THINKING_LEVELS as readonly string[]).includes(thinking)) return { model, thinking };
	// Not a level we know — leave the whole string as the model value; omp
	// validates role values and will reject anything actually invalid.
	return { model: raw, thinking: "" };
}

export function joinRoleValue(model: string, thinking: string): string {
	const trimmedModel = model.trim();
	if (!trimmedModel) return "";
	const trimmedThinking = thinking.trim();
	return trimmedThinking ? `${trimmedModel}:${trimmedThinking}` : trimmedModel;
}
