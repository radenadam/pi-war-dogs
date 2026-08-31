/**
 * How a subagent call looks in the transcript.
 *
 *   launched subagent • 1m 12s                             <- verb line (act sentence style)
 *   └─ ✔ researcher • Audit the cache • 1m 12s             <- run tree, never folds
 *      └─ ✔ scout • Map the surface • 34s (3)              <- (N) = deeper descendants
 *
 *   Prompt / Response                                       <- these two DO fold
 *
 * The tree sits between the call and the prompt because it is part of
 * the call's identity, not an appendix to the answer. Collapsed previews
 * render as PLAIN text: markdown turns N source lines into an
 * unpredictable number of display lines, so a "6 line" preview could
 * still swallow the screen.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { RUN_GLYPHS } from "../glyphs.ts";
import { srcLines } from "../../util/format.ts";
import { childrenOf, descendantCount, elapsedOf, knownRuns, registry } from "../../agents/run.ts";
import { BLUE, SUB_FAILED, SUB_OK } from "../../util/paint.ts";
import type { SubagentRun } from "../../agents/run.ts";

// The classic ASCII line, the SAME spinner the activity strip turns
// (maintainer, 2026-08-22: "same as the widget above the input bar") — the
// braille frames were retired with it; ~250 ms, the strip's cadence.
const SPIN = ["|", "/", "-", "\\"];
export const SPIN_MS = 250;
export const spinFrame = () => SPIN[Math.floor(Date.now() / SPIN_MS) % SPIN.length];

// One decision point for the status glyphs (visual/glyphs.ts): defaults per
// terminal, `war-dogs.glyphs` overrides, width-1 enforced.
const GLYPH: Record<SubagentRun["status"], string> = RUN_GLYPHS;
// Identity painters, constant across themes: blue = working/identity,
// settled-ok green; stopped and error read red (util/paint.ts).
const STATUS_PAINT: Record<SubagentRun["status"], (t: string) => string> = {
	working: BLUE,
	queued: BLUE,
	idle: SUB_OK,
	stopped: SUB_FAILED,
	error: SUB_FAILED,
};

// Direct children shown inline before eliding to the station. A display
// cap only — breadth itself is never limited.
const TREE_MAX_SIBLINGS = 8;
// Collapsed previews for the two foldable sections. The subagent tree is
// deliberately not foldable: it is the map of the run.
const PROMPT_PREVIEW = 6;
const RESPONSE_PREVIEW = 6;

/**
 * Zero-width run marker, mirroring how pi marks the hardware cursor with
 * \x1b_pi:c\x07. The pager scans rendered rows for it (util/ansi.ts
 * runMarkId) and turns each marked row into a click region that opens the
 * run. Terminals ignore APC and pi-tui measures it as zero width, so a
 * marker that reaches the screen is invisible; stripAnsi/sanitize remove
 * it wherever text is copied or re-processed.
 */
export const MARK = (id: string) => `\x1b_sa:${id}\x07`;

