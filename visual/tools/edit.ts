/**
 * How `edit` renders: title, prose stats, then pi's own diff.
 * Execution is 100% stock, which is why this lives in visual/.
 *
 * renderShell must be the literal "default": getRenderShell() resolves
 * `override.renderShell ?? builtIn.renderShell`, and edit's built-in is
 * "self" — a bare container with no success/error background.
 */

import { getLanguageFromPath, renderDiff } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { plural } from "../../util/format.ts";
import { shortenPath } from "../../util/paint.ts";
import { GAP, RULE, SignedGutterBody, baseTone, blankRow, isProse, reusableText } from "./gutter.ts";
import { bgSeqOf, evidenceFg, evidenceSeq, highlightField } from "./syntax.ts";
// ANSI-aware: wrapPlain splits an already-coloured string, so every
// continuation row lost its colour and fell back to bright white.
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";

export type EditState = { callText?: Text; titleLine?: string; statsLine?: string };
export const renderShell = "default" as const;

/**
 * Turn pi's `-12 content` / `+12 content` / ` 12 content` diff rows into a
 * ruled gutter: `-12 | content`, right-aligned to the widest number in this
 * diff so the bar forms a straight edge.
 *
 * Operates on the ALREADY-COLOURED string: each row is wrapped in a single
 * theme.fg(), so the SGR run sits at the head and the visible text follows.
 * The regex steps over that run rather than stripping it, which keeps the
 * added/removed colours intact.
 */
