/**
 * ANSI-aware string surgery.
 *
 * The pager composites lines that pi already styled — slicing, inverting
 * and re-padding them without destroying the escape sequences they
 * carry. Order matters in stripAnsi: APC (\x1b_ … BEL) must be handled
 * BEFORE the catch-all, because pi marks the hardware cursor that way
 * and the subagent renderer marks clickable run rows the same way; the
 * catch-all would eat only the escape and leave the payload as text.
 */

import { sliceByColumn, truncateToWidth as ansiTruncate, visibleWidth } from "@earendil-works/pi-tui";

export function stripAnsi(s: string): string {
	return (
		s
			// APC (\x1b_ … BEL) must come first: pi marks the hardware cursor
			// this way and the subagent tool marks clickable run rows the same
			// way. The trailing catch-all would otherwise eat only the escape
			// and leave the payload behind as visible text.
			.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-9;:<=>?]*[a-zA-Z~]/g, "")
			// Charset designators (ESC ( 0, ESC ) B, ESC * …, ESC + …) and the
			// ESC # / ESC % families carry a payload byte the catch-all left
			// behind as text ("\x1b(0lqk\x1b(B" → "0lqkB").
			.replace(/\x1b[()*+][\x20-\x2f]*[\x30-\x7e]/g, "")
			.replace(/\x1b[#%][\x30-\x7e]/g, "")
			.replace(/\x1b./g, "")
	);
}

/**
 * Run id carried by a zero-width APC run marker (`\x1b_sa:<id>\x07`, see
 * MARK in visual/tools/subagent.ts), or undefined. The pager scans rendered
 * rows with this to turn run-tree rows into click regions.
 */
export function runMarkId(line: string): string | undefined {
	const m = /\x1b_sa:([^\x07\x1b]+)\x07/.exec(line);
	return m ? m[1] : undefined;
}

/**
 * Plain, single-width-safe text: no escapes, no control characters, tabs
 * expanded. THREE spaces per tab, because that is what everything else
 * measuring or painting this text uses — pi's `replaceTabs`
 * (core/tools/render-utils.js) and pi-tui's `normalizeTerminalOutput` /
 * `visibleWidth`. At four, a tab-indented snippet sat one column further
 * in per tab than the same line rendered anywhere else on the surface.
 */
