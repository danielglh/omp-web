import * as React from "react";

/** Collapsible pretty-printed JSON with a copy affordance. */
export function JsonViewer({ value, maxHeight = 260 }: { value: unknown; maxHeight?: number }) {
	const [copied, setCopied] = React.useState(false);
	const text = React.useMemo(() => {
		try {
			return typeof value === "string" ? value : JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}, [value]);

	if (text.length > 12_000) {
		return (
			<div className="font-mono text-[10.5px] text-fg-2">
				<span className="text-fg-3">(large result, </span>
				{text.length}
				<span className="text-fg-3"> chars)</span>
				<CopyInline text={text} copied={copied} setCopied={setCopied} />
			</div>
		);
	}

	return (
		<div className="relative">
			<pre
				className="overflow-auto rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-fg-1"
				style={{ maxHeight }}
			>
				{text}
			</pre>
			<CopyInline text={text} copied={copied} setCopied={setCopied} />
		</div>
	);
}

function CopyInline({
	text,
	copied,
	setCopied,
}: {
	text: string;
	copied: boolean;
	setCopied: (v: boolean) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => {
				void navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}}
			className="absolute right-1.5 top-1.5 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-2 hover:text-fg-0"
		>
			{copied ? "copied" : "copy"}
		</button>
	);
}
