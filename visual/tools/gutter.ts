/**
 * The line-number gutter shared by read, write and edit — plus the small
 * pieces every tool renderer needs to agree on: how a collapsed body ends
 * and how a renderer reuses the slot pi hands it.
 *
 * A solid rule rather than a pipe, and a tab's worth of space after it, so
 * the numbers read as a margin instead of as part of the content.
 *
 *    1 ┃    first line
 *   12 ┃    second line
 *
 * Numbers are right-aligned to the widest they will reach, which is what
 * keeps the rule a straight edge. In the pager the evidence marker `⎿` is
 * followed by two spaces before this BLOCK's left edge; a short number then
 * sits further right by its own alignment padding — that is the block's
 * geometry, not a spacing defect (a left-aligned column was tried for a
 * fixed first-digit column and retracted: ragged numbers read worse).
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Body rows a COLLAPSED tool shows before it says "… N more".
 *
 * Ten, because that is pi's own cap (`write.js:108`) and because nothing
 * downstream imposes one: `ToolExecutionComponent.updateDisplay` adds
 * whatever a renderer hands it, so a renderer that ignores `expanded` IS
 * the height of the screen.
 */
export const COLLAPSED_ROWS = 10;

/**
 * pi's wording for the rows a collapsed body is not showing
 * (`write.js:112-114`), kept in one place so the tools cannot drift apart.
 */
export function moreRow(remaining: number, total: number, theme: any): string {
	let hint: string;
	try {
		hint = keyHint("app.tools.expand", "to expand");
	} catch {
		// The keybindings registry belongs to pi's TUI; outside it (a probe,
		// another mode) the hint is not worth throwing a render for.
		hint = theme.fg("muted", "to expand");
	}
	return `${theme.fg("muted", `... (${remaining} more lines, ${total} total,`)} ${hint}${theme.fg("muted", ")")}`;
}

/**
 * The renderer slot (`context.lastComponent`) as a `Text`, or a fresh one.
 *
 * pi hands back whatever this tool's LAST render returned, and these
 * renderers do not always return the same shape — write's call and edit's
 * success path both return a `Container`. Casting the slot to `Text` and
 * calling `setText` on it therefore threw "setText is not a function" on
 * the very next render, which pi swallows into its raw fallback row (a
 * silent degrade, the class dev/internals/README.md's Debugging section warns about).
 * Reuse is a capability question, so ask the object.
 */
export function reusableText(lastComponent: unknown): Text {
	return lastComponent && typeof (lastComponent as Text).setText === "function"
		? (lastComponent as Text)
		: new Text("", 0, 0);
}

/** Vertical rule drawn between the number and the content. */
export const RULE = "┃";

/** One tab's worth of space between the rule and the content. */
export const GAP = "    ";

/** `  7 ┃    ` — the full margin for a line: right-aligned number, rule, gap. */
export function margin(n: number, width: number): string {
	return `${String(n).padStart(width)} ${RULE}${GAP}`;
}
/** Columns a margin of the given number width occupies. */
export function marginWidth(width: number): number {
	return width + 1 + RULE.length + GAP.length;
}

/**
 * The narrowest content column worth keeping a margin for. Below it the
 * margin is dropped instead of overflowing: the row is what the reader
 * came for, and the numbers are what stock pi does not draw at all.
 */
const MIN_CONTENT = 8;

/**
 * A source line as it should be DISPLAYED.
 *
 * pi normalises before it renders — `normalizeDisplayText` (pi's
 * core/tools/render-utils.js) strips `\r`, so a CRLF file is drawn as the
 * lines it has. war-dogs splits on `\n` and wrapped the rows raw, so every
 * line still carried its `\r`: `wrapTextWithAnsi("alpha\r", 40)` returns
 * `["alpha", ""]` and the empty part came out as a continuation row — a
 * blank line between every line of a CRLF file, in read AND write.
 * Normalising here covers read, write and edit at once, and keeps `.text`
 * (the pager's copy source) clean.
 */
function displayText(s: string): string {
	return s.replace(/\r/g, "");
}

/**
 * A gutter'd body that wraps with a HANGING INDENT.
 *
 * A plain Text wraps at the component width with no knowledge of the
 * margin, so every continuation row started back at column zero and ran
 * underneath the numbers — the rule stopped being a straight edge exactly
 * on the long lines where it matters most. This wraps each source line to
 * the width remaining after the margin and indents the continuations to
 * sit under the content, so the rule is unbroken at any width.
 */
export class GutterBody {
	private cachedWidth = -1;
	private cached: string[] = [];
	private rows: { num: number; text: string }[];
	/**
	 * Digits in the widest line number actually present. Derived, not
	 * trusted: the caller's number is a floor, and a margin narrower than
	 * its own numbers pushes every row past the width it was given.
	 */
	private numWidth: number;

	/**
	 * Clean source, no gutter and no wrapping. The pager harvests `.text`
	 * from a component to build its copy blocks, so without this a copied
	 * selection carried the line numbers and the hanging indent.
	 */
	readonly text: string;

	constructor(
		rows: { num: number; text: string }[],
		numWidth: number,
		private paint: (s: string) => string,
		private wrap: (s: string, w: number) => string[],
	) {
		this.rows = rows.map((r) => ({ num: r.num, text: displayText(r.text) }));
		this.numWidth = this.rows.reduce((w, r) => Math.max(w, String(r.num).length), numWidth);
		this.text = this.rows.map((r) => r.text).join("\n");
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) return this.cached;
		const indent = " ".repeat(marginWidth(this.numWidth));
		const avail = width - indent.length;
		const out: string[] = [];
		if (avail < MIN_CONTENT) {
			// The margin no longer fits beside readable content, and an
			// over-wide row is not a choice the renderer gets to make — pi-tui
			// slices overlay lines at the pane edge, silently eating real
			// characters (and the pager's scrollbar column). Drop the gutter
			// and wrap to the full width, which is exactly what stock read
			// shows at any width.
			for (const r of this.rows) out.push(...this.wrap(r.text, Math.max(1, width)));
		} else {
			for (const r of this.rows) {
				const parts = this.wrap(r.text, avail);
				out.push(this.paint(margin(r.num, this.numWidth)) + (parts[0] ?? ""));
				for (let i = 1; i < parts.length; i++) out.push(indent + parts[i]);
			}
		}
		this.cachedWidth = width;
		this.cached = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cached = [];
	}
}

