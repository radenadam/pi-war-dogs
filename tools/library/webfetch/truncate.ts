/**
 * Content truncation — the same rule coding-agent tools use: cap at 2000 lines
 * OR 50 KB, whichever comes first. The full content is saved to disk (by the
 * caller) and the returned text ends with a pointer to it, so an agent can read
 * the rest on demand without every fetch dumping a whole page into its context.
 *
 * Pure: computes the cut only. File I/O lives in the caller.
 */

export interface CutResult {
	truncated: boolean;
	kept: string;
	keptLines: number;
	keptBytes: number;
	totalLines: number;
	totalBytes: number;
	/**
	 * True when the LAST kept line was cut mid-line. It is counted in
	 * `keptLines` (it is on screen), but a reader resuming after it would skip
	 * its unread tail — so the caller must resume AT it, not after it. A 120 KB
	 * two-line document used to report keptLines=1 and "resume at line 2",
	 * silently dropping the last 10 KB of line 1.
	 */
	partial: boolean;
}

const LINE_LIMIT = 2000;
const BYTE_LIMIT = 50_000;

export function cut(content: string, lineLimit = LINE_LIMIT, byteLimit = BYTE_LIMIT): CutResult {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= lineLimit && totalBytes <= byteLimit) {
		return {
			truncated: false,
			kept: content,
			keptLines: totalLines,
			keptBytes: totalBytes,
			totalLines,
			totalBytes,
			partial: false,
		};
	}

	const out: string[] = [];
	let bytes = 0;
	let partial = false;
	for (let i = 0; i < lines.length && i < lineLimit; i++) {
		const lb = Buffer.byteLength(lines[i], "utf8") + 1; // +1 for the newline
		if (bytes + lb > byteLimit) {
			// A single line longer than the whole budget (minified JSON/JS, one huge
			// paragraph) must still be capped — slice it byte-safely, don't keep it
			// whole. What is kept of it is a PARTIAL line: say so, so the caller
			// points the reader back AT it instead of past it. (Only when nothing
			// else fit: an over-long line with whole lines before it is simply left
			// for the resume, which keeps the common case ending on a clean line.)
			if (out.length === 0) {
				const slice = byteSlice(lines[i], byteLimit);
				out.push(slice);
				bytes += Buffer.byteLength(slice, "utf8");
				partial = true;
			}
			break;
		}
		bytes += lb;
		out.push(lines[i]);
	}

	return {
		truncated: true,
		kept: out.join("\n"),
		keptLines: out.length,
		keptBytes: bytes,
		totalLines,
		totalBytes,
		partial,
	};
}

/** Slice a string to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
function byteSlice(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off over UTF-8 continuation bytes
	return buf.subarray(0, end).toString("utf8");
}
