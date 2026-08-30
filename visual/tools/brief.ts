/**
 * The session brief's renderers — quiet machinery in the house grammar.
 * In the PAGER the brief is a first-class ACT (`session-brief` in
 * surface.ts ownResultKind): one dim sentence at rest, the facts behind
 * the fold, ctrl+click for the verbatim wire text, clustering as
 * `received the session brief`. The provenance head line (`[session
 * brief: …]`) is hidden on the pretty surface like every delivery's —
 * the wire view shows it back. Under `pager:false` the message renderer
 * below draws the same sentence-plus-`⎿` shape in pi's scrollback.
 * Registered only from installOnce (prompt/index.ts), so a boot-off
 * draws pi's stock custom-message box for a transcript that carries one
 * — the same documented fallback as agent-result.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { ParsedResultMessage } from "./subagent.ts";

/** The brief's text blocks joined (convertToLlm's view of it). */
function briefText(message: unknown): string {
	const blocks = (message as { content?: unknown[] } | undefined)?.content;
	if (typeof blocks === "string") return blocks;
	return (Array.isArray(blocks) ? blocks : [])
		.filter((b): b is { type: string; text?: string } => (b as { type?: string })?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n");
}

/** The brief as an act: fixed sentence, the facts as the body, the provenance head line pretty-hidden. */
export function parseBriefMessage(message: unknown): ParsedResultMessage {
	const raw = briefText(message).trim();
	const lines = raw.split("\n");
	const body = (lines[0]?.startsWith("[session brief") ? lines.slice(1) : lines).join("\n").trim();
	return {
		head: "session brief · environment and runtime",
		state: "",
		stateWord: "",
		failed: false,
		body,
		trailer: "",
		raw,
	};
}

/** The brief in pi's own scrollback (`pager:false`): sentence, body under a `⎿` when expanded. */
export function renderBriefMessage(message: unknown, options: { expanded?: boolean } | undefined, theme: any) {
	const call = (t: string) => {
		try {
			return theme.fg("wdCall", t) as string;
		} catch {
			return theme.fg("toolOutput", t) as string;
		}
	};
	const r = parseBriefMessage(message);
	const c = new Container();
	c.addChild(new Text(` ${call(r.head)}`, 0, 0));
	if (options?.expanded && r.body) {
		const rows = r.body
			.split("\n")
			.map((l, i) =>
				i === 0 ? ` ${theme.fg("dim", "⎿")}  ${theme.fg("toolOutput", l)}` : `    ${theme.fg("toolOutput", l)}`,
			);
		c.addChild(new Text(rows.join("\n"), 0, 0));
	}
	return c;
}