export function renderCall(args: any, theme: any, context: any) {
	const text = (context?.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
	const state = (context?.state ?? {}) as {
		startedAt?: number;
		endedAt?: number;
		spinTimer?: ReturnType<typeof setInterval>;
	};
	if (context?.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
	const agent = typeof args?.agent === "string" && args.agent ? args.agent : "adhoc";
	const brief = typeof args?.message === "string" ? args.message : typeof args?.task === "string" ? args.task : "";
	const title =
		typeof args?.title === "string" && args.title.trim()
			? args.title.trim()
			: brief
				? brief.split("\n")[0].slice(0, 60)
				: "…";
	const running = state.startedAt !== undefined && state.endedAt === undefined;

	// Drive the spinner off this row's own invalidate, and stop the
	// timer the moment the run settles so a finished call costs nothing.
	if (running && !state.spinTimer) {
		state.spinTimer = setInterval(() => {
			try {
				context?.invalidate?.();
			} catch {}
		}, SPIN_MS);
		(state.spinTimer as { unref?: () => void }).unref?.();
	} else if (!running && state.spinTimer) {
		clearInterval(state.spinTimer);
		state.spinTimer = undefined;
	}

	try {
		// The call line is the VERB alone — the duration lives on the tree
		// root's row, and repeating it here read as redundancy (round 8).
		// One verb pair per ACTION of the agent tool (2026-08-24).
		const action = typeof args?.action === "string" ? args.action : "run";
		const VERBS: Record<string, [string, string, string]> = {
			run: ["starting", "started", "agent"],
			message: ["messaging", "messaged", "agent"],
			ask: ["asking", "asked", "agent"],
			wait: ["holding", "held", "for replies"],
			status: ["checking", "checked", "agent"],
			stop: ["stopping", "stopped", "agent"],
			list: ["listing", "listed", "agents"],
		};
		const [live_, done_, noun] = VERBS[action] ?? VERBS.run;
		const verb = running ? live_ : done_;
		// The CALL tier (wdCall; caught fallback for stock themes).
		const callFg = (t: string) => {
			try {
				return theme.fg("wdCall", t) as string;
			} catch {
				return theme.fg("toolOutput", t) as string;
			}
		};
		text.setText(callFg(verb) + theme.bold(callFg(` ${noun}`)) + (running ? ` ${BLUE(spinFrame())}` : ""));
	} catch {
		text.setText(`Agent • ${agent} • ${title}`);
	}
	return text;
}

export function renderResult(result: any, options: any, theme: any, context: any) {
	const c = (context?.lastComponent instanceof Container ? context.lastComponent : null) ?? new Container();
	c.clear();
	const state = (context?.state ?? {}) as {
		startedAt?: number;
		endedAt?: number;
		treeTimer?: ReturnType<typeof setInterval>;
	};
	if (!options?.isPartial && state.endedAt === undefined) state.endedAt = Date.now();
	// The run tree sits directly under the call line, before the
	// prompt: it is part of the call's identity, not an appendix to
	// the response. It never folds, for the same reason the call
	// line never folds.
	const rootId = typeof (result?.details as any)?.runId === "string" ? (result.details as any).runId : undefined;
	// A BACKGROUND call settles its tool result the instant it launches, which
	// stopped every repaint while the run itself — and any children it spawned
	// — kept working: the tree froze at the launch frame forever, running
	// glyph and stale clock included. Keep this row's own invalidate ticking
	// while the root or any descendant is live; the tick that first observes
	// "settled" paints the final state, then stops.
	const treeLive = (id: string, depth = 0): boolean => {
		if (depth > 6) return false;
		const r = registry.get(id)?.run ?? knownRuns.get(id);
		if (r?.status === "working" || r?.status === "queued") return true;
		return childrenOf(id).some((k) => k.status === "working" || k.status === "queued" || treeLive(k.id, depth + 1));
	};
	const live = rootId ? treeLive(rootId) : false;
	if (live && !state.treeTimer) {
		state.treeTimer = setInterval(() => {
			try {
				context?.invalidate?.();
			} catch {}
		}, 500);
		(state.treeTimer as { unref?: () => void }).unref?.();
	} else if (!live && state.treeTimer) {
		clearInterval(state.treeTimer);
		state.treeTimer = undefined;
	}
	if (rootId) {
		const rows: string[] = [];
		const line = (r: SubagentRun, stem: string, last: boolean, extra: string) =>
			MARK(r.id) +
			theme.fg("muted", `${stem}${last ? "└─" : "├─"} `) +
			STATUS_PAINT[r.status](`${GLYPH[r.status]} `) +
			BLUE(r.agent) +
			// The TITLE is what the run is — the reading tier, not the low white
			// (maintainer, 2026-08-20); the duration is decoration and stays dim.
			theme.fg("muted", " • ") +
			theme.fg("text", r.title) +
			theme.fg("dim", ` • ${elapsedOf(r)}`) +
			extra;
		// The tree begins with the ROOT run's own row (maintainer's verdict:
		// the call line is the verb; who ran and what it was asked live
		// here), then its children indented one level under it.
		// The registry is in-memory, so a rehydrated transcript has no run
		// record — synthesize the root row from the call args and the result
		// meta so the tree ALWAYS renders (round 6: a lone subagent showed no
		// tree after a restart).
		// knownRuns is the once-loaded manifest index — render-safe (findRun
		// reads the disk per call and this runs in the render loop), and it
		// makes a CONTINUED session's root row carry its real title and time.
		const root = registry.get(rootId)?.run ?? knownRuns.get(rootId);
		const kids = childrenOf(rootId);
		const base = "   ";
		if (root) rows.push(line(root, "", true, ""));
		else {
			const agent = typeof context?.args?.agent === "string" && context.args.agent ? context.args.agent : "adhoc";
			const briefArg =
				typeof context?.args?.message === "string"
					? context.args.message
					: typeof context?.args?.task === "string"
						? context.args.task
						: "";
			const title =
				typeof context?.args?.title === "string" && context.args.title.trim()
					? context.args.title.trim()
					: briefArg
						? briefArg.split("\n")[0].slice(0, 60)
						: "…";
			const failedRun = !!result?.isError;
			const resText = (() => {
				try {
					return ((result?.content ?? []) as any[])
						.filter((c) => c.type === "text")
						.map((c) => String(c.text ?? ""))
						.join("\n");
				} catch {
					return "";
				}
			})();
			const took = /(?:^|\n)Took (\S+)/.exec(resText)?.[1];
			rows.push(
				MARK(rootId) +
					theme.fg("muted", "└─ ") +
					(failedRun ? SUB_FAILED(`${RUN_GLYPHS.error} `) : SUB_OK(`${RUN_GLYPHS.idle} `)) +
					BLUE(agent) +
					theme.fg("muted", " • ") +
					theme.fg("text", title) +
					(took ? theme.fg("dim", ` • ${took}`) : ""),
			);
		}
		const shown = kids.slice(0, TREE_MAX_SIBLINGS);
		shown.forEach((k, i) => {
			const last = i === shown.length - 1 && kids.length <= TREE_MAX_SIBLINGS;
			rows.push(line(k, base, last, ""));
			const stem = base + (last ? "   " : "│  ");
			const gks = childrenOf(k.id);
			gks.slice(0, TREE_MAX_SIBLINGS).forEach((g, j) => {
				const gLast = j === Math.min(gks.length, TREE_MAX_SIBLINGS) - 1;
				// Level two is the deepest drawn; anything under it
				// is summarised as a total descendant count.
				const deeper = descendantCount(g.id);
				rows.push(line(g, stem, gLast, deeper ? theme.fg("dim", ` (${deeper})`) : ""));
			});
			if (gks.length > TREE_MAX_SIBLINGS) {
				rows.push(theme.fg("dim", `${stem}   +${gks.length - TREE_MAX_SIBLINGS} more`));
			}
		});
		if (kids.length > TREE_MAX_SIBLINGS) {
			rows.push(theme.fg("dim", `${base}└─ +${kids.length - TREE_MAX_SIBLINGS} more`));
		}
		if (rows.length) c.addChild(new Text(rows.join("\n"), 0, 0));
	}

	// Prompt and Response are the collapsible parts; the tree above
	// is always shown in full. Previews take the HEAD —
	// the opening of a prompt says what the run is, its tail says
	// nothing.
	const expanded = !!options?.expanded;
	const head = (body: string, keep: number) => {
		const lines = body.split("\n");
		if (expanded || lines.length <= keep) return { text: body, hidden: 0 };
		return { text: lines.slice(0, keep).join("\n"), hidden: lines.length - keep };
	};
	// One vocabulary across the whole surface: "N lines total". No key
	// hint here — the pager appends its own, and outside the pager pi
	// already shows the expand binding.
	const more = (total: number) => new Text(theme.fg("dim", `… ${total} lines total`), 0, 0);

	const task =
		typeof context?.args?.message === "string"
			? context.args.message
			: typeof context?.args?.question === "string"
				? context.args.question
				: typeof context?.args?.task === "string"
					? context.args.task
					: "";
	if (task) {
		const p = head(task, PROMPT_PREVIEW);
		// No "Prompt" heading (2026-08-29): the pager builds the panel from
		// source with none, and under pager:false the text reads on its own.
		c.addChild(new Text(`\n${theme.fg("toolOutput", p.text)}`, 0, 0));
		if (p.hidden) c.addChild(more(srcLines(task)));
	}
	const txt = ((result?.content ?? []) as any[])
		.filter((b) => b?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n")
		.trim();
	const isBackground = (result?.details as any)?.background === true;
	if (isBackground && txt && !options?.isPartial) {
		// A background launch has NO response yet — the tool text is a
		// receipt ("Started … in the background …"), not the child's answer,
		// so it does not get a Response heading. Layout (maintainer,
		// 2026-08-18): Prompt, its text, a blank, the receipt in ITALIC (a
		// system note, not content), a blank, the run id in the output tier —
		// the one shape every run id has now, no rule.
		// Upright, and without the run id (2026-08-22): the id is wire-only.
		const { head: receipt } = splitTrailer(txt);
		c.addChild(new Text(`\n${theme.fg("toolOutput", receipt)}`, 0, 0));
	} else if (txt && txt !== "(starting…)") {
		// No "Response"/"Progress" heading either (2026-08-29): the maintainer
		// saw the box in a lead's view and read it as stock pi's.
		c.addChild(new Text("", 0, 0));
		const r = head(txt, RESPONSE_PREVIEW);
		// ALWAYS plain toolOutput text, never markdown. Rendering the
		// expanded form as markdown made the row visibly brighten on click,
		// which no other tool does and which reads as the model's own prose
		// rather than as tool output. It also made height unpredictable:
		// markdown turns N source lines into an unknown number of display
		// lines via code fences, wrapped lists and quotes.
		c.addChild(new Text(theme.fg("toolOutput", r.text), 0, 0));
		if (r.hidden) c.addChild(more(srcLines(txt)));
	}
	// The old `Took 8s · runner · depth 1` meta row is GONE (round 8): it
	// was renderer-built, view-only (the model's context carries only the
	// child's response text — and, for background runs, the follow-up's
	// "finished in Xs" line), and the duration already lives on the tree
	// root's row.
	return c;
}

/**
 * Split a run's text into its body and the `[run id: …]` trailer — the current
 * shape (blank line, then the id) and the pre-2026-08-18 one (`---` divider),
 * so older transcripts render the same. Exported: the bash parser and the
 * pager use it too.
 */
export function splitTrailer(text: string): { head: string; trailer: string } {
	// The [timestamp: …] line is the FINAL line of everything since 2026-08-21,
	// so it may follow the run id (or stand alone); it is display noise here —
	// the UI shows relative times — and is consumed with the trailer.
	const stamped = text.replace(/\n?\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]\s*$/, "");
	const m = /\n\n(?:---\n)?((?:\[agent stats: [^\]\n]+\]\n)?\[(?:agent id|run id): [^\]\n]+\])\s*$/.exec(stamped);
	if (!m) return { head: stamped, trailer: "" };
	return { head: stamped.slice(0, m.index).trimEnd(), trailer: m[1] };
}

