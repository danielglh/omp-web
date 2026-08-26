/**
 * RPC transport framing.
 *
 * The omp RPC protocol is newline-delimited JSON on stdin/stdout. Frames
 * larger than 1 MB (protocol v2, negotiated via `negotiate_protocol`) are
 * split into `rpc_chunk` frames that must be reassembled on read. We always
 * negotiate v2 so long payloads (e.g. `get_messages`) survive, and we keep a
 * decoder on the read side.
 */

export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Uint8Array[];
	receivedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChunkFrame(value: unknown): value is RpcChunkFrame {
	return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Uint8Array {
	if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
		throw new Error("invalid rpc chunk data");
	}
	return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * Reassembles protocol v2 chunk frames. Feed every parsed JSON line; the
 * decoder returns the logical frame once its chunks complete.
 */
export class RpcFrameDecoder {
	#pending?: PendingChunks;

	push(value: unknown): object | undefined {
		if (!isChunkFrame(value)) {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			if (!isRecord(value)) throw new Error("rpc frame must be an object");
			return value;
		}
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			index >= count ||
			byteLength < MAX_RPC_FRAME_BYTES ||
			byteLength > MAX_RPC_REASSEMBLED_BYTES
		) {
			throw new Error("invalid rpc chunk metadata");
		}
		const bytes = decodeBase64(value.data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new Error("rpc chunk payload exceeds transport limit");

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new Error("rpc chunk sequence mismatch");
		}
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}

	/** True when a chunked frame is mid-flight (used for diagnostics). */
	get hasPending(): boolean {
		return this.#pending !== undefined;
	}
}
