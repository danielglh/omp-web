/**
 * OmpProcess — spawns `omp --mode rpc` and bridges the JSON-lines protocol.
 *
 * stdout is parsed line-by-line, reassembled through {@link RpcFrameDecoder},
 * and re-emitted as parsed frames. stderr is captured for diagnostics. The
 * process is considered ready once the `ready` frame arrives; commands sent
 * before that are queued. Closing stdin makes the agent dispose its session
 * and exit cleanly (SIGTERM is the fallback).
 */
import { MAX_RPC_FRAME_BYTES, RPC_CHUNK_PAYLOAD_BYTES, RpcFrameDecoder } from "./frame";

export interface OmpProcessOptions {
	bin: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	onFrame: (frame: unknown) => void;
	onStderr?: (chunk: string) => void;
	onExit: (info: { code: number | null; signal: string | null }) => void;
	/** Milliseconds to wait for the `ready` frame before reporting failure. */
	readyTimeoutMs?: number;
}

export interface OmpProcess {
	readonly pid: number | undefined;
	readonly ready: Promise<void>;
	send(command: object): void;
	/** Close stdin and wait for a clean exit; SIGTERM after `graceMs`. */
	close(graceMs?: number): Promise<void>;
	kill(signal?: NodeJS.Signals): void;
}

/** RPC commands the server forwards from the browser (whitelist). */
const FORWARDABLE_COMMANDS = new Set([
	"negotiate_protocol",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"get_state",
	"set_fast_mode",
	"get_available_commands",
	"set_todos",
	"set_host_tools",
	"set_host_uri_schemes",
	"set_subagent_subscription",
	"get_subagents",
	"get_subagent_messages",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_messages_page",
	"get_login_providers",
	"login",
]);

/** Side-channel frames that must overtake the serialized command queue. */
const FORWARDABLE_SIDE_FRAMES = new Set([
	"extension_ui_response",
	"host_tool_result",
	"host_tool_update",
	"host_uri_result",
]);

type SpawnedProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

/** Typed spawn wrapper so stdout/stderr are ReadableStreams, not fds. */
function spawnTyped(bin: string, args: string[], cwd: string, env: Record<string, string | undefined>): SpawnedProc {
	return Bun.spawn([bin, ...args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
}

const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;

export interface LineDecoder {
	/** Feed one raw read chunk (bytes or pre-decoded text). */
	push(chunk: string | Uint8Array): void;
}

/**
 * Newline-splitting decoder with stream-safe UTF-8 handling: a multi-byte
 * character split across two read chunks is kept pending instead of being
 * corrupted into U+FFFD (which a fresh TextDecoder per chunk would produce).
 */
export function createLineDecoder(onLine: (line: string) => void): LineDecoder {
	const byteDecoder = new TextDecoder();
	let buffer = "";
	return {
		push(chunk: string | Uint8Array) {
			buffer += typeof chunk === "string" ? chunk : byteDecoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line.length > 0) onLine(line);
				newlineIndex = buffer.indexOf("\n");
			}
		},
	};
}

export function isForwardableCommand(value: unknown): value is { type: string } {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && FORWARDABLE_COMMANDS.has(type);
}

export function isForwardableSideFrame(value: unknown): value is { type: string } {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && FORWARDABLE_SIDE_FRAMES.has(type);
}

export function isForwardableFrame(value: unknown): value is { type: string } {
	return isForwardableCommand(value) || isForwardableSideFrame(value);
}