/** Drop the delivery's provenance line (tools/*'s *_DELIVERY) if it leads — every shipped shape: 2026-08-21b (blank line after), 2026-08-21 (tight), and the older em-dash one. */
export function stripDelivery(text: string): string {
	return text.replace(
		/^\[(?:[Bb]ackground (?:(?:subagent|bash|powershell|job) result|results)|agent results?)[,— ][^\]\n]*\]\n+/,
		"",
	);
}

/** The text of a custom message, whichever shape pi stored it in. */
function messageText(message: any): string {
	return typeof message?.content === "string"
		? message.content
		: ((message?.content ?? []) as any[])
				.filter((b) => b?.type === "text")
				.map((b) => String(b.text ?? ""))
				.join("\n");
}

/** A delivered background result, parsed once for every surface that draws it. */
export interface ParsedResultMessage {
	/** The act sentence's head, plain: `background subagent "title" (agent)`. */
	head: string;
	/** The state phrase, plain: `finished in 22s` / `timed out after 30s` / `failed`. */
	state: string;
	/** The state's leading word — what bolds: finished / timed out / was stopped / failed. */
	stateWord: string;
	failed: boolean;
	/** The delivered text (the child's answer / the job's output), trailer removed. */
	body: string;
	/** The `[run id: …]` trailer, without its `---` divider. */
	trailer: string;
	/** The whole message text, for copy-as-source. */
	raw: string;
}

