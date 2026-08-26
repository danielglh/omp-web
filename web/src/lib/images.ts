/**
 * Image attachment helpers for the composer.
 *
 * omp's RPC accepts base64 images alongside prompts, but the transport caps a
 * frame at 1 MB (v2 chunks above that). Large pastes/screenshots are therefore
 * downscaled before sending: max edge 1600px, re-encoded as JPEG q0.85, which
 * lands typical screenshots well under the cap. GIFs/SVGs pass through as-is
 * (re-encoding would kill animation / vector fidelity).
 */

export interface ImageAttachment {
	id: string;
	/** File name (or "paste.png" for clipboard drops). */
	name: string;
	mimeType: string;
	/** Base64 payload without the data-url prefix (what omp expects). */
	data: string;
	/** For local preview chips. */
	dataUrl: string;
	/** Byte size of the decoded payload. */
	bytes: number;
}

const SMALL_ENOUGH = 400 * 1024;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

async function fileToAttachment(file: File): Promise<ImageAttachment | undefined> {
	if (!file.type.startsWith("image/")) return undefined;
	const raw = new Uint8Array(await file.arrayBuffer());
	const passthrough =
		file.type === "image/gif" ||
		file.type === "image/svg+xml" ||
		raw.byteLength <= SMALL_ENOUGH ||
		typeof createImageBitmap !== "function";
	if (passthrough) {
		const data = base64(raw);
		return {
			id: crypto.randomUUID(),
			name: file.name || "image",
			mimeType: file.type || "image/png",
			data,
			dataUrl: `data:${file.type};base64,${data}`,
			bytes: raw.byteLength,
		};
	}
	// Downscale + re-encode.
	const bitmap = await createImageBitmap(new Blob([raw], { type: file.type }));
	try {
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
		const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
		return {
			id: crypto.randomUUID(),
			name: file.name || "image",
			mimeType: "image/jpeg",
			data,
			dataUrl,
			bytes: Math.floor((data.length * 3) / 4),
		};
	} finally {
		bitmap.close();
	}
}

/** Convert picked/pasted files into sendable attachments (images only). */
export async function filesToAttachments(files: FileList | File[]): Promise<ImageAttachment[]> {
	const out: ImageAttachment[] = [];
	for (const file of Array.from(files)) {
		const attachment = await fileToAttachment(file).catch(() => undefined);
		if (attachment) out.push(attachment);
	}
	return out;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
