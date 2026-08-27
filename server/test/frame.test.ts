/**
 * Unit tests for the RPC frame decoder's error handling: malformed chunk
 * metadata, broken base64, interrupted sequences — the validation layer that
 * keeps untrusted agent output from blowing up the bridge.
 *
 * Note on scale: the protocol only chunks frames ABOVE 1 MB, so valid chunk
 * metadata always declares a byteLength ≥ MAX_RPC_FRAME_BYTES.
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	RPC_CHUNK_PAYLOAD_BYTES,
	RpcFrameDecoder,
} from "../src/rpc/frame";

function chunk(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "rpc_chunk",
		chunkId: "c1",
		index: 0,
		count: 2,
		byteLength: MAX_RPC_FRAME_BYTES + 1,
		data: Buffer.from("{}", "utf8").toString("base64"),
		...overrides,
	};
}

function bigPayload(): Buffer {
	// Exactly 4 × 256 KB bytes: every quarter-chunk fits the transport limit
	// while the declared byteLength still clears the 1 MB floor.
	const head = Buffer.from('{"type":"response","ok":true,"blob":"', "utf8");
	const tail = Buffer.from('"}', "utf8");
	return Buffer.concat([
		head,
		Buffer.alloc(4 * RPC_CHUNK_PAYLOAD_BYTES - head.byteLength - tail.byteLength, 97),
		tail,
	]);
}

describe("RpcFrameDecoder", () => {
	test("passes plain frames straight through", () => {
		const decoder = new RpcFrameDecoder();
		const frame = { type: "ready", protocolVersion: 1 };
		expect(decoder.push(frame)).toBe(frame);
	});

	test("reassembles a valid chunk sequence", () => {
		const decoder = new RpcFrameDecoder();
		const payload = bigPayload();
		const quarter = Math.ceil(payload.byteLength / 4);
		const shared = { chunkId: "c1", count: 4, byteLength: payload.byteLength };
		for (let index = 0; index < 3; index++) {
			const data = payload.subarray(index * quarter, (index + 1) * quarter).toString("base64");
			expect(decoder.push(chunk({ ...shared, index, data }))).toBeUndefined();
			expect(decoder.hasPending).toBe(true);
		}
		const data = payload.subarray(3 * quarter).toString("base64");
		const assembled = decoder.push(chunk({ ...shared, index: 3, data }));
		expect(assembled).toEqual(JSON.parse(payload.toString("utf8")));
		expect(decoder.hasPending).toBe(false);
	});

	test("rejects invalid chunk metadata", () => {
		const decoder = new RpcFrameDecoder();
		for (const bad of [
			chunk({ count: 1 }), // a single-chunk message is never chunked
			chunk({ index: 2, count: 2 }), // index out of range
			chunk({ index: -1, count: 2 }),
			chunk({ byteLength: 10 }), // below the 1 MB transport floor
			chunk({ byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 }), // above the reassembly ceiling
			chunk({ byteLength: 1.5 }), // non-integer
			chunk({ chunkId: "" }),
			chunk({ chunkId: "x".repeat(129) }),
		]) {
			expect(() => decoder.push(bad)).toThrow("invalid rpc chunk metadata");
		}
	});

	test("rejects bad base64 payloads", () => {
		const decoder = new RpcFrameDecoder();
		expect(() => decoder.push(chunk({ data: "!!!not-base64!!!" }))).toThrow("invalid rpc chunk data");
	});

	test("rejects oversized single chunks", () => {
		const decoder = new RpcFrameDecoder();
		const big = Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES + 1, 65).toString("base64");
		expect(() => decoder.push(chunk({ data: big }))).toThrow("rpc chunk payload exceeds transport limit");
	});

	test("rejects sequences whose received bytes exceed the declared length", () => {
		const decoder = new RpcFrameDecoder();
		const declared = MAX_RPC_FRAME_BYTES; // the metadata floor; 4 full chunks fit exactly
		const fullChunk = Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES, 97).toString("base64");
		for (let index = 0; index < 4; index++) {
			expect(
				decoder.push(chunk({ chunkId: "c", count: 6, byteLength: declared, index, data: fullChunk })),
			).toBeUndefined();
		}
		expect(() =>
			decoder.push(chunk({ chunkId: "c", count: 6, byteLength: declared, index: 4, data: "ZQ==" })),
		).toThrow("rpc chunk sequence exceeds declared length");
	});

	test("declared length must match the reassembled bytes exactly", () => {
		const decoder = new RpcFrameDecoder();
		const declared = MAX_RPC_FRAME_BYTES + 4;
		const part = Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES, 97).toString("base64");
		decoder.push(chunk({ chunkId: "c", count: 2, byteLength: declared, index: 0, data: part }));
		expect(() => decoder.push(chunk({ chunkId: "c", count: 2, byteLength: declared, index: 1, data: part }))).toThrow(
			"rpc chunk sequence length mismatch",
		); // 2×262 144 ≠ declared
	});

	test("an interleaved plain frame aborts a pending chunk sequence", () => {
		const decoder = new RpcFrameDecoder();
		decoder.push(chunk({ index: 0 }));
		expect(() => decoder.push({ type: "notice" })).toThrow("rpc chunk sequence interrupted");
	});

	test("sequence mismatch on id or order aborts", () => {
		const decoder = new RpcFrameDecoder();
		decoder.push(chunk({ chunkId: "c1", index: 0 }));
		expect(() => decoder.push(chunk({ chunkId: "c2", index: 1 }))).toThrow("rpc chunk sequence mismatch");
		expect(() => decoder.push(chunk({ chunkId: "c1", index: 0 }))).toThrow("rpc chunk sequence mismatch");
	});
});