export function spawnOmpProcess(options: OmpProcessOptions): OmpProcess {
	const { bin, args, cwd, env, onFrame, onStderr, onExit, readyTimeoutMs } = options;

	const readyResolvers: Array<() => void> = [];
	const readyRejecters: Array<(reason: Error) => void> = [];
	let readySettled = false;
	let disposed = false;

	const ready = new Promise<void>((resolve, reject) => {
		readyResolvers.push(resolve);
		readyRejecters.push(reject);
	});

	const settleReady = (error?: Error) => {
		if (readySettled) return;
		readySettled = true;
		if (error) {
			for (const reject of readyRejecters) reject(error);
		} else {
			for (const resolve of readyResolvers) resolve();
		}
	};

	let proc: SpawnedProc | undefined;
	try {
		proc = spawnTyped(bin, args, cwd, { ...process.env, ...env });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Surface the failure through `ready` instead of throwing: callers await
		// `ready`, and a synchronous throw would leave that rejected promise
		// unconsumed while their flow moves on.
		settleReady(new Error(`failed to spawn ${bin}: ${message}`));
		return {
			pid: undefined,
			ready,
			send() {},
			async close() {},
			kill() {},
		};
	}
	const decoder = new RpcFrameDecoder();
	let stderrBuffer = "";
	/** Transport protocol version in effect (2 = chunked framing for big frames). */
	let protocolVersion = 1;
	const negotiateId = `srv-negotiate-${Math.random().toString(36).slice(2)}`;

	const handleLine = (trimmed: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// A non-JSON stdout line (e.g. an ANSI notice) breaks the protocol
			// channel; surface it as an error frame instead of killing the bridge.
			onFrame({ type: "protocol_line", raw: trimmed });
			return;
		}
		try {
			const frame = decoder.push(parsed);
			if (frame) {
				onFrame(frame);
				if (isRecord(frame) && frame.type === "ready") {
					// Negotiate v2 right away so oversized frames (prompts with
					// images, large get_messages responses) survive the 1 MB cap.
					if (!readySettled) settleReady();
					writeCommand({ id: negotiateId, type: "negotiate_protocol", protocolVersion: 2 });
				}
				if (
					isRecord(frame) &&
					frame.type === "response" &&
					frame.command === "negotiate_protocol" &&
					frame.id === negotiateId &&
					frame.success === true
				) {
					protocolVersion = 2;
				}
			}
		} catch (error) {
			onFrame({
				type: "protocol_error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const stdoutLines = createLineDecoder(handleLine);

	const stderrLines = createLineDecoder(chunk => {
		stderrBuffer += `${chunk}\n`;
		onStderr?.(chunk);
		// Keep the buffer bounded (diagnostics only; omp logs to ~/.omp logs too).
		if (stderrBuffer.length > 512 * 1024) stderrBuffer = stderrBuffer.slice(-256 * 1024);
	});

	if (proc.stdout) {
		const reader = proc.stdout.getReader();
		const pump = () => {
			reader
				.read()
				.then(({ done, value }) => {
					if (done || !value) return;
					stdoutLines.push(value);
					pump();
				})
				.catch(() => {});
		};
		pump();
	}
	if (proc.stderr) {
		const reader = proc.stderr.getReader();
		const pump = () => {
			reader
				.read()
				.then(({ done, value }) => {
					if (done || !value) return;
					stderrLines.push(value);
					pump();
				})
				.catch(() => {});
		};
		pump();
	}

	const readyTimer = setTimeout(() => {
		if (!readySettled) {
			settleReady(
				new Error(`timed out waiting for omp RPC ready frame (${readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms)`),
			);
		}
	}, readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
	// Keep the process alive if the timer is the only outstanding handle.
	readyTimer.unref?.();

	proc.exited.then((code: number) => {
		clearTimeout(readyTimer);
		if (!readySettled) {
			settleReady(new Error(`omp exited before ready (code=${code})`));
		}
		onExit({ code, signal: proc.signalCode });
	});

	const stdinSink = proc.stdin;
	const writeStdin = (chunk: Uint8Array) => {
		try {
			stdinSink.write(chunk);
		} catch {
			// stdin already closed — the agent is exiting; drop the frame.
		}
	};
	const encoder = new TextEncoder();
	/** Write one logical command, chunking it per protocol v2 when oversized. */
	const writeCommand = (command: object) => {
		const bytes = encoder.encode(JSON.stringify(command));
		if (protocolVersion < 2 || bytes.byteLength <= MAX_RPC_FRAME_BYTES) {
			writeStdin(encoder.encode(`${JSON.stringify(command)}\n`));
			return;
		}
		const chunkId = `srv-${Math.random().toString(36).slice(2)}`;
		const count = Math.ceil(bytes.byteLength / RPC_CHUNK_PAYLOAD_BYTES);
		for (let index = 0; index < count; index++) {
			const frame = {
				type: "rpc_chunk",
				chunkId,
				index,
				count,
				byteLength: bytes.byteLength,
				data: Buffer.from(
					bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES),
				).toString("base64"),
			};
			writeStdin(encoder.encode(`${JSON.stringify(frame)}\n`));
		}
	};

	return {
		pid: proc.pid,
		ready,
		send(command: object) {
			if (disposed) return;
			writeCommand(command);
		},
		async close(graceMs = DEFAULT_CLOSE_GRACE_MS) {
			if (disposed) return;
			disposed = true;
			const exited = proc.exited.then(() => undefined).catch(() => undefined);
			try {
				stdinSink.end();
			} catch {
				// already closed
			}
			await Promise.race([
				exited,
				new Promise<void>(resolve => {
					const timer = setTimeout(() => resolve(), graceMs);
					timer.unref?.();
				}),
			]);
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill("SIGTERM");
				await Promise.race([
					exited,
					new Promise<void>(resolve => {
						const timer = setTimeout(() => resolve(), 2_000);
						timer.unref?.();
					}),
				]);
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}
		},
		kill(signal: NodeJS.Signals = "SIGTERM") {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Free helper: validate that a forwarded browser frame only carries whitelisted content. */
export function sanitizeForwardedFrame(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const { type, ...rest } = value;
	if (typeof type !== "string") return undefined;
	if (FORWARDABLE_COMMANDS.has(type)) {
		return { type, ...rest };
	}
	if (FORWARDABLE_SIDE_FRAMES.has(type)) {
		return { type, ...rest };
	}
	return undefined;
}
