/**
 * Unit tests for the SessionStore — the browser's state machine that turns
 * agent RPC frames into the transcript snapshot. A fake WebSocket drives the
 * store synchronously so frame handling (message upsert/dedupe, tool
 * executions, extension dialogs, notices, hydration) is verified without a
 * real connection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type SessionSnapshot, SessionStore, acquireSessionStore, releaseSessionStore } from "../src/api";

// ── fake transport ───────────────────────────────────────────────────────────

class FakeSocket {
	static instances: FakeSocket[] = [];
	url: string;
	readyState = 0;
	closed = false;
	sent: Array<Record<string, unknown>> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3;
		this.onclose?.();
	}

	open() {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(frame: unknown) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

let sockets: FakeSocket[];
const socketFactory = (url: string): WebSocket => {
	const sock = new FakeSocket(url);
	sockets.push(sock);
	return sock as unknown as WebSocket;
};

// SessionStore and request() touch `window` for popups and auth events.
const windowCalls: { open: string[]; events: string[] } = { open: [], events: [] };
// biome-ignore lint/suspicious/noExplicitAny: installing a minimal window stub for bun's runtime
(globalThis as any).window = {
	open: (url: string) => windowCalls.open.push(url),
	dispatchEvent: (event: Event) => windowCalls.events.push(event.type),
};

function makeStore(sessionId = "s1"): { store: SessionStore; sock: FakeSocket; snapshot: () => SessionSnapshot } {
	sockets = [];
	const store = new SessionStore(sessionId, {
		socketUrl: id => `ws://test/${id}`,
		socketFactory,
	});
	const sock = sockets[sockets.length - 1] as FakeSocket;
	return { store, sock, snapshot: () => store.getSnapshot() };
}

function agentEvent(frame: Record<string, unknown>) {
	return { type: "event", frame };
}

const USER_MSG = { role: "user", content: "hi", timestamp: 1000 };
const ASSISTANT_MSG = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 2000,
};

afterEach(() => {
	for (const sock of sockets) sock.close();
});

describe("connection lifecycle", () => {
	test("open sends hello and flips the phase to connected", () => {
		const { sock, snapshot } = makeStore("abc");
		expect(snapshot().phase).toBe("connecting");
		sock.open();
		expect(snapshot().phase).toBe("connected");
		expect(sock.url).toBe("ws://test/abc");
		expect(sock.sent[0]).toEqual({ type: "hello", sessionId: "abc" });
	});

	test("commands are wrapped in the rpc envelope; offline sends surface an error", () => {
		const { store, sock, snapshot } = makeStore();
		store.sendCommand({ type: "get_state", id: "x" });
		expect(snapshot().error).toBe("not connected");
		sock.open();
		store.sendCommand({ type: "prompt", message: "go" });
		expect(sock.sent.at(-1)).toEqual({ type: "rpc", command: "prompt", message: "go" });
	});

	test("process_exit and server_error frames surface as phase/error", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive({ type: "server_error", message: "boom" });
		expect(snapshot().error).toBe("boom");
		sock.receive({ type: "process_exit", code: 1, signal: null });
		expect(snapshot().phase).toBe("disconnected");
		expect(snapshot().error).toContain("agent process exited");
	});

	test("close() tears the socket down and stops reconnection", async () => {
		const { store, sock, snapshot } = makeStore();
		sock.open();
		store.close();
		expect(sock.closed).toBe(true);
		// A late server frame after close must not resurrect the phase.
		sock.receive({ type: "session", session: { status: "running" } as never });
		await new Promise(r => setTimeout(r, 50)); // would fire a reconnect timer
		expect(snapshot().phase).toBe("connected"); // unchanged by reconnect
	});
});

describe("transcript frames", () => {
	test("running session snapshot triggers hydration + subagent subscription", () => {
		const { sock } = makeStore();
		sock.open();
		sock.receive({
			type: "session",
			session: { id: "s1", status: "running" } as never,
		});
		const commands = sock.sent.map(m => (m.command as string) ?? m.type);
		expect(commands).toEqual([
			"hello",
			"get_state",
			"get_messages",
			"get_available_models",
			"get_available_commands",
			"set_subagent_subscription",
		]);
	});

	test("message upsert keeps one slot per timestamp and clears streaming on end", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive(agentEvent({ type: "message_update", message: USER_MSG }));
		expect(snapshot().messages).toHaveLength(1);
		expect(snapshot().messages[0]?.streaming).toBe(true);

		sock.receive(agentEvent({ type: "message_update", message: { ...USER_MSG, content: "hi again" } }));
		expect(snapshot().messages).toHaveLength(1);
		expect((snapshot().messages[0]?.message as { content: string }).content).toBe("hi again");

		sock.receive(agentEvent({ type: "message_end", message: ASSISTANT_MSG }));
		expect(snapshot().messages).toHaveLength(2);
		expect(snapshot().messages[1]?.streaming).toBe(false);
	});

	test("history replaces slots without duplicating live messages", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive(agentEvent({ type: "message_update", message: USER_MSG }));
		sock.receive({
			type: "event",
			frame: {
				type: "response",
				command: "get_messages",
				success: true,
				data: { messages: [USER_MSG, ASSISTANT_MSG] },
			},
		});
		const messages = snapshot().messages;
		expect(messages).toHaveLength(2);
		expect(messages.every(m => !m.streaming)).toBe(true);
		// The live slot for USER_MSG was folded into history (sameMessage match).
		expect(messages[0]?.key.startsWith("h-")).toBe(true);
	});

	test("tool executions update immutably and synthesize a done entry for late joiners", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive(agentEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} }));
		const startEntry = snapshot().toolExecutions.get("t1");

		sock.receive(
			agentEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "read", partialResult: "p1" }),
		);
		const updated = snapshot().toolExecutions.get("t1");
		expect(updated?.status).toBe("running");
		expect(updated?.result).toBe("p1");
		// The previous snapshot's entry was never mutated in place.
		expect(startEntry?.result).toBeUndefined();
		expect(startEntry).not.toBe(updated);

		// A tool end without a witnessed start (mid-tool joiner) synthesizes.
		sock.receive(agentEvent({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: "done" }));
		expect(snapshot().toolExecutions.get("t2")).toMatchObject({ status: "done", result: "done", toolName: "bash" });
	});

	test("notices are capped at 61 entries", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		for (let i = 0; i < 70; i++) {
			sock.receive(agentEvent({ type: "notice", level: "info", message: `n${i}` }));
		}
		expect(snapshot().notices.length).toBe(61);
		expect(snapshot().notices.at(-1)?.message).toBe("n69");
	});
});

describe("extension ui surfaces", () => {
	test("select/confirm/input/editor queue; cancel removes; answers go over the wire", () => {
		const { store, sock } = makeStore();
		sock.open();
		sock.receive(
			agentEvent({ type: "extension_ui_request", id: "d1", method: "select", title: "t", options: ["a", "b"] }),
		);
		expect(snapshot_of(store).extensionRequests).toHaveLength(1);
		// Replay of the same id replaces instead of duplicating.
		sock.receive(
			agentEvent({ type: "extension_ui_request", id: "d1", method: "select", title: "t", options: ["a", "b"] }),
		);
		expect(snapshot_of(store).extensionRequests).toHaveLength(1);

		sock.receive(agentEvent({ type: "extension_ui_request", id: "d1", method: "cancel", targetId: "d1" }));
		expect(snapshot_of(store).extensionRequests).toHaveLength(0);

		sock.receive(
			agentEvent({ type: "extension_ui_request", id: "d2", method: "confirm", title: "c", message: "sure?" }),
		);
		store.answerExtensionRequest("d2", { confirmed: true });
		expect(sock.sent.at(-1)).toEqual({ type: "rpc", command: "extension_ui_response", id: "d2", confirmed: true });
		expect(snapshot_of(store).extensionRequests).toHaveLength(0);
	});

	test("widgets, status lines, editor prefill and open_url are tracked", () => {
		const { store, sock, snapshot } = makeStore();
		sock.open();
		sock.receive(
			agentEvent({
				type: "extension_ui_request",
				id: "w",
				method: "setWidget",
				widgetKey: "k",
				widgetLines: ["l1"],
			}),
		);
		expect(snapshot().widgets.k?.lines).toEqual(["l1"]);
		sock.receive(
			agentEvent({
				type: "extension_ui_request",
				id: "w",
				method: "setWidget",
				widgetKey: "k",
				widgetLines: undefined,
			}),
		);
		expect(snapshot().widgets.k).toBeUndefined();

		sock.receive(
			agentEvent({
				type: "extension_ui_request",
				id: "s",
				method: "setStatus",
				statusKey: "sk",
				statusText: "busy",
			}),
		);
		expect(snapshot().statusEntries.sk).toBe("busy");

		sock.receive(agentEvent({ type: "extension_ui_request", id: "e", method: "set_editor_text", text: "draft" }));
		expect(snapshot().editorText).toEqual({ text: "draft", seq: 1 });

		windowCalls.open.length = 0;
		sock.receive(
			agentEvent({ type: "extension_ui_request", id: "o", method: "open_url", url: "https://ok.example/x" }),
		);
		expect(windowCalls.open).toEqual(["https://ok.example/x"]);
		expect(snapshot().openUrls).toHaveLength(1);

		// Non-http(s) agent URLs never drive window.open — only the inert card.
		windowCalls.open.length = 0;
		sock.receive(
			agentEvent({ type: "extension_ui_request", id: "o2", method: "open_url", url: "javascript:alert(1)" }),
		);
		expect(windowCalls.open).toEqual([]);
		expect(snapshot().openUrls).toHaveLength(2);
		store.dismissOpenUrl((snapshot().openUrls[0] as { id: number }).id);
		expect(snapshot().openUrls).toHaveLength(1);
	});
});

describe("rpc responses and misc frames", () => {
	test("get_state replaces the agent state; failed responses become warnings", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive({
			type: "event",
			frame: { type: "response", command: "get_state", success: true, data: { isStreaming: false } },
		});
		expect((snapshot().state as { isStreaming: boolean }).isStreaming).toBe(false);

		sock.receive({
			type: "event",
			frame: { type: "response", command: "set_fast_mode", success: false, error: "unsupported" },
		});
		expect(snapshot().notices.at(-1)?.message).toContain("set_fast_mode: unsupported");
	});

	test("export_html records the path; turn frames toggle streaming", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		sock.receive(
			agentEvent({ type: "response", command: "export_html", success: true, data: { path: "/tmp/x.html" } }),
		);
		expect(snapshot().exportPath).toBe("/tmp/x.html");

		sock.receive(agentEvent({ type: "agent_start" }));
		expect(snapshot().state?.isStreaming).toBe(true);
		sock.receive(agentEvent({ type: "agent_end" }));
		expect(snapshot().state?.isStreaming).toBe(false);
	});

	test("command outputs cap at 30", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		for (let i = 0; i < 40; i++) {
			sock.receive(agentEvent({ type: "command_output", text: `o${i}` }));
		}
		expect(snapshot().commandOutputs.length).toBe(30);
		expect(snapshot().commandOutputs.at(-1)?.text).toBe("o39");
	});

	test("subagent frames upsert by id; snapshots replace the list", () => {
		const { sock, snapshot } = makeStore();
		sock.open();
		const base = { id: "sub1", agent: "explorer", status: "running", lastUpdate: 1 };
		sock.receive(agentEvent({ type: "subagent_progress", snapshot: base }));
		expect(snapshot().subagents).toHaveLength(1);
		sock.receive(agentEvent({ type: "subagent_progress", snapshot: { ...base, status: "completed" } }));
		expect(snapshot().subagents[0]?.status).toBe("completed");
		sock.receive(agentEvent({ type: "subagent_snapshot", subagents: [{ ...base, id: "sub2" }] }));
		expect(snapshot().subagents.map(s => s.id)).toEqual(["sub2"]);
	});
});

describe("store registry", () => {
	test("reference counting keeps one store per session and closes on last release", () => {
		sockets = [];
		const options = { socketUrl: (id: string) => `ws://test/${id}`, socketFactory };
		const a = acquireSessionStore("reg-test", options);
		const b = acquireSessionStore("reg-test", options);
		expect(a).toBe(b);
		releaseSessionStore("reg-test");
		// Still alive after one release.
		expect(a.getSnapshot().phase).toBeDefined();
		releaseSessionStore("reg-test");
		// Last release closes the socket and evicts; next acquire is a fresh store.
		const c = acquireSessionStore("reg-test", options);
		expect(c).not.toBe(a);
		releaseSessionStore("reg-test");
	});
});

function snapshot_of(store: SessionStore): SessionSnapshot {
	return store.getSnapshot();
}
