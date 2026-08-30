/**
 * Pure image helpers for the attachments pipeline: magic-byte MIME sniffing,
 * the PATH DIALECT every scanner shares, and paste-payload path extraction.
 * No pi imports and no state, so every function is probe-able in isolation
 * (README → Debugging → jiti probe).
 *
 * The supported set is png/jpeg/webp/gif — what the model APIs accept. A
 * path with any other extension never matches, and bytes that fail the
 * sniff are rejected even when the extension lies.
 */

import path from "node:path";

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

/**
 * The path DIALECT. On Windows a drive letter (`C:\`, `C:/`) or a UNC prefix
 * (`\\server\share`) is absolute, `~\` is home as well as `~/`, and a
 * backslash is a path separator — never a shell escape. POSIX knows `/` and
 * `~/` only. Decided ONCE here and read by every scanner in the attachments
 * pipeline (the typed-text rewrite, the footer-definition parsers, the paste
 * tokenizer); each takes the dialect as a parameter defaulting to the
 * platform, so a probe can exercise both on one machine. Before this the
 * scanners were POSIX literals and on Windows pi's clipboard file
 * (`C:\Users\…\Temp\pi-clipboard-<uuid>.png`) stayed a raw path in the prompt
 * (demonstrated by probe and on screen, 2026-08-30).
 */
export const WINDOWS_PATHS = process.platform === "win32";

/** Regex SOURCE for the lead of an absolute or home path in the dialect. */
export function absPathLead(windows = WINDOWS_PATHS): string {
	return windows ? String.raw`(?:~[\\/]|/|[A-Za-z]:[\\/]|\\\\)` : String.raw`(?:~/|/)`;
}

/**
 * An absolute or home image path in TYPED text — pi's clipboard file after
 * the paste-image key, or a path typed or pasted bare. Global, for
 * `replace`/`matchAll`. The character class excludes whitespace and the
 * quote/bracket characters prose puts around a path.
 */
export function imagePathPattern(windows = WINDOWS_PATHS): RegExp {
	return new RegExp(`${absPathLead(windows)}[^\\s"()\\[\\]]*\\.(?:png|jpe?g|gif|webp)`, "gi");
}

/** A footnote definition line the pipeline itself wrote: `[^image N]: <path>`. */
export function defLinePattern(flags = "", windows = WINDOWS_PATHS): RegExp {
	return new RegExp(`^\\[\\^image (\\d+)\\]: (${absPathLead(windows)}.*)$`, flags);
}

/** Whether a cleaned path is absolute or home-relative in the dialect. */
export function isAbsoluteOrHome(value: string, windows = WINDOWS_PATHS): boolean {
	return new RegExp(`^${absPathLead(windows)}`).test(value);
}

/** `~/` (and `~\` on Windows) → `home`; anything else unchanged. Joined in the dialect, so a probe can run both. */
export function expandHomePath(p: string, home: string, windows = WINDOWS_PATHS): string {
	if (p.startsWith("~/") || (windows && p.startsWith("~\\")))
		return (windows ? path.win32 : path.posix).join(home, p.slice(2));
	return p;
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
 *
 * Under the Windows dialect a backslash is a separator and never an escape —
 * bare or inside double quotes (Windows Terminal drops `"C:\dir with
 * spaces\shot.png"`); the POSIX rules would have read `C:\Users` as `C:Users`.
 */
function shellWordAt(payload: string, from: number, windows: boolean): { value: string; end: number } {
	let i = from;
	let value = "";
	// Index of the partner quote, or -1 when there is none before the line ends.
	// Inside double quotes a backslash escapes the next character (POSIX only),
	// so `\"` is NOT the partner.
	const closes = (quote: string, at: number): number => {
		for (let j = at + 1; j < payload.length; j++) {
			const c = payload[j];
			if (c === "\n") return -1;
			if (!windows && quote === '"' && c === "\\") {
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
			if (windows) {
				value += payload.slice(i + 1, close);
			} else {
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
			}
			i = close + 1;
		} else if (ch === "\\" && !windows) {
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
 * Only absolute and ~/ paths (the dialect above) with an image extension
 * qualify — pasted PROSE that merely mentions a file keeps every byte it
 * arrived with, because a candidate that fails the caller's on-disk check is
 * left untouched.
 */
export function pastedImagePaths(payload: string, windows = WINDOWS_PATHS): PastedPath[] {
	const out: PastedPath[] = [];
	let i = 0;
	while (i < payload.length) {
		if (/\s/.test(payload[i] as string)) {
			i++;
			continue;
		}
		const start = i;
		const word = shellWordAt(payload, i, windows);
		i = word.end > start ? word.end : start + 1;
		let value = word.value;
		if (/^file:\/\//i.test(value)) {
			try {
				value = decodeURIComponent(value.replace(/^file:\/\/(?:localhost)?/i, ""));
			} catch {
				continue;
			}
			// `file:///C:/x.png` decodes to `/C:/x.png`; the drive is the root.
			if (windows) value = value.replace(/^\/(?=[A-Za-z]:)/, "");
		}
		if (!IMAGE_EXT_RE.test(value)) continue;
		if (!isAbsoluteOrHome(value, windows)) continue;
		out.push({ start, end: word.end, path: value });
	}
	return out;
}
