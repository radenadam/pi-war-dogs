/**
 * Time awareness (2026-08-21, maintainer): pi's default system prompt carries
 * NO date or clock at all — grep core/system-prompt.js — so without this the
 * model is clockless for the whole session. Every tool result, receipt,
 * delivery, and user prompt ends with ONE fixed line:
 *
 *   [timestamp: 2026-08-21 14:32:07 +07:00]
 *
 * Local time with offset, completion time (what "now" is when the model
 * reads it). The `timestamp:` label matches the house bracket grammar
 * (`[run id: …]`, `[answer truncated: …]` — label, colon, value) and keeps a
 * log tail's own bare timestamp line from impersonating it. Uniform on
 * purpose: tools run constantly in agentic work, so stamping every result
 * gives the model a continuously updating clock as a side effect — a stamp
 * it cannot rely on being present is a stamp it will not reason with.
 * Self-teaching by design: no tool description mentions it (nine tools each
 * saying "results carry a timestamp" is the redundancy the register killed).
 *
 * pure util: no pi imports (the MCP facade uses this too).
 */

const p = (n: number) => String(n).padStart(2, "0");

/** `[timestamp: YYYY-MM-DD HH:MM:SS +HH:MM]`, local time. (Regexes below also accept the short-lived `[at …]` form, 2026-08-21 only.) */
export function stampLine(d: Date = new Date()): string {
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return `[timestamp: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(a / 60))}:${p(a % 60)}]`;
}

/** A trailing stamp line (for idempotent re-stamping and display stripping). */
export const TRAILING_STAMP_RE = /\n?\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]\s*$/;

/** A stamp line anywhere (display row test). */
export const STAMP_ROW_RE = /^\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]$/;

/** Append the stamp to a text, replacing an existing trailing one (idempotent). */
export function appendStamp(text: string, d?: Date): string {
	const base = text.replace(TRAILING_STAMP_RE, "").replace(/\s+$/, "");
	if (!base) return stampLine(d);
	// Tight under a bracket line (house grammar: metadata lines stack), a
	// blank line after anything else.
	return `${base}${/\]\s*$/.test(base) ? "\n" : "\n\n"}${stampLine(d)}`;
}

/**
 * Wrap a ToolDefinition's execute so every RESULT and every ERROR carries the
 * stamp. The stamp lands on the last text content block; a result with no
 * text block (a pure image read) is left alone. Applied to every tool
 * war-dogs registers (reg(), the subagent publishes, the MCP facade).
 */
export function withStamp<T extends { execute?: (...a: any[]) => any }>(def: T): T {
	const orig = def.execute;
	if (typeof orig !== "function") return def;
	def.execute = async function (this: unknown, ...a: any[]) {
		let result: any;
		try {
			result = await orig.apply(this, a);
		} catch (e: any) {
			if (e instanceof Error && typeof e.message === "string") e.message = appendStamp(e.message);
			throw e;
		}
		try {
			const blocks = result?.content;
			if (Array.isArray(blocks)) {
				for (let i = blocks.length - 1; i >= 0; i--) {
					const b = blocks[i];
					if (b && b.type === "text" && typeof b.text === "string") {
						b.text = appendStamp(b.text);
						break;
					}
				}
			}
		} catch {}
		return result;
	} as T["execute"];
	return def;
}