/**
 * Parse the `subagent-result` message tools/subagent.ts sends:
 * `Subagent "title" (agent) finished in 66s:\n\n<answer>\n\n---\n[run id: …]`.
 * Shared by the pager (which folds it as an act) and renderResultMessage
 * (pi's scrollback with `pager:false`) so the two never disagree.
 */
export function parseSubagentResultMessage(message: any): ParsedResultMessage {
	const raw = stripDelivery(messageText(message).trim());
	const { head, trailer } = splitTrailer(raw);
	const m =
		/^(?:Sub)?[Aa]gent "([^"]*)" \(([^)]*)\) (finished in [^:\n]+|timed out after [^:\n]+|was stopped (?:by [^:\n]*?)?after [^:\n]+|was interrupted by [^:\n]*? after [^:\n]+|errored after [^:\n]+|failed)(:|)\s*([\s\S]*)$/.exec(
			head,
		);
	const title = m ? m[1] : ((message?.details as any)?.title ?? "");
	const agent = m ? m[2] : ((message?.details as any)?.agent ?? "");
	const state = m ? m[3] : "";
	const body = (m ? m[5] : head).trim();
	const sm = /^(finished|timed out|was stopped|was interrupted|errored|failed)/.exec(state);
	return {
		head: `agent "${title}"${agent ? ` (${agent})` : ""}`,
		state,
		stateWord: sm ? sm[1] : "",
		// A stop is not a failure (2026-08-29): red for failed / errored / timed out only.
		failed: /^(failed|errored|timed out)/.test(state),
		body,
		trailer,
		raw,
	};
}