function gutter(rendered: string) {
	const rows = rendered.split("\n");
	// pi pads line numbers INTO the number field: parseDiffLine captures
	// `(\s*\d*)`, so a single-digit row arrives as "  7 content", not
	// " 7 content". Demanding a digit straight after the sign therefore
	// missed every narrow line number — which is why rows 7-9 fell out of
	// the gutter while 10 and 11 kept it.
	const ROW = /^((?:\x1b\[[0-9;]*m)*)([-+ ])(\s*)(\d+) /;
	let width = 0;
	for (const row of rows) {
		const m = ROW.exec(row);
		if (m) width = Math.max(width, m[4].length);
	}
	// Rows, not a joined string: the wrapping component needs to know how
	// wide each margin is so continuations can hang under the content
	// instead of running back under the numbers.
	// Every row keeps the gutter column, matched or not. Hunk headers and
	// elision markers do not carry a line number, but giving them a zero
	// margin dropped them out of the column entirely — which is why some
	// context rows rendered flush left with no rule while their neighbours
	// had one.
	const blank = " ".repeat(width);
	return rows.map((row) => {
		const m = ROW.exec(row);
		const leadWidth = 1 + width + 1 + RULE.length + GAP.length;
		// A numberless row (pi's elision marker) must land on the SAME content
		// column as the numbered ones. Two bugs compounded: this lead was
		// width+6 while leadWidth — the value the wrapper indents
		// continuations by — says width+7, because the sign column was
		// dropped; and the row still carried pi's OWN sign+number field, which
		// pushed it further right again. Measured before: numbered content at
		// column 9, the "..." at column 12 (width+1 too far right, so a
		// 4-digit-line-number file drifted by 5). Now: one more space to reach
		// width+7, and the row's own field stripped. The strip is anchored on
		// a following non-space, so a row that is only whitespace is untouched.
		if (!m) {
			return {
				lead: `${blank}   ${GAP}`,
				leadWidth,
				text: row.replace(/^((?:\x1b\[[0-9;]*m)*)[-+ ] *(?=\S)/, "$1"),
			};
		}
		// The colour run stays WITH the text, not moved into the lead:
		// wrapTextWithAnsi can only reapply a style it can see, so hoisting
		// it left every continuation row uncoloured.
		const sgr = m[1];
		const num = m[4].padStart(width);
		return {
			lead: `${sgr}${m[2]}${num} ${RULE}${GAP}`,
			leadWidth,
			text: `${sgr}${row.slice(m[0].length)}`,
		};
	});
}

/**
 * The FIELD diff — on when the theme sets `wdDiffAddBg` (and `wdDiffRemoveBg`):
 * each changed line syntax-highlighted in the field palette (per line — a diff
 * carries hunks, not the file, so a multi-line token may mis-colour a row; the
 * characters are untouched), an added row on the add tint and a removed row on
 * the remove tint, the sign in `toolDiffAdded`/`toolDiffRemoved`, context rows
 * in the evidence tier. Same row shape as gutter(renderDiff(…)) — lead, its
 * width, text — so SignedGutterBody wraps it the same way. Returns undefined
 * when the theme has no tint: pi's own diff (whole-row fg paint) stands, as
 * before.
 */
function fieldDiff(diff: string, filePath: string | undefined, theme: any) {
	const addBg = bgSeqOf(theme, "wdDiffAddBg");
	const delBg = bgSeqOf(theme, "wdDiffRemoveBg");
	if (!addBg || !delBg) return undefined;
	const lang = filePath ? getLanguageFromPath(filePath) : undefined;
	const hl = (content: string): string => {
		if (lang && !isProse(lang)) {
			try {
				const rows = highlightField(content, lang, theme);
				if (rows && rows.length === 1) return baseTone(rows[0], evidenceSeq(theme));
			} catch {}
		}
		return evidenceFg(theme, content);
	};
	const sign = (ch: string) => {
		try {
			return theme.fg(ch === "+" ? "toolDiffAdded" : "toolDiffRemoved", ch) as string;
		} catch {
			return ch;
		}
	};
	const lines = diff.split("\n");
	const ROW = /^([-+ ])(\s*)(\d+) (.*)$/;
	let width = 0;
	for (const l of lines) {
		const m = ROW.exec(l);
		if (m) width = Math.max(width, m[3].length);
	}
	const leadWidth = 1 + width + 1 + RULE.length + GAP.length;
	const blank = " ".repeat(width);
	const dimRule = (() => {
		try {
			return theme.fg("dim", RULE) as string;
		} catch {
			return RULE;
		}
	})();
	return lines.map((l) => {
		const m = ROW.exec(l);
		if (!m) return { lead: `${blank}   ${GAP}`, leadWidth, text: evidenceFg(theme, l.replace(/^[-+ ] *(?=\S)/, "")) };
		const [, ch, , num, content] = m;
		const bg = ch === "+" ? addBg : ch === "-" ? delBg : "";
		const numTxt = `${ch === " " ? " " : sign(ch)}${evidenceFg(theme, num.padStart(width))}`;
		const lead = `${bg}${numTxt} ${dimRule}${GAP}`;
		return { lead, leadWidth, text: `${bg}${hl(content)}`, tint: bg };
	});
}

/**
 * Pads a tinted diff row to the full width INSIDE its background, so an added
 * or removed line reads as a bar, not a ragged highlight; other rows untouched.
 */
class TintedRows {
	constructor(
		private inner: SignedGutterBody,
		private tints: string[],
	) {}
	render(width: number): string[] {
		const rows = this.inner.render(width);
		return rows.map((row) => {
			const tint = this.tints.find((t) => t && row.includes(t));
			if (!tint) return row;
			const w = visibleWidth(row);
			return `${row}${tint}${" ".repeat(Math.max(0, width - w))}\x1b[49m`;
		});
	}
	invalidate(): void {
		this.inner.invalidate();
	}
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

export function renderCall(args, theme, context) {
	const state = context.state as EditState;
	const rawPath = typeof args?.path === "string" ? args.path : "";
	const title =
		theme.fg("toolTitle", theme.bold("Edit")) +
		" " +
		(rawPath ? theme.fg("accent", shortenPath(rawPath, context?.cwd ?? process.cwd())) : theme.fg("toolOutput", "..."));
	const text = reusableText(context.lastComponent);
	state.callText = text;
	state.titleLine = title;
	text.setText(state.statsLine ? `${title}\n\n${state.statsLine}` : title);
	return text;
}

export function renderResult(result, options, theme, context) {
	const state = context.state as EditState;
	// Reused BY CAPABILITY, not by cast: the success path below returns a
	// Container into this same slot, and `(lastComponent as Text).setText`
	// then throws "setText is not a function" — a throw pi swallows into its
	// raw fallback row rather than reporting.
	const text = reusableText(context.lastComponent);

	if (context.isError) {
		state.statsLine = undefined;
		const errText =
			result.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n") || "Error";
		text.setText(theme.fg("error", errText));
		return text;
	}

	const diff = result.details?.diff;
	if (!diff) {
		text.setText(options.isPartial ? theme.fg("dim", "editing…") : "");
		return text;
	}

	const { added, removed } = diffStats(diff);
	// Uncoloured on purpose: the diff below already carries added/removed
	// colour, so tinting the summary too says the same thing twice and
	// makes the folded row shout.
	state.statsLine = theme.fg("dim", `Added ${plural(added, "line")}, removed ${plural(removed, "line")}`);

	// Re-render the call component: title + stats line above the diff.
	// Never call context.invalidate() from a render path — it loops the
	// row (invalidate → rerender → renderResult → invalidate → …), which
	// caused the typing lag and scroll duplication. The result update
	// itself already triggers this row's rerender.
	if (state.callText && state.titleLine) {
		state.callText.setText(`${state.titleLine}\n\n${state.statsLine}`);
	}

	const rawPath = typeof context.args?.path === "string" ? context.args.path : undefined;
	const wrap = (context.lastComponent instanceof Container ? context.lastComponent : null) ?? new Container();
	wrap.clear();
	wrap.addChild(blankRow() as never);
	const fieldRows = fieldDiff(diff, rawPath, theme);
	if (fieldRows) {
		const tints = [...new Set(fieldRows.map((r) => r.tint).filter(Boolean))] as string[];
		wrap.addChild(new TintedRows(new SignedGutterBody(fieldRows, wrapTextWithAnsi), tints) as never);
	} else {
		wrap.addChild(new SignedGutterBody(gutter(renderDiff(diff, { filePath: rawPath })), wrapTextWithAnsi) as never);
	}
	return wrap;
}
