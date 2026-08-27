/**
 * Unit tests for the pure formatting/content helpers used across the UI.
 */
import { describe, expect, test } from "bun:test";
import type { WireMessage } from "@omp-web/shared";
import { assistantText, messagePreview, toolResultText, userText } from "../src/lib/content";
import {
	formatCost,
	formatDuration,
	formatRelativeTime,
	formatTime,
	formatTokens,
	shortId,
	truncate,
} from "../src/lib/format";

describe("formatRelativeTime", () => {
	test("buckets seconds, minutes, hours and days", () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 5_000)).toBe("5s ago");
		expect(formatRelativeTime(now - 120_000)).toBe("2m ago");
		expect(formatRelativeTime(now - 7_200_000)).toBe("2h ago");
		expect(formatRelativeTime(now - 172_800_000)).toBe("2d ago");
	});

	test("future timestamps use the 'ahead' suffix and invalid input renders a dash", () => {
		expect(formatRelativeTime(Date.now() + 60_000)).toBe("1m ahead");
		expect(formatRelativeTime(undefined)).toBe("—");
		expect(formatRelativeTime(Number.NaN)).toBe("—");
		expect(formatRelativeTime("not-a-date")).toBe("—");
	});
});

describe("formatTime / formatDuration / formatTokens / formatCost", () => {
	test("formatTime renders HH:MM:SS locally", () => {
		const date = new Date(2026, 0, 1, 9, 5, 3);
		expect(formatTime(date.getTime())).toBe("09:05:03");
		expect(formatTime(undefined)).toBe("");
	});

	test("formatDuration covers ms, seconds and minutes", () => {
		expect(formatDuration(400)).toBe("400ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(-1)).toBe("—");
		expect(formatDuration(Number.NaN)).toBe("—");
	});

	test("formatTokens buckets k/M", () => {
		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(4_200)).toBe("4.2k");
		expect(formatTokens(3_100_000)).toBe("3.10M");
		expect(formatTokens(null)).toBe("—");
	});

	test("formatCost picks precision by magnitude", () => {
		expect(formatCost({ total: 0.0042 })).toBe("$0.0042");
		expect(formatCost({ total: 1.5 })).toBe("$1.50");
		expect(formatCost({ total: 0 })).toBe("");
		expect(formatCost(undefined)).toBe("");
	});
});

describe("shortId / truncate", () => {
	test("shortId truncates long ids only", () => {
		expect(shortId("abcdefghij", 4)).toBe("abcd");
		expect(shortId("ab", 4)).toBe("ab");
	});

	test("truncate appends an ellipsis past the limit", () => {
		expect(truncate("abcdef", 4)).toBe("abcd…");
		expect(truncate("abc", 4)).toBe("abc");
	});
});

// ── content helpers ──────────────────────────────────────────────────────────

const assistantMessage: WireMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "secret plan" },
		{ type: "text", text: "visible answer" },
	],
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 1,
};

describe("content helpers", () => {
	test("userText joins text blocks and marks images", () => {
		const message = {
			role: "user",
			content: [
				{ type: "text", text: "look at" },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "this" },
			],
			timestamp: 1,
		} as unknown as WireMessage;
		expect(userText(message)).toBe("look at\n(image)\nthis");
		expect(userText({ ...message, content: "plain" } as WireMessage)).toBe("plain");
		expect(userText(assistantMessage)).toBe("");
	});

	test("toolResultText extracts result text", () => {
		const message = {
			role: "toolResult",
			toolCallId: "t",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 1,
		};
		expect(toolResultText(message as unknown as WireMessage)).toBe("file body");
	});

	test("assistantText drops thinking blocks", () => {
		expect(assistantText(assistantMessage)).toBe("visible answer");
	});

	test("messagePreview falls back to tool names then a placeholder", () => {
		expect(messagePreview(assistantMessage)).toBe("visible answer");
		const toolOnly = {
			...assistantMessage,
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }],
		} as unknown as WireMessage;
		expect(messagePreview(toolOnly)).toBe("⚙ bash");
		const empty = { ...assistantMessage, content: [] } as unknown as WireMessage;
		expect(messagePreview(empty)).toBe("(assistant)");
	});
});
