/**
 * How `websearch` (v2, direct microservice) calls render.
 * Mirrors visual/tools/websearch.ts: title + argument, blank row, body.
 */

import { Text } from "@earendil-works/pi-tui";
import { TRAILING_STAMP_RE } from "../../util/stamp.ts";
import { COLLAPSED_ROWS, moreRow } from "./gutter.ts";

export function renderCall(args: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	const q = typeof args?.query === "string" ? args.query : "…";
	text.setText(`${theme.fg("toolTitle", theme.bold("Kimi-WebSearch"))} ${theme.fg("accent", q)}`);
	return text;
}

export function renderResult(result: any, options: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	// The trailing [timestamp: …] stamp is display noise here — the model's
	// clock, not a search result (the wire view shows it verbatim).
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
	text.setText(`\n${theme.fg("toolOutput", shown.join("\n"))}${more}`);
	return text;
}
