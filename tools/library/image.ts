/**
 * Pure image helpers for the attachments pipeline: magic-byte MIME sniffing
 * and paste-payload path extraction. No pi imports and no state, so both
 * functions are probe-able in isolation (README → Debugging → jiti probe).
 *
 * The supported set is png/jpeg/webp/gif — what the model APIs accept. A
 * path with any other extension never matches, and bytes that fail the
 * sniff are rejected even when the extension lies.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Extensions the path scanners accept; must agree with detectImageMimeType. */
export const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i;

/** Sniff an image MIME type from magic bytes; undefined for anything else. */
export function detectImageMimeType(bytes: Uint8Array): ImageMime | undefined {
	const at = (i: number) => bytes[i];
	if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
	if (
		bytes.length >= 12 &&
		at(0) === 0x52 &&
		at(1) === 0x49 &&
		at(2) === 0x46 &&
		at(3) === 0x46 && // RIFF
		at(8) === 0x57 &&
		at(9) === 0x45 &&
		at(10) === 0x42 &&
		at(11) === 0x50 // WEBP
	)
		return "image/webp";
	return undefined;
}

export interface PastedPath {
	/** Span of the ORIGINAL token in the payload, for splicing a replacement. */
	start: number;
	end: number;
	/** The cleaned filesystem path (quotes stripped, file:// decoded, "\ " unescaped). */
	path: string;
}

/**
 * One shell WORD starting at `from`: the concatenation of adjacent quoted,
 * escaped and bare segments, ending at the first unquoted whitespace.
 *
 * This is a small POSIX shell-word tokenizer rather than a regex alternation,
 * because the dialects that matter build ONE word out of SEVERAL segments.
 * gnome-terminal (the GTK file-drop path) quotes a dropped filename with
 * GLib's `g_shell_quote`, which renders an apostrophe as `'…it'\''s…'` —
 * three segments glued together. An alternation matched only the first of
 * them, so the path lost its tail, failed the extension test, and the image
 * silently did not attach. The same rule gives backslash escapes for free
 * (`\(`, `\[`, `\#`, `\'`, `\ ` — kitty/VTE), which were previously left in
 * the path.
 *
 * A quote that has no partner before the end of the line is treated as a
 * LITERAL character, so an unquoted `/home/adam/it's/shot.png` still parses
 * as one path (that case was itself a fixed bug — do not "simplify" it away).
 */
function shellWordAt(payload: string, from: number): { value: string; end: number } {
	let i = from;
	let value = "";
	// Index of the partner quote, or -1 when there is none before the line ends.
	// Inside double quotes a backslash escapes the next character, so `\"` is
	// NOT the partner.
	const closes = (quote: string, at: number): number => {
		for (let j = at + 1; j < payload.length; j++) {
			const c = payload[j];
			if (c === "\n") return -1;
			if (quote === '"' && c === "\\") {
				j++;
				continue;
			}
			if (c === quote) return j;
		}
		return -1;
	};
	while (i < payload.length && !/\s/.test(payload[i] as string)) {
		const ch = payload[i] as string;
		if (ch === "'") {
			const close = closes("'", i);
			if (close === -1) {
				value += ch;
				i++;
				continue;
			}
			value += payload.slice(i + 1, close);
			i = close + 1;
		} else if (ch === '"') {
			const close = closes('"', i);
			if (close === -1) {
				value += ch;
				i++;
				continue;
			}
			// Inside double quotes only \" \\ \$ \` are escapes; the rest is literal.
			let j = i + 1;
			while (j < close) {
				const c = payload[j] as string;
				if (c === "\\" && j + 1 < close && /["\\$`]/.test(payload[j + 1] as string)) {
					value += payload[j + 1];
					j += 2;
				} else {
					value += c;
					j++;
				}
			}
			i = close + 1;
		} else if (ch === "\\") {
			const next = payload[i + 1];
			if (next === undefined) {
				value += ch;
				i++;
			} else if (next === "\n") {
				i += 2; // line continuation
			} else {
				value += next;
				i += 2;
			}
		} else {
			value += ch;
			i++;
		}
	}
	return { value, end: i };
}

/**
 * Candidate image paths in a drag/drop or clipboard paste payload.
 *
 * File managers and terminals deliver paths in several dresses: bare,
 * 'single'- or "double"-quoted (paths with spaces), backslash-escaped
 * specials, shell-quoted words built from several segments, file:// URIs
 * (percent-encoded), and several paths separated by whitespace or newlines.
 * Only absolute and ~/ paths with an image extension qualify — pasted PROSE
 * that merely mentions a file keeps every byte it arrived with, because a
 * candidate that fails the caller's on-disk check is left untouched.
 */
export function pastedImagePaths(payload: string): PastedPath[] {
	const out: PastedPath[] = [];
	let i = 0;
	while (i < payload.length) {
		if (/\s/.test(payload[i] as string)) {
			i++;
			continue;
		}
		const start = i;
		const word = shellWordAt(payload, i);
		i = word.end > start ? word.end : start + 1;
		let value = word.value;
		if (/^file:\/\//i.test(value)) {
			try {
				value = decodeURIComponent(value.replace(/^file:\/\/(?:localhost)?/i, ""));
			} catch {
				continue;
			}
		}
		if (!IMAGE_EXT_RE.test(value)) continue;
		if (!value.startsWith("/") && !value.startsWith("~/")) continue;
		out.push({ start, end: word.end, path: value });
	}
	return out;
}
