/**
 * How `read` renders: pi's own output with a prose line count above it.
 * Delegates to the built-in renderer and only prepends the summary, so
 * highlighting and truncation stay stock.
 */

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { evidenceFg, evidenceSeq, highlightField } from "./syntax.ts";
import { Container, Text } from "@earendil-works/pi-tui";
import { countLines, plural } from "../../util/format.ts";
import { shortenPath } from "../../util/paint.ts";
import { STAMP_ROW_RE } from "../../util/stamp.ts";
import { GutterBody, baseTone, blankRow, isProse } from "./gutter.ts";
// ANSI-aware: wrapPlain splits an already-coloured string, so every
// continuation row lost its colour and fell back to bright white.
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * The slice being read, in the same terms pi states it (`read x:100-149`):
 * `offset` alone is an open-ended start, `limit` closes the range. Saying
 * only "from line 100" for a call that asked for 50 lines described a read
 * the model never made.
 */
function lineRange(args: any): string {
	const offset = Number(args?.offset);
	const limit = Number(args?.limit);
	const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
	const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
	if (start === 1 && count === undefined) return "";
	if (count === undefined) return ` (from line ${start})`;
	return ` (lines ${start}-${start + count - 1})`;
}

/**
 * Capitalised title, matching Edit/Write/Bash — pi's built-in call
 * renderer says "read". Path shortened like the others; the pager appends
 * the full path dimly when the shortening hides it.
 */
export function renderCall(args: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	const rawPath =
		typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
	const range = lineRange(args);
	text.setText(
		theme.fg("toolTitle", theme.bold("Read")) +
			" " +
			(rawPath
				? theme.fg("accent", shortenPath(rawPath, context?.cwd ?? process.cwd()))
				: theme.fg("toolOutput", "...")) +
			(range ? theme.fg("dim", range) : ""),
	);
	return text;
}

/**
 * pi's three continuation notices, verbatim from `core/tools/read.js`:
 * `[Showing lines A-B of T…]`, `[N more lines in file…]` and
 * `[Line N is X, exceeds Y limit…]`. They are the only bracketed rows pi
 * ever appends to a read result, so they are what "is this a notice?" must
 * ask about — see bodyEnd.
 */
const NOTICE =
	/^\[(?:Showing lines \d|\d+ more lines in file|Line \d+ is |Read \d+ lines|Read lines \d+-\d+ of \d+|(?:timestamp:|at) \d{4}-\d{2}-\d{2} )[^\n]*\]$/;

/**
 * Where the file's own content ends.
 *
 * The test is pi's WORDING, not a bracket. `/^\[.*\]$/` cannot tell a
 * notice from content, so it threw away the last line of any file ending
 * in `[…]` — a JSON array, a markdown link reference, a TOML table header
 * — and left it out of the count, which is what the pager's `read x (N
 * lines)` sentence is built from.
 *
 * `details.truncation` is the other available signal (it is set for both
 * truncated forms, and the `[N more lines in file…]` form cannot occur
 * without a `limit` argument) but it is NOT sufficient on its own:
 * `details` is not persisted. A toolResult entry in a session file carries
 * `role/toolCallId/toolName/content/isError` and nothing else (verified in
 * ~/.pi/agent/sessions), so every REPLAYED read — a resumed session, and
 * every subagent transcript the pager rebuilds through
 * `runview.ts:244 updateResult({content, details: m.details})` — arrives
 * with `details` undefined. Gating on it would number pi's own notice as a
 * line of the file on exactly those screens. The wording is available in
 * both cases, so the wording is the test.
 *
 * Trailing blanks are trimmed unconditionally; they are never content.
 */
function bodyEnd(rows: string[]): number {
	let end = rows.length;
	while (end > 0) {
		const line = rows[end - 1].trim();
		if (!line || NOTICE.test(line)) {
			end--;
			continue;
		}
		break;
	}
	return end;
}

/** Content lines only — pi's trailing continuation notice is not content. */
function bodyLineCount(text: string): number {
	return bodyEnd(text.split("\n"));
}

/**
 * The file body with a ruled gutter, matching edit and write.
 *
 * Numbered from `offset` so the gutter shows REAL file lines, not offsets
 * into this slice. pi appends its continuation notices ("[Showing lines
 * 1-50 of 900...]") into the result text itself, so those rows are
 * excluded from numbering — they are commentary, not content.
 *
 * Returns undefined when highlighting changes the row count, rather than
 * printing a gutter that has silently drifted out of alignment.
 */
