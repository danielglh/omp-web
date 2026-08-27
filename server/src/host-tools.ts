/**
 * Host tools exposed to the omp assistant.
 *
 * When an assistant-kind session's agent is told (via `set_host_tools`) that
 * these tools exist, invoking one makes the agent emit a `host_tool_call`
 * frame. The SessionManager intercepts those frames for assistant sessions,
 * runs them against its own registry/process management, and answers the agent
 * with `host_tool_result` — the call never reaches the browser.
 *
 * Wire-shape note: these mirror the conventions already used across the RPC
 * bridge (request/response share an id; results are flat objects). Verify once
 * against a real omp install before relying on it outside the mock host.
 */
import type { SessionManager } from "./sessions/manager";

export interface HostToolResult {
	content: string;
	isError?: boolean;
}

export interface HostToolDefinition {
	name: string;
	description: string;
}

/** Announced to the agent after each successful assistant-session spawn. */
export const ASSISTANT_HOST_TOOLS: HostToolDefinition[] = [
	{
		name: "omp_web_list_sessions",
		description: "List all omp-web sessions (id, name, working directory, status, kind). Takes no arguments.",
	},
	{
		name: "omp_web_create_session",
		description:
			'Create and start a new coding session. Arguments: {"cwd": "/absolute/path", "name"?: "display name", ' +
			'"prompt"?: "initial task", "approvalMode"?: "always-ask"|"write"|"yolo", "model"?: "provider/model", ' +
			'"resumeOmpSessionId"?: "omp session id to resume"}.',
	},
	{
		name: "omp_web_start_session",
		description:
			'Start or restart a session\'s agent (recovers errored/stopped sessions). Arguments: {"id": "session-id"}.',
	},
	{
		name: "omp_web_rename_session",
		description: 'Rename a session. Arguments: {"id": "session-id", "name": "new display name"}.',
	},
	{
		name: "omp_web_delete_session",
		description:
			'Delete a session by id (stops its agent and removes conversation data). Arguments: {"id": "session-id"}. You cannot delete your own hosting session.',
	},
	{
		name: "omp_web_stop_session",
		description:
			'Stop a session\'s agent without deleting anything. Arguments: {"id": "session-id"}. You cannot stop your own hosting session.',
	},
];

const APPROVAL_MODES = ["always-ask", "write", "yolo"];

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

type ManagerLike = Pick<SessionManager, "list" | "get" | "create" | "start" | "update" | "delete" | "stop">;

export async function runHostToolCall(
	manager: ManagerLike,
	callingSessionId: string,
	name: string,
	args: Record<string, unknown>,
): Promise<HostToolResult> {
	switch (name) {
		case "omp_web_list_sessions": {
			const rows = manager
				.list()
				.map(
					session =>
						`${session.name} · ${session.status}${session.kind === "assistant" ? " · assistant" : ""} · ${session.cwd} · id=${session.id}`,
				);
			return { content: rows.length === 0 ? "(no sessions)" : rows.join("\n") };
		}

		case "omp_web_create_session": {
			const cwd = optionalString(args, "cwd");
			if (!cwd) {
				return { content: "cwd is required (absolute path)", isError: true };
			}
			const approvalMode = optionalString(args, "approvalMode");
			if (approvalMode !== undefined && !APPROVAL_MODES.includes(approvalMode)) {
				return {
					content: `approvalMode must be one of ${APPROVAL_MODES.join(" | ")}`,
					isError: true,
				};
			}
			try {
				const created = await manager.create({
					cwd,
					name: optionalString(args, "name"),
					prompt: optionalString(args, "prompt"),
					approvalMode: approvalMode as never,
					model: optionalString(args, "model"),
					resumeOmpSessionId: optionalString(args, "resumeOmpSessionId"),
				});
				let suffix = "";
				if (created.ompSessionId) suffix += `, resumed omp session ${created.ompSessionId}`;
				return {
					content: `created session "${created.name}" (id=${created.id}, status=${created.status}, cwd=${created.cwd}${suffix})`,
				};
			} catch (error) {
				return { content: `failed to create session: ${describe(error)}`, isError: true };
			}
		}

		case "omp_web_start_session": {
			const id = optionalString(args, "id");
			if (!id) return { content: "id is required", isError: true };
			if (!manager.get(id)) return { content: `no such session: ${id}`, isError: true };
			try {
				const info = await manager.start(id);
				return { content: `started session ${id} (status=${info.status})` };
			} catch (error) {
				return { content: `failed to start session ${id}: ${describe(error)}`, isError: true };
			}
		}

		case "omp_web_rename_session": {
			const id = optionalString(args, "id");
			const newName = optionalString(args, "name");
			if (!id || !newName) return { content: "id and name are required", isError: true };
			if (!manager.get(id)) return { content: `no such session: ${id}`, isError: true };
			try {
				await manager.update(id, { name: newName });
				return { content: `renamed session ${id} to "${newName}"` };
			} catch (error) {
				return { content: `failed to rename session ${id}: ${describe(error)}`, isError: true };
			}
		}

		case "omp_web_delete_session": {
			const id = typeof args.id === "string" ? args.id.trim() : "";
			if (!id) return { content: "id is required", isError: true };
			if (id === callingSessionId) {
				return { content: "refusing to delete your own hosting session", isError: true };
			}
			if (!manager.get(id)) return { content: `no such session: ${id}`, isError: true };
			await manager.delete(id);
			return { content: `deleted session ${id}` };
		}

		case "omp_web_stop_session": {
			const id = typeof args.id === "string" ? args.id.trim() : "";
			if (!id) return { content: "id is required", isError: true };
			if (id === callingSessionId) {
				return { content: "refusing to stop your own hosting session", isError: true };
			}
			if (!manager.get(id)) return { content: `no such session: ${id}`, isError: true };
			await manager.stop(id);
			return { content: `stopped session ${id}` };
		}

		default:
			return { content: `unknown host tool: ${name}`, isError: true };
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
