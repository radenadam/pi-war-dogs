/**
 * How `bash` renders: the command syntax-highlighted through pi's own
 * highlight.js integration instead of one flat toolTitle colour.
 * Execution is untouched.
 */

import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { highlightField, shellTone } from "./syntax.ts";
import type { ParsedResultMessage } from "./subagent.ts";
import { parseSubagentResultMessage, splitTrailer, stripDelivery } from "./subagent.ts";

/** Timing state shared with pi's built-in bash result renderer. */
export type BashState = { startedAt?: number; endedAt?: number };

function makeRenderCall(lang: "bash" | "powershell") {
	return function renderCall(args: any, theme: any, context: any) {
		// Preserve the built-in timing state — the result renderer uses
		// state.startedAt for the Elapsed/Took footer. NOT for a `background: true`
		// call: its result is a receipt returned the instant the job is spawned,
		// so pi's footer read `Took 0.0s` under it (demonstrated) — a duration
		// for something that has not run. With no startedAt pi's renderer omits
		// the footer entirely (bash.js: `if (startedAt !== undefined)`); the
		// job's real duration arrives with its bash-result.
		const state = context.state as BashState;
		if (context.executionStarted && state.startedAt === undefined && args?.background !== true) {
			state.startedAt = Date.now();
			state.endedAt = undefined;
		}

		const command = typeof args?.command === "string" ? args.command : "";
		const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

		const text = context.lastComponent ?? new Text("", 0, 0);
		const prompt = theme.fg("toolTitle", theme.bold("$ "));
		if (!command) {
			text.setText(prompt + theme.fg("toolOutput", "..."));
			return text;
		}
		// The command in the FIELD palette (visual/tools/syntax.ts) — pi's stock
		// palette when the theme has none.
		const rows = shellTone(highlightField(command, lang, theme) ?? highlightCode(command, lang), command, theme);
		text.setText(prompt + rows.join("\n") + timeoutSuffix);
		return text;
	};
}
export const renderCall = makeRenderCall("bash");
/** The same call render for the powershell skin (tools/powershell.ts), highlighted as PowerShell. */
export const renderPowershellCall = makeRenderCall("powershell");

/** Rows of a delivered background result shown before "… N lines total" (pi's scrollback only). */
const RESULT_PREVIEW = 20;

/**
 * Parse the `bash-result` message tools/bash-background.ts sends:
 * `Background bash "title" finished in 61s (exit 0):\n\n<output>\n\n---\n[run id: …]`.
 * Shared by the pager (which folds it as an act) and renderResultMessage
 * (pi's scrollback with `pager:false`). Same shape as the subagent's parse
 * (visual/tools/subagent.ts ParsedResultMessage) so the pager draws both
 * with one branch.
 */
export function parseBashResultMessage(message: any): ParsedResultMessage {
	const raw = stripDelivery(
		(typeof message?.content === "string"
			? message.content
			: ((message?.content ?? []) as any[])
					.filter((b) => b?.type === "text")
					.map((b) => String(b.text ?? ""))
					.join("\n")
		).trim(),
	);
	const { head, trailer } = splitTrailer(raw);
	const m =
		/^Background (bash|powershell) "([^"]*)" (finished in [^:\n]+|failed in [^:\n]+|was stopped (?:after|by) [^:\n]+|failed to start: [^\n]+):\s*([\s\S]*)$/.exec(
			head,
		);
	const tool = m ? m[1] : ((message?.details as any)?.tool ?? "bash");
	const title = m ? m[2] : ((message?.details as any)?.title ?? "");
	const state = m ? m[3] : "";
	const body = (m ? m[4] : head).trim();
	const sm = /^(finished|failed to start|failed|was stopped)/.exec(state);
	return {
		head: `background ${tool} "${title}"`,
		state,
		stateWord: sm ? sm[1] : "",
		// A job stopped BY a session end is a stop, not a failure (2026-08-29);
		// "was stopped after Ns (SIGKILL)" — a signal from outside — stays red.
		failed: /^(failed|was stopped after)/.test(state),
		body,
		trailer,
		raw,
	};
}

/**
 * The delivered output of a BACKGROUND bash job — the `bash-result` custom
 * message tools/bash-background.ts sends as a follow-up. In pi's own
 * scrollback (`pager:false`) it is a machinery beat in the transcript's
 * language (the background subagent's shape):
 *
 *    background bash "sleep 60 && echo OK" finished in 61s (exit 0)
 *    ⎿  OK
 *       [run id: bash_…]
 *
 * State word bold; a non-zero exit, a signal or a start failure paint the
 * sentence red. Inside the pager the same message is a foldable ACT
 * (visual/pager/surface.ts, `ownResultKind`). Returning undefined hands the
 * message to pi's stock box — the mode gate in index.ts does that while
 * war-dogs is off.
 */
