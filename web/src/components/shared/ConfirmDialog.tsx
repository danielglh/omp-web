import { AlertTriangle } from "lucide-react";
import type * as React from "react";

interface ConfirmDialogProps {
	title: string;
	message: React.ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	title,
	message,
	confirmLabel = "confirm",
	cancelLabel = "cancel",
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onCancel}
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div
				className="w-full max-w-sm rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
				onClick={e => e.stopPropagation()}
			>
				<div className="flex items-center gap-2 border-b border-border px-4 py-3">
					<AlertTriangle className="h-4 w-4 text-sev-warning" />
					<span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-2">{title}</span>
				</div>
				<div className="px-4 py-3 font-mono text-[12px] leading-relaxed text-fg-1">{message}</div>
				<div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
					<button
						type="button"
						onClick={onCancel}
						className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-fg-1 hover:bg-surface-2"
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="rounded-md border border-sev-error bg-sev-error px-3 py-1.5 font-mono text-[11px] font-semibold text-on-accent hover:opacity-90"
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
