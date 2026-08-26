/**
 * Helpers to pull renderable parts out of wire messages.
 */
import type { WireAssistantMessage, WireMessage } from "@omp-web/shared";

export function userText(message: WireMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map(block => (block.type === "text" ? block.text : block.type === "image" ? "(image)" : ""))
		.join("\n");
}

export function toolResultText(message: WireMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.map(block => (block.type === "text" ? block.text : block.type === "image" ? "(image)" : ""))
		.join("\n");
}

export function assistantText(message: WireAssistantMessage): string {
	return message.content
		.map(block => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return "";
				case "toolCall":
					return "";
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join("\n");
}

/** Plain-text preview used in the session rail. */
export function messagePreview(message: WireMessage): string {
	switch (message.role) {
		case "user":
			return userText(message);
		case "assistant": {
			const text = assistantText(message);
			if (text) return text;
			const toolCalls = message.content.filter(b => b.type === "toolCall");
			if (toolCalls.length > 0) return `⚙ ${toolCalls.map(t => t.name).join(", ")}`;
			return "(assistant)";
		}
		case "toolResult":
			return toolResultText(message);
		default:
			return "";
	}
}