/**
 * The delivered answer of a BACKGROUND run — the `subagent-result` custom
 * message the tool sends as a follow-up. In pi's own scrollback (`pager:false`)
 * it renders as a machinery beat in the transcript's language instead of pi's
 * `[subagent-result]` box:
 *
 *    background subagent "bg 60s echo test" (runner) finished in 66s
 *    ⎿  OK
 *       [run id: subagent_…]
 *
 * The sentence is the low white with its state word bold (finished / timed
 * out / was stopped / failed — red when it failed); the answer sits under a
 * dim ⎿ like every act's evidence; the run id stays dim. Inside the pager the
 * same message is a foldable ACT (visual/pager/surface.ts, `ownResultKind`):
 * collapsed to this sentence, evidence behind the fold, a snippet while the
 * model works, clustering as `finished N background subagents`. Returning
 * undefined hands the message back to pi's stock box — the mode gate
 * (index.ts) does that while war-dogs is off, so persisted messages render
 * stock then.
 */
/** `[message from session_… ("name"); typed by its user]` + body → head/body. */
export function parsePeerMessage(message: any): ParsedResultMessage {
	const raw = messageText(message).trim();
	const m = /^\[message from ([^\]\n]+)\]\n+([\s\S]*)$/.exec(raw);
	// The reply-path teaching stays on the wire; the pretty head is the sender.
	const label = (m ? m[1] : "a session").replace(/; reply by messaging session_\S+$/, "");
	const { head: body } = splitTrailer(m ? m[2] : raw);
	return {
		head: `message from ${label}`,
		state: "",
		stateWord: "",
		failed: false,
		body: body.trim(),
		trailer: "",
		raw,
	};
}

/** A peer session's message in pi's own scrollback (`pager:false`). */
export function renderPeerMessage(message: any, _options: any, theme: any) {
	const r = parsePeerMessage(message);
	const call = (t: string) => {
		try {
			return theme.fg("wdCall", t) as string;
		} catch {
			return theme.fg("toolOutput", t) as string;
		}
	};
	const c = new Container();
	c.addChild(new Text(` ${call(r.head)}`, 0, 0));
	if (r.body) {
		const rows = r.body
			.split("\n")
			.map((l, i) =>
				i === 0 ? ` ${theme.fg("dim", "⎿")}  ${theme.fg("toolOutput", l)}` : `    ${theme.fg("toolOutput", l)}`,
			);
		c.addChild(new Text(rows.join("\n"), 0, 0));
	}
	return c;
}

export function renderResultMessage(message: any, _options: any, theme: any) {
	const r = parseSubagentResultMessage(message);
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
		const rows = lines.map((l, i) =>
			i === 0 ? ` ${theme.fg("dim", "⎿")}  ${theme.fg("toolOutput", l)}` : `    ${theme.fg("toolOutput", l)}`,
		);
		c.addChild(new Text(rows.join("\n"), 0, 0));
	}
	if (r.trailer) c.addChild(new Text(`\n    ${theme.fg("toolOutput", r.trailer)}`, 0, 0));
	return c;
}
