/**
 * Formatting primitives. No pi imports, no theme, no state — these are
 * used by every layer, so they must stay dependency-free.
 */

/**
 * "42s" / "3m 7s".
 *
 * Non-finite input reads as 0, not as "NaNm NaNs": the durations this
 * formats come from PERSISTED session entries (loader.ts's `gen-time`),
 * which a foreign or corrupt file can carry in any shape, and pi has no
 * unregisterEntryRenderer — a bad number is drawn forever.
 */
export function fmtSecs(total: number): string {
	const s = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "970" / "1.2k" / "435k" / "1.1M" — the token scale used by both the
 *  main footer and the subagent run footer, so they always agree. */
export function fmtTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Line count ignoring trailing blanks. */
export function countLines(text: string): number {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed === "" ? 0 : trimmed.split("\n").length;
}

export function plural(n: number, word: string): string {
	if (n === 1) return `1 ${word}`;
	// reply → replies (2026-08-29: "held for 2 replys" on screen).
	const many = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
	return `${n} ${many}`;
}

/**
 * Source lines in a blob, ignoring a trailing newline.
 *
 * Commands and files almost always end with one, and `split("\n")` turns it
 * into an empty final element — so every "N lines" label built that way read
 * one too high.
 */
export function srcLines(text: string): number {
	const t = (text ?? "").replace(/\s+$/, "");
	return t === "" ? 0 : t.split("\n").length;
}
