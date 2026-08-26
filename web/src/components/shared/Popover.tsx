import * as React from "react";

interface PopoverProps {
	open: boolean;
	onClose: () => void;
	children: React.ReactNode;
	/** Panel edge relative to the anchor (which wraps it in `relative`). */
	align?: "left" | "right";
	/** Opens upward from the anchor (composer bars) or downward. */
	direction?: "up" | "down";
	className?: string;
}

/**
 * Minimal anchored dropdown: absolutely positioned panel inside a `relative`
 * parent, closed by outside-pointerdown or Escape. No portal — the parent
 * must not clip it (composer bars sit at the flex edge, so this is fine).
 */
export function Popover({ open, onClose, children, align = "left", direction = "up", className }: PopoverProps) {
	const panelRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		if (!open) return;
		// The panel's parent is its anchor wrapper (the `relative` div that also
		// holds the trigger), so clicks there are left to the trigger's own
		// toggle; everything else closes the popover.
		const onClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			// A detached target means the click already unmounted its own panel
			// (e.g. a menu row switching to a sibling popover) — not an outside click.
			if (!target?.isConnected) return;
			const anchor = panelRef.current?.parentElement;
			if (anchor?.contains(target)) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("click", onClick);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("click", onClick);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, onClose]);

	if (!open) return null;
	return (
		<div
			ref={panelRef}
			className={[
				"absolute z-40 rounded-lg border border-border-strong bg-surface-2 shadow-xl",
				direction === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
				align === "left" ? "left-0" : "right-0",
				className ?? "w-64",
			].join(" ")}
		>
			{children}
		</div>
	);
}

/** Row inside a {@link Popover} list. */
export function PopoverItem({
	active,
	onClick,
	children,
	title,
}: {
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={[
				"block w-full px-3 py-1.5 text-left font-mono text-[11px] hover:bg-surface-3",
				active ? "text-cat-conversation" : "text-fg-1",
			].join(" ")}
		>
			{children}
		</button>
	);
}
