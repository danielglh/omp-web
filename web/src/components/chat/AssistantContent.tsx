import type { WireAssistantContent, WireAssistantMessage } from "@omp-web/shared";
import type * as React from "react";
import type { ToolExecution } from "../../api";
import { Markdown } from "../../lib/markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

interface AssistantContentProps {
	message: WireAssistantMessage;
	streaming?: boolean;
	executions?: Map<string, ToolExecution>;
}

export function AssistantContent({ message, streaming, executions }: AssistantContentProps) {
	const blocks = message.content;
	const output: React.ReactNode[] = [];

	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index] as WireAssistantContent;
		const key = `${block.type}-${index}`;
		switch (block.type) {
			case "thinking":
				output.push(<ThinkingBlock key={key} thinking={block.thinking} streaming={streaming} />);
				break;
			case "redactedThinking":
				output.push(
					<div key={key} className="font-mono text-[10.5px] text-fg-3 italic">
						(redacted thinking)
					</div>,
				);
				break;
			case "text":
				if (block.text.trim().length > 0) {
					output.push(<Markdown key={key} text={block.text} />);
				}
				break;
			case "toolCall":
				output.push(
					<ToolCallCard
						key={key}
						name={block.name}
						args={block.arguments}
						intent={block.intent}
						execution={executions?.get(block.id)}
					/>,
				);
				break;
			default:
				break;
		}
	}

	// Streaming with no visible content yet.
	if (output.length === 0 && streaming) {
		return (
			<div className="flex items-center gap-1.5 font-mono text-[11px] text-fg-3">
				<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cat-assistant" />
				working…
			</div>
		);
	}

	return <div className="space-y-1">{output}</div>;
}