function numbered(text: string, path: string | undefined, offset: number, theme: any) {
	const rows = text.split("\n");
	const end = bodyEnd(rows);
	if (end <= 0) return undefined;

	let body = rows.slice(0, end);
	// Our execute bakes cat -n prefixes into the RESULT (`%6d\t…`) for the
	// model; the panel draws its own gutter, so the prefixes come off here —
	// and the first prefix, not args.offset, names the true starting line
	// (2026-08-21). Only when EVERY body row carries one: a file whose text
	// happens to look numbered is content, not our prefix.
	const pref = /^ *(\d+)\t/;
	if (body.length && body.every((l) => pref.test(l))) {
		const m = pref.exec(body[0]);
		if (m) offset = Number(m[1]);
		body = body.map((l) => l.replace(pref, ""));
	}
	const lang = path ? getLanguageFromPath(path) : undefined;
	let highlighted = false;
	if (lang && !isProse(lang)) {
		try {
			// The FIELD palette (visual/tools/syntax.ts) — raw characters,
			// coloured in place; a `.md` shows its own `#`/`**`.
			const hi = highlightField(body.join("\n"), lang, theme);
			if (hi && hi.length === body.length) {
				// Base tone: highlighting leaves plain spans terminal-default
				// bright; they wear the evidence tier like everything else here.
				body = hi.map((l: string) => baseTone(l, evidenceSeq(theme)));
				highlighted = true;
			}
		} catch {}
	}
	// Tool output wears the evidence tier. Without this the rows carried NO
	// colour at all and fell back to the terminal default, i.e. bright white.
	if (!highlighted) body = body.map((l) => evidenceFg(theme, l));
	const width = String(offset + body.length - 1).length;
	// The trailing [timestamp: …] stamp is the model's clock, not a notice a
	// reader needs — the pretty view drops it (the pager's per-beat wire view
	// shows the verbatim result, stamp included). pi's real continuation
	// notices stay: they say the read was capped.
	const notes = rows
		.slice(end)
		.filter((r) => r.trim())
		.filter((r) => !STAMP_ROW_RE.test(r.trim()));
	return {
		body: new GutterBody(
			body.map((l, i) => ({ num: offset + i, text: l })),
			width,
			(m) => theme.fg("toolOutput", m), // gutter matches edit's diff-context numbers (round 19)
			wrapTextWithAnsi,
		),
		notes: notes.map((r) => theme.fg("muted", r)),
	};
}

export type ReadState = { statsInner?: unknown; statsWrapper?: Container };

/** Built-in renderResult, injected by tools/read.ts. */
let inner: ((...a: any[]) => any) | undefined;
export function setInnerRenderer(fn: (...a: any[]) => any) {
	inner = fn;
}

export function renderResult(result, options, theme, context) {
	const state = context.state as ReadState;
	state.statsWrapper ??= new Container();
	state.statsWrapper.clear();

	if (!context.isError && !options.isPartial) {
		const trunc = result.details?.truncation;
		const hasImage = (result.content ?? []).some((c) => c.type === "image");
		let label: string | undefined;
		if (hasImage) {
			// Images have no meaningful line count.
			label = "Read image";
		} else if (trunc?.truncated) {
			label = `Read ${trunc.outputLines} of ${plural(trunc.totalLines, "line")}`;
		} else {
			const text = (result.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			// Body lines only: counting pi's trailing "[Showing lines ...]"
			// notice made a 3-line read report "Read 5 lines".
			if (text) label = `Read ${plural(bodyLineCount(text) || countLines(text), "line")}`;
		}
		if (label) {
			// paddingX 0 keeps this flush with the rest of the output.
			state.statsWrapper.addChild(new Text("\n" + theme.fg("dim", label), 0, 0));
		}
	}
	// Numbered body for TEXT reads only. An image read stays entirely stock
	// — a gutter down the side of an image placeholder is meaningless.
	const isImage = (result.content ?? []).some((c: any) => c.type === "image");
	const body =
		!isImage && options.expanded && !context.isError && !options.isPartial
			? numbered(
					(result.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => String(c.text ?? ""))
						.join("\n"),
					typeof context.args?.path === "string" ? context.args.path : undefined,
					Number(context.args?.offset) > 0 ? Number(context.args.offset) : 1,
					theme,
				)
			: undefined;

	if (body !== undefined) {
		state.statsWrapper.addChild(blankRow() as never);
		state.statsWrapper.addChild(body.body as never);
		if (body.notes.length) state.statsWrapper.addChild(new Text(`\n${body.notes.join("\n")}`, 0, 0));
	} else {
		// pi's own renderer, and ONLY when it is going to be shown. It
		// syntax-highlights the whole file, so calling it for a body we then
		// discard cost ~40% of every expanded render.
		//
		// NOT `const inner = inner?.(...)`: a block-scoped binding of the same
		// name shadows the module-level one and puts it in the temporal dead
		// zone, so the initializer throws ReferenceError on EVERY render. pi
		// catches renderer exceptions and quietly falls back to its own
		// renderer, so the only visible symptom was a missing stats line and
		// read rows that laid out differently from edit.
		const innerComponent = inner?.(result, options, theme, {
			...context,
			lastComponent: state.statsInner as never,
		});
		state.statsInner = innerComponent;
		if (innerComponent) state.statsWrapper.addChild(innerComponent);
	}
	return state.statsWrapper;
}
