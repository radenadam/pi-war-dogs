/**
 * The injected messages' renderers (prompt/inject.ts) — quiet machinery
 * in the house grammar, the session brief's shape (visual/tools/brief.ts).
 * In the PAGER an injection is a first-class ACT (`inject` in surface.ts
 * ownResultKind; `details.kind` names the file): one dim sentence at
 * rest naming the file and its scope, the verbatim text behind the fold,
 * ctrl+click for the wire view, clustering as `received N injected
 * messages`. Nothing is hidden on the pretty surface: the text has no
 * provenance line to hide — provenance rides `details`, which is where
 * the sentence reads it from. Under `pager:false` the message renderer
 * below draws the same sentence-plus-`⎿` shape in pi's scrollback.
 * Registered only from installOnce (prompt/inject.ts), so a boot-off
 * draws pi's stock custom-message box for a transcript that carries one.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { ParsedResultMessage } from "./subagent.ts";

/** The message's text blocks joined (convertToLlm's view of it). */
function injectText(message: unknown): string {
	const blocks = (message as { content?: unknown[] } | undefined)?.content;
	if (typeof blocks === "string") return blocks;
	return (Array.isArray(blocks) ? blocks : [])
		.filter((b): b is { type: string; text?: string } => (b as { type?: string })?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n");
}

/** An injection as an act: `injected <file> · <scope>`, the text as the body. */
export function parseInjectMessage(message: unknown): ParsedResultMessage {
	const m = message as { details?: { kind?: string; scope?: string; path?: string } } | undefined;
	const raw = injectText(message);
	const perTurn = m?.details?.kind === "per-turn";
	const p = typeof m?.details?.path === "string" ? m.details.path : "";
	const file = p ? p.split(/[\\/]/).pop() || p : perTurn ? "PER_TURN.md" : "SESSION_START.md";
	const scope = typeof m?.details?.scope === "string" ? m.details.scope : "";
	return {
		head: `injected ${file}${scope ? ` · ${scope}` : ""}`,
		state: "",
		stateWord: "",
		failed: false,
		body: raw.trim(),
		trailer: "",
		raw,
	};
}

/** An injection in pi's own scrollback (`pager:false`): sentence, text under a `⎿` when expanded. */
export function renderInjectMessage(message: unknown, options: { expanded?: boolean } | undefined, theme: any) {
	const call = (t: string) => {
		try {
			return theme.fg("wdCall", t) as string;
		} catch {
			return theme.fg("toolOutput", t) as string;
		}
	};
	const r = parseInjectMessage(message);
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