export function renderResultMessage(message: any, _options: any, theme: any) {
	const r = parseBashResultMessage(message);
	const call = (t: string) => {
		if (r.failed) return theme.fg("error", t) as string;
		try {
			return theme.fg("wdCall", t) as string;
		} catch {
			return theme.fg("toolOutput", t) as string;
		}
	};
	const statePart = r.stateWord
		? `${theme.bold(call(r.stateWord))}${call(r.state.slice(r.stateWord.length))}`
		: call(r.state);
	const sentence = ` ${call(r.head)}${r.state ? ` ${statePart}` : ""}`;
	const c = new Container();
	c.addChild(new Text(sentence, 0, 0));
	if (r.body) {
		const lines = r.body.split("\n");
		const shown = lines.slice(0, RESULT_PREVIEW);
		const rows = shown.map((l, i) =>
			i === 0 ? ` ${theme.fg("dim", "⎿")}  ${theme.fg("toolOutput", l)}` : `    ${theme.fg("toolOutput", l)}`,
		);
		if (lines.length > shown.length) rows.push(`    ${theme.fg("dim", `… ${lines.length} lines total`)}`);
		c.addChild(new Text(rows.join("\n"), 0, 0));
	}
	// The run id is wire-only (2026-08-22) — not drawn here either.
	return c;
}

/**
 * A BATCHED delivery (`background-results`, tools/delivery.ts): two or more
 * jobs that finished inside one window, their single-delivery bodies stacked
 * under one provenance line. Each section opens with its own sentence
 * (`Background bash "…" …:` / `Subagent "…" (…) …:`) and closes with its
 * `[run id: …]`, so the split is on the sentence lines; each section then
 * goes through the parser of its kind as if it had arrived alone. The stamp
 * sits after the last section, where that section's splitTrailer eats it.
 */
export function parseBatchResultMessage(message: any): ParsedResultMessage[] {
	const raw = stripDelivery(
		(typeof message?.content === "string"
			? message.content
			: ((message?.content ?? []) as any[])
					.filter((b) => b?.type === "text")
					.map((b) => String(b.text ?? ""))
					.join("\n")
		).trim(),
	);
	const lines = raw.split("\n");
	const starts: number[] = [];
	lines.forEach((l, i) => {
		if (/^(?:Background (?:bash|powershell) "|Subagent |Agent ")/.test(l)) starts.push(i);
	});
	if (!starts.length) return [parseBashResultMessage(message)];
	return starts.map((at, k) => {
		const section = lines.slice(at, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n");
		const pseudo = { content: section, details: message?.details };
		// `Agent "` sections since the 2026-08-24 rename; `Subagent ` kept
		// for old transcripts (the split regex above matches all three).
		return section.startsWith("Subagent ") || section.startsWith("Agent ")
			? parseSubagentResultMessage(pseudo)
			: parseBashResultMessage(pseudo);
	});
}

/** pi's own scrollback (`pager:false`): the batch as one beat, each job a section under it. */
export function renderBatchResultMessage(message: any, _options: any, theme: any) {
	const parts = parseBatchResultMessage(message);
	const failed = parts.filter((p) => p.failed).length;
	const call = (t: string, err = false) => {
		if (err) return theme.fg("error", t) as string;
		try {
			return theme.fg("wdCall", t) as string;
		} catch {
			return theme.fg("toolOutput", t) as string;
		}
	};
	const c = new Container();
	let head = ` ${call(`${parts.length} background results`)} ${theme.bold(call("finished"))}`;
	if (failed) head += ` ${call(`· ${failed} failed`, true)}`;
	c.addChild(new Text(head, 0, 0));
	const rows: string[] = [];
	for (const r of parts) {
		const sentence = r.stateWord
			? `${call(r.head, r.failed)} ${theme.bold(call(r.stateWord, r.failed))}${call(r.state.slice(r.stateWord.length), r.failed)}`
			: `${call(r.head, r.failed)} ${call(r.state, r.failed)}`;
		rows.push(rows.length ? `    ${sentence}` : ` ${theme.fg("dim", "⎿")}  ${sentence}`);
		const lines = r.body.split("\n");
		const shown = lines.slice(0, RESULT_PREVIEW);
		for (const l of shown) rows.push(`       ${theme.fg("toolOutput", l)}`);
		if (lines.length > shown.length) rows.push(`       ${theme.fg("dim", `… ${lines.length} lines total`)}`);
		rows.push("");
	}
	while (rows.length && !rows[rows.length - 1]) rows.pop();
	if (rows.length) c.addChild(new Text(rows.join("\n"), 0, 0));
	return c;
}
