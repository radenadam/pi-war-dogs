/**
 * How `write` renders: title, prose stats, then the file body.
 *
 * The built-in puts BOTH the title and the whole file body inside
 * renderCall, and returns an empty result unless the write failed. That
 * shape cannot be folded the way read and edit are, because there is no
 * result block to collapse — so this splits it the way edit already is:
 *
 *   call   -> `write <path>` + `Wrote N lines`
 *   result -> the body, syntax-highlighted
 *
 * With that split the pager can hide the body on collapse and leave the
 * prose line, exactly like read and edit. Execution is 100% stock, which
 * is why this lives in visual/.
 */

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { evidenceFg, evidenceSeq, highlightField } from "./syntax.ts";
import { Container, Text } from "@earendil-works/pi-tui";
import { plural } from "../../util/format.ts";
import { shortenPath } from "../../util/paint.ts";
import { COLLAPSED_ROWS, GutterBody, baseTone, blankRow, isProse, moreRow, reusableText } from "./gutter.ts";
// ANSI-aware: wrapPlain splits an already-coloured string, so every
// continuation row lost its colour and fell back to bright white.
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type WriteState = { callText?: Text; titleLine?: string; statsLine?: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Trailing newline is an artefact of the file, not a line of content. */
function bodyLines(content: string): string[] {
	const lines = content.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function renderCall(args: any, theme: any, context: any) {
	const state = (context?.state ?? {}) as WriteState;
	const rawPath = str(args?.file_path ?? args?.path);
	const title =
		theme.fg("toolTitle", theme.bold("Write")) +
		" " +
		(rawPath ? theme.fg("accent", shortenPath(rawPath, context?.cwd ?? process.cwd())) : theme.fg("toolOutput", "..."));

	// Counted from the content actually being written, not from re-reading
	// the file afterwards — the point is to report what was sent.
	const content = str(args?.content);
	// Uncoloured, like edit's summary: the body below carries the colour.
	state.statsLine = content ? theme.fg("dim", `Wrote ${plural(bodyLines(content).length, "line")}`) : undefined;

	// The BODY lives here, not in renderResult. pi only invokes renderResult
	// once a tool has produced a result, so a body rendered there does not
	// exist while the arguments are still streaming — the row showed its
	// title and count and nothing else, and there was nothing to expand.
	// Stock write renders its content from the call for exactly this reason.
	const wrap = (context?.lastComponent instanceof Container ? context.lastComponent : null) ?? new Container();
	wrap.clear();
	const head = new Text(state.statsLine ? `${title}\n\n${state.statsLine}` : title, 0, 0);
	state.callText = head;
	state.titleLine = title;
	wrap.addChild(head);
	if (content) {
		const rows = bodyRows(content, args, theme);
		// COLLAPSED is a summary, not the file. pi caps its own collapsed
		// write at 10 lines (write.js:108) and nothing downstream caps it for
		// us — ToolExecutionComponent adds whatever a renderer returns — so
		// ignoring `expanded` put the whole file on screen for a FOLDED row
		// (a 40-line write filled the pane under `{"war-dogs":{"pager":false}}`,
		// and a 2000-line one cost 156ms of every render). The pager is
		// unaffected: it renders every tool with `expanded` flipped on.
		const shown = context?.expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
		wrap.addChild(blankRow() as never);
		wrap.addChild(gutter(shown, theme) as never);
		if (shown.length < rows.length) {
			wrap.addChild(new Text(moreRow(rows.length - shown.length, rows.length, theme), 0, 0));
		}
	}
	return wrap;
}

/** Those rows behind the shared ruled gutter. */
function gutter(rows: string[], theme: any) {
	return new GutterBody(
		rows.map((l, i) => ({ num: i + 1, text: l })),
		String(rows.length).length,
		(m) => theme.fg("toolOutput", m), // gutter matches edit's diff-context numbers (round 19)
		wrapTextWithAnsi,
	);
}

/** The file body, syntax-highlighted, one string per source line. */
function bodyRows(content: string, args: any, theme: any): string[] {
	const rawPath = str(args?.file_path ?? args?.path);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	let rows: string[];
	try {
		const hi = lang && !isProse(lang) ? highlightField(content, lang, theme) : undefined;
		if (hi) {
			// Base tone: highlighting leaves plain spans terminal-default
			// bright; they wear the evidence tier like everything else here.
			rows = hi.map((l: string) => baseTone(l, evidenceSeq(theme)));
		} else {
			rows = bodyLines(content).map((l) => evidenceFg(theme, l));
		}
	} catch {
		rows = bodyLines(content).map((l) => evidenceFg(theme, l));
	}
	return rows.slice(0, bodyLines(content).length);
}

export function renderResult(result: any, _options: any, theme: any, context: any) {
	// Reused BY CAPABILITY, not by cast. The renderer slot holds whatever
	// this tool's last render returned, and renderCall returns a Container —
	// `(lastComponent as Text).setText` then throws "setText is not a
	// function", which pi swallows into its raw fallback row.
	const text = reusableText(context?.lastComponent);
	if (!context?.isError) {
		text.setText("");
		return text;
	}
	const errText =
		(result?.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => String(c.text ?? ""))
			.join("\n") || "Error";
	text.setText(theme.fg("error", errText));
	return text;
}
