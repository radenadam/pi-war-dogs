/**
 * How `webfetch` calls render.
 *
 * pi's fallback renderers emit just the tool name and raw text with no
 * blank row between them — which also defeats the pager's call/output
 * split, so the body never gets the standard inset. These mirror the
 * built-in tools' shape: title + argument, blank row, body.
 */

import { Text } from "@earendil-works/pi-tui";
import { TRAILING_STAMP_RE } from "../../util/stamp.ts";
import { COLLAPSED_ROWS, moreRow } from "./gutter.ts";

export function renderCall(args: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	const url = typeof args?.url === "string" ? args.url : "…";
	text.setText(`${theme.fg("toolTitle", theme.bold("WebFetch"))} ${theme.fg("accent", url)}`);
	return text;
}

export function renderResult(result: any, options: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	// The trailing [timestamp: …] stamp is the model's clock — display noise
	// (the pager's per-beat wire view shows the verbatim result). The
	// `[webfetch: …]` head line STAYS here: under `pager:false` this render
	// is all there is and that line carries the status; the pager drops it
	// there, where the act sentence already states it.
	const body = ((result?.content ?? []) as any[])
		.filter((b) => b?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n")
		.replace(TRAILING_STAMP_RE, "");
	// A fetched page (or a search) is a document, and a COLLAPSED row is not
	// where a document belongs: nothing downstream caps a renderer's height,
	// so ignoring `expanded` put all 500 lines of it on screen for a folded
	// beat. Cap it like pi caps write, and say what is hidden. The pager is
	// unaffected — it renders every tool with `expanded` flipped on.
	const lines = body.split("\n");
	const shown = options?.expanded ? lines : lines.slice(0, COLLAPSED_ROWS);
	const more = shown.length < lines.length ? `\n${moreRow(lines.length - shown.length, lines.length, theme)}` : "";
	// Leading blank row: the separator every other tool has.
	text.setText(`\n${theme.fg("toolOutput", shown.join("\n"))}${more}`);
	return text;
}