/** Same, for edit's diff rows, whose margin carries a +/-/space sign. */
export class SignedGutterBody {
	private cachedWidth = -1;
	private cached: string[] = [];
	private rows: { lead: string; leadWidth: number; text: string }[];

	/** Clean source for copy; see GutterBody.text. */
	readonly text: string;

	constructor(
		rows: { lead: string; leadWidth: number; text: string }[],
		private wrap: (s: string, w: number) => string[],
	) {
		this.rows = rows.map((r) => ({ ...r, text: displayText(r.text) }));
		this.text = this.rows.map((r) => r.text).join("\n");
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) return this.cached;
		const out: string[] = [];
		// pi marks changed diff tokens with inverse video. Wrapping splits
		// a row without closing it, so an inverse still open at the break
		// painted the rest of the row solid — the white bars.
		// Inverse OFF only. A full reset also cleared the tool box's
		// background, which is why the row went dark after the text.
		const close = "\x1b[27m";
		for (const r of this.rows) {
			const indent = " ".repeat(r.leadWidth);
			const avail = width - r.leadWidth;
			if (avail < MIN_CONTENT) {
				// Too narrow for the ruled margin. Unlike read's, this lead
				// carries meaning (the +/- sign and the line number), so it is
				// COMPACTED into the text — rule and gap dropped, one space —
				// and the whole row wrapped to the full width. Nothing is lost
				// and nothing overflows, which is the shape stock pi's diff has
				// at any width.
				const lead = r.lead.replace(`${RULE}${GAP}`, "").replace(/ +$/, "");
				const parts = this.wrap(lead ? `${lead} ${r.text}` : r.text, Math.max(1, width));
				for (const part of parts) out.push(part + close);
				continue;
			}
			const parts = this.wrap(r.text, avail);
			out.push(r.lead + (parts[0] ?? "") + close);
			for (let i = 1; i < parts.length; i++) out.push(indent + parts[i] + close);
		}
		this.cachedWidth = width;
		this.cached = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cached = [];
	}
}

/** One empty row. `new Text("", 0, 0)` renders NOTHING, not a blank line. */
export function blankRow(): { render: () => string[]; invalidate: () => void } {
	return { render: () => [""], invalidate() {} };
}

/**
 * Languages that are not code. highlight.js will happily colour a prose
 * .txt — quoting, numbers, stray keywords — which is what made a written
 * story render as a patchwork and a read of the same file "light up".
 */
/**
 * Give a highlighted row a BASE foreground. Syntax highlighting leaves
 * plain spans unpainted — terminal-default bright white — so evidence
 * bodies of highlighted files out-shone the prose (maintainer-reported).
 * Token colours survive; every unpainted or reset span returns to `seq`
 * instead of the terminal default.
 */
export function baseTone(row: string, seq: string): string {
	if (!seq) return row;
	let out = row.split("\u001b[0m").join(`\u001b[0m${seq}`);
	out = out.split("\u001b[39m").join(seq);
	return `${seq}${out}\u001b[39m`;
}

const PROSE = new Set(["", "text", "plaintext", "txt", "log", "csv", "tsv"]);

export function isProse(lang: string | undefined): boolean {
	return !lang || PROSE.has(String(lang).toLowerCase());
}