export function sanitize(s: string): string {
	return stripAnsi(s)
		.replace(/\t/g, "   ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/**
 * Remove background-colour SGR params from a line, keeping every other
 * style (fg colours, bold, italic, inverse). This is how the pager kills
 * the tool-card tint theme-independently: pi's ToolExecutionComponent
 * paints its box from theme bg tokens, and stripping 48;5/48;2/40-47/
 * 100-107/49 at the flatten leaves syntax and diff colours intact while
 * the field goes quiet (state lives in the beat glyph instead).
 */
/**
 * Remove EXACT background sequences (pi's tool-card tint: the theme's
 * toolPendingBg / toolSuccessBg / toolErrorBg as `theme.bg` emits them),
 * leaving every other background — a diff tint, a code pill — in place.
 * A `\x1b[49m` left behind with no bg open is a no-op. Where stripBg
 * (below) removed every bg, this removes only the ones named.
 */
export function stripBgSeqs(s: string, seqs: readonly string[]): string {
	let out = s;
	for (const seq of seqs) if (seq) out = out.split(seq).join("");
	return out;
}

export function stripBg(s: string): string {
	return s.replace(/\x1b\[([0-9;]+)m/g, (whole, params: string) => {
		const parts = params.split(";");
		const kept: string[] = [];
		for (let i = 0; i < parts.length; i++) {
			const v = Number(parts[i] || "0");
			// fg (38) / underline-colour (58) extended sequences: KEEP, and
			// step over their payload so `38;2;100;200;100` is never misread
			// as bg codes 100-107 (the probe caught exactly that).
			if ((v === 38 || v === 58) && (parts[i + 1] === "2" || parts[i + 1] === "5")) {
				const n = parts[i + 1] === "2" ? 4 : 2;
				for (let k = 0; k <= n && i + k < parts.length; k++) kept.push(parts[i + k]);
				i += n;
				continue;
			}
			if (v === 48 && parts[i + 1] === "5") {
				i += 2;
				continue;
			}
			if (v === 48 && parts[i + 1] === "2") {
				i += 4;
				continue;
			}
			if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107) || v === 49) continue;
			kept.push(parts[i]);
		}
		if (kept.length === parts.length) return whole;
		return kept.length ? `\x1b[${kept.join(";")}m` : "";
	});
}

export function invert(s: string): string {
	return `\x1b[7m${s.split("\x1b[0m").join("\x1b[0m\x1b[7m")}\x1b[27m`;
}

export function underline(s: string): string {
	return `\x1b[4m${s.split("\x1b[0m").join("\x1b[0m\x1b[4m")}\x1b[24m`;
}

export function leadingBg(line: string): string {
	const r = scanLeadingBg(line);
	// Reached end without a visible char: a pure padding row (all spaces)
	// whose trailing 49m closed the bg — the row still paints it.
	if (r.ended) return r.bg || r.firstBg;
	// Real bg boxes lead with bg-painted padding SPACES; pixel art
	// (half-block glyphs right after their bg code) must NOT full-bleed —
	// that painted the banner rows solid blue.
	return r.spaceWithBg ? r.bg : "";
}

/**
 * The background IN EFFECT at a row's first visible character, spaces or no
 * spaces — for rows that own their colour from their first glyph (edit's
 * tinted diff line opens with its tint and then the sign). leadingBg's
 * pixel-art rule returns "" for exactly that shape, on purpose.
 */
export function openingBg(line: string): string {
	const r = scanLeadingBg(line);
	return r.ended ? "" : r.bg;
}

function scanLeadingBg(line: string): { bg: string; firstBg: string; spaceWithBg: boolean; ended: boolean } {
	let i = 0;
	let bg = "";
	let firstBg = "";
	let spaceWithBg = false;
	// Scan past leading spaces and ANY escape sequences (CSI colors, but
	// also OSC marks like the 133;A/B/C shell-integration wrappers pi
	// puts on box padding rows) until the first visible non-space char.
	while (i < line.length) {
		const ch = line[i];
		if (ch === " ") {
			if (bg || firstBg) spaceWithBg = true;
			i++;
			continue;
		}
		if (ch !== "\x1b") break;
		const rest = line.slice(i);
		const sgr = /^\x1b\[([0-9;]*)m/.exec(rest);
		if (sgr) {
			const p = sgr[1].split(";");
			for (let k = 0; k < p.length; k++) {
				const v = Number(p[k] || "0");
				if ((v === 38 || v === 58) && p[k + 1] === "2") k += 4;
				else if ((v === 38 || v === 58) && p[k + 1] === "5") k += 2;
				else if (v === 48 && p[k + 1] === "2") {
					bg = `\x1b[48;2;${p[k + 2]};${p[k + 3]};${p[k + 4]}m`;
					if (!firstBg) firstBg = bg;
					k += 4;
				} else if (v === 48 && p[k + 1] === "5") {
					bg = `\x1b[48;5;${p[k + 2]}m`;
					if (!firstBg) firstBg = bg;
					k += 2;
				} else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) {
					bg = `\x1b[${v}m`;
					if (!firstBg) firstBg = bg;
				} else if (v === 49 || v === 0) bg = "";
			}
			i += sgr[0].length;
			continue;
		}
		const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
		if (osc) {
			i += osc[0].length;
			continue;
		}
		const other = /^\x1b(?:\[[0-9;:<=>?]*[a-zA-Z~]|.)/.exec(rest);
		i += other ? other[0].length : 1;
	}
	return { bg, firstBg, spaceWithBg, ended: i >= line.length };
}

export function wrapPlain(s: string, maxw: number): string[] {
	if (maxw < 4) return [ansiTruncate(s, Math.max(1, maxw))];
	if (visibleWidth(s) <= maxw) return [s];
	const out: string[] = [];
	let line = "";
	let lineW = 0;
	for (const word of s.split(" ")) {
		const wordW = visibleWidth(word);
		const sepW = line ? 1 : 0;
		if (lineW + sepW + wordW <= maxw) {
			line += (line ? " " : "") + word;
			lineW += sepW + wordW;
			continue;
		}
		if (line) out.push(line);
		if (wordW <= maxw) {
			line = word;
			lineW = wordW;
		} else {
			// HARD-BREAK a word wider than the column. This must be LOSSLESS:
			// ansiTruncate is a display truncator, not a splitter — it appends
			// its default "..." ellipsis and a reset sequence, so the emitted
			// head carried junk AND `head.length` counted 11 characters that
			// were never shown, advancing `rest` past them. Measured: 30
			// characters in, 14 out, with a mid-word "..." printed where
			// nothing had been elided (a 65-char URL lost 22 characters).
			// sliceByColumn returns a TRUE PREFIX for the plain text every
			// caller passes (all of them sanitize first), so the remainder is
			// exactly `rest.slice(head.length)` — verified lossless across
			// ASCII, CJK and emoji. `strict` keeps a wide grapheme from
			// overflowing the column instead of straddling it.
			let rest = word;
			while (visibleWidth(rest) > maxw) {
				const head = sliceByColumn(rest, 0, maxw, true);
				// No progress possible (a single grapheme wider than the
				// column): emit the remainder whole rather than spin.
				if (!head.length) break;
				out.push(head);
				rest = rest.slice(head.length);
			}
			line = rest;
			lineW = visibleWidth(rest);
		}
	}
	if (line) out.push(line);
	return out.length ? out : [""];
}
