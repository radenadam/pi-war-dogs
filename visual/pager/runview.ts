/**
 * The subagent chat view: a child transcript rendered exactly like main,
 * with its own footer, breadcrumb and working row.
 *
 * Entries come from the LIVE in-process SessionManager when one exists
 * (no parsing, no polling, always current) and fall back to the session
 * file for runs from an earlier process. They are normalised to message
 * entries only: the file carries a leading `session` header the live
 * manager does not, so an unfiltered list changes length purely by
 * switching source — which desynced the incremental cache index and
 * silently dropped every message appended afterwards.
 *
 * "Generated in" is synthesised here from entry timestamps: child
 * sessions run with no extensions, so loader.ts is not present to
 * append it the way it does in main.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { sanitize } from "../../util/ansi.ts";
import { fmtSecs, srcLines } from "../../util/format.ts";
import { sessionFor } from "../../agents/run.ts";
import type { SubagentRun as SubagentRunInfo } from "../../agents/run.ts";
import { Markdown } from "@earendil-works/pi-tui";
import { toolDefs } from "./toolmap.ts";
import { isCollapsed } from "./surface.ts";

/* --- raw-view primitives: owned here, imported by surface.ts --- */

export interface RawLine {
	text: string;
	kind: "user" | "assistant" | "tool" | "dim" | "plain" | "pre";
	blockId?: string;
}

export function pushText(lines: RawLine[], text: string, kind: RawLine["kind"], blockId?: string) {
	for (const raw of text.split("\n")) lines.push({ text: sanitize(raw), kind, blockId });
}

export function summarizeArgs(args: unknown): string {
	try {
		const a = args as any;
		if (a && typeof a.command === "string") return a.command.split("\n")[0];
		const s = JSON.stringify(a);
		return s.length > 100 ? `${s.slice(0, 100)}…` : s;
	} catch {
		return "…";
	}
}

export const MAX_TOOL_RESULT_LINES = 300;

export function runEntries(run: SubagentRunInfo): { entries: unknown[]; source: "live" | "file" } {
	try {
		const sm = sessionFor(run.id)?.sessionManager;
		const entries = sm?.getEntries?.();
		if (Array.isArray(entries) && entries.length) {
			// Normalise to message entries only. The file carries a leading
			// `session` header that the live SessionManager does not, so an
			// unfiltered list changes length purely by switching source —
			// which desynced the incremental cache index and silently
			// dropped every message appended afterwards.
			return { entries: messageEntries(entries), source: "live" };
		}
	} catch {}
	return {
		entries: messageEntries(readChildEntries(run.sessionDir)),
		source: "file",
	};
}

/**
 * The message entries of a transcript, a persisted custom message included.
 * A custom message is its OWN entry type on disk and in the SessionManager
 * (`{type:"custom_message", customType, content, display, details}` — no
 * `.message`, the ledger's "scan for both shapes"), so a `type === "message"`
 * filter dropped every delivery a lead received before the builders saw it
 * (2026-08-29, the maintainer's screenshots: no delivery act in the lead's
 * view). Wrapped here into the `{message:{role:"custom"}}` shape pi's own
 * loader gives them, on both sources alike so the cache index stays in step.
 */
function messageEntries(entries: unknown[]): unknown[] {
	const out: unknown[] = [];
	for (const e of entries as any[]) {
		if (e?.type === "message") out.push(e);
		else if (e?.type === "custom_message")
			out.push({
				...e,
				type: "message",
				message: {
					role: "custom",
					customType: e.customType,
					content: e.content ?? [],
					display: e.display,
					details: e.details,
					timestamp: e.timestamp,
				},
			});
	}
	return out;
}

export function readChildEntries(sessionDir: string): unknown[] {
	try {
		const file = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.pop();
		if (!file) return [];
		const entries: unknown[] = [];
		for (const line of fs.readFileSync(path.join(sessionDir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {}
		}
		return entries;
	} catch {
		return [];
	}
}

export function childEntriesToRawLines(entries: unknown[], prefix: string, inner: number): RawLine[] {
	let md: unknown = null;
	try {
		md = getMarkdownTheme();
	} catch {}
	const lines: RawLine[] = [];
	let idx = 0;
	for (const entry of entries as any[]) {
		idx++;
		try {
			if (entry?.type !== "message" || !entry.message) continue;
			const m = entry.message;
			const entryId = `${prefix}:${String(entry.id ?? `e${idx}`)}`;
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
			if (m.role === "user") {
				lines.push({ text: "", kind: "plain" });
				lines.push({ text: "❯ prompt", kind: "user" });
				for (const b of content) {
					if (b.type === "text") pushText(lines, b.text, "plain");
					else if (b.type === "image") lines.push({ text: "[image]", kind: "dim" });
				}
			} else if (m.role === "assistant") {
				lines.push({ text: "", kind: "plain" });
				let ti = 0;
				for (const b of content) {
					if (b.type === "text") {
						if (md)
							for (const ln of new Markdown(String(b.text ?? ""), 1, 0, md as never).render(inner))
								lines.push({ text: ln, kind: "pre" });
						else pushText(lines, String(b.text ?? ""), "plain");
					} else if (b.type === "thinking") {
						ti++;
						const id = `${entryId}:think:${ti}`;
						const body = String(b.thinking ?? "");
						const n = srcLines(body);
						lines.push({ text: `${isCollapsed(id) ? "▸" : "▾"} thinking · ${n} lines`, kind: "dim", blockId: id });
						if (!isCollapsed(id)) pushText(lines, body, "dim", id);
					} else if (b.type === "toolCall") {
						lines.push({ text: `⚙ ${b.name ?? b.toolName ?? "tool"} · ${summarizeArgs(b.arguments)}`, kind: "tool" });
					}
				}
			} else if (m.role === "toolResult") {
				const id = `tr:${prefix}:${String(m.toolCallId ?? entryId)}`;
				const texts = content.filter((b: any) => b.type === "text").map((b: any) => String(b.text ?? ""));
				const body = texts.join("\n");
				const n = srcLines(body);
				const name = String(m.toolName ?? "tool");
				lines.push({ text: `${isCollapsed(id) ? "▸" : "▾"} ${name} output · ${n} lines`, kind: "tool", blockId: id });
				if (!isCollapsed(id)) {
					const before = lines.length;
					pushText(lines, body, "dim", id);
					if (lines.length - before > MAX_TOOL_RESULT_LINES) {
						lines.length = before + MAX_TOOL_RESULT_LINES;
						lines.push({ text: "… (truncated in pager)", kind: "dim", blockId: id });
					}
				}
			}
		} catch {
			lines.push({ text: "[unrenderable entry]", kind: "dim" });
		}
	}
	if (!lines.length) lines.push({ text: "(child session is empty so far)", kind: "dim" });
	return lines;
}

/**
 * pi's live thinking-visibility state, threaded in from the surface.
 *
 * A child transcript must read like main, and main respects
 * `hideThinkingBlock` (shift+tab). Both builders used to hard-code `false`
 * and the label `"thinking"`, so hidden thinking came straight BACK the
 * moment you opened a run view, in a label pi never uses (round 31 audit).
 * pi keeps both values private on its interactive mode, so the surface
 * OBSERVES them off the components pi itself rendered with.
 */
export interface ThinkingView {
	hide: boolean;
	label: string;
}

export function buildChildComps(
	tui: TUI,
	cache: ChildComps,
	entries: any[],
	theme: Theme,
	think: ThinkingView,
): boolean {
	const mdTheme = getMarkdownTheme(); // throws when theme absent -> caller falls back
	let changed = false;
	for (let i = cache.count; i < entries.length; i++) {
		const entry = entries[i];
		changed = true;
		try {
			if (entry?.type !== "message" || !entry.message) continue;
			const m = entry.message;
			if (m.role === "user") {
				const text = (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }])
					.filter((b: any) => b.type === "text")
					.map((b: any) => String(b.text ?? ""))
					.join("\n");
				// Breathing room between a reply and the next prompt.
				if (cache.comps.length) cache.comps.push(spacerComponent() as never);
				cache.comps.push(new UserMessageComponent(text, mdTheme, 1));
			} else if (m.role === "assistant") {
				const comp = new AssistantMessageComponent(m as never, think.hide, mdTheme, think.label, 1);
				cache.comps.push(comp);
				// A subagent view should read like main, and main closes every
				// TURN with the loader's "Generated in" marker. Child sessions
				// run without extensions, so synthesise it from timestamps.
				//
				// Only on a message that ENDS the turn. An assistant message
				// carrying a toolCall is mid-turn — pi will run the tool and
				// come straight back — so marking it printed "Generated in"
				// between the thinking and the tool call it led to, which is
				// not what main does. main emits on agent_settled, i.e. once,
				// when the model is actually finished.
				// ...and only on a turn that actually PRODUCED something. A
				// message that ended in an error or an abort has no toolCall
				// either, so it satisfied the test above and got stamped
				// "Generated in 3s" directly under a 429 — reporting a
				// completion time for a turn that never completed.
				const stop = String((m as any).stopReason ?? "");
				const failed = stop === "error" || stop === "aborted" || !!(m as any).errorMessage;
				const endsTurn =
					!failed && !(Array.isArray(m.content) ? m.content : []).some((b: any) => b?.type === "toolCall");
				const t1 = endsTurn ? Date.parse(String(entry.timestamp ?? "")) : Number.NaN;
				let t0 = Number.NaN;
				for (let j = i - 1; j >= 0; j--) {
					const ts = (entries[j] as any)?.timestamp;
					if (ts) {
						t0 = Date.parse(String(ts));
						break;
					}
				}
				if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
					const secs = Math.max(0, Math.round((t1 - t0) / 1000));
					cache.comps.push(genTimeComponent(fmtSecs(secs), theme) as never);
				}
				for (const b of Array.isArray(m.content) ? m.content : []) {
					if (b?.type === "toolCall") {
						// Pass the REAL tool definition so a child transcript
						// renders exactly like main. Passing undefined made pi
						// fall back to "tool name + raw JSON args", which is why
						// subagent/webfetch/kimi-websearch looked nothing like
						// they do in the main view. Built-ins resolve their own
						// definition internally, but extension tools — and the
						// tool-stats overrides of read/edit — do not.
						const def = toolDefs.get(String(b.name ?? ""));
						const tc = new ToolExecutionComponent(
							String(b.name ?? "tool"),
							String(b.id ?? `tc${i}`),
							b.arguments ?? {},
							{ showImages: false },
							def,
							tui,
							process.cwd(),
						);
						tc.setArgsComplete?.();
						cache.comps.push(tc);
						cache.tools.set(String(b.id ?? `tc${i}`), tc);
					}
				}
			} else if (m.role === "toolResult") {
				const tc = cache.tools.get(String(m.toolCallId ?? ""));
				// A result implies the call started (see reconcileChildComps).
				try {
					tc?.setArgsComplete?.();
					tc?.markExecutionStarted?.();
				} catch {}
				tc?.updateResult?.({ content: m.content ?? [], details: m.details, isError: !!m.isError }, false);
			} else if (m.role === "custom") {
				// A delivered message (its agents' replies, agents/session.ts
				// deliverToRun) is a CustomMessageComponent, as in main: the
				// pager's own act (surface.ts ownResultKind) keys on the class and
				// customType, so no renderer is needed here. Before 2026-08-29 the
				// role had no branch and a lead's view never showed what its
				// workers delivered (the maintainer's screenshots).
				if (cache.comps.length) cache.comps.push(spacerComponent() as never);
				cache.comps.push(new CustomMessageComponent(m as never, undefined, mdTheme, 1));
			}
		} catch {
			/* skip unrenderable entries */
		}
	}
	cache.count = entries.length;
	return changed;
}

/**
 * The turn-closing `✸ Generated in Ns` marker.
 *
 * The label is MUTABLE. A turn that is still open has no end timestamp, so
 * `reconcileChildComps` estimates one from "when we first saw it finish" —
 * an estimate that keeps improving as the next message lands. `take()` only
 * ever CONSTRUCTS a component once, so the first estimate was baked in and
 * a child transcript reported `Generated in 0s` for a turn that took nine
 * (round 31 audit). Same shape as every other component here: created once,
 * updated in place.
 */
export function genTimeComponent(
	label: string,
	theme: Theme,
): { render: (w: number) => string[]; invalidate: () => void; setLabel: (l: string) => boolean } {
	let text = label;
	return {
		/** True when the label actually moved — the caller marks the view dirty on that alone. */
		setLabel(l: string) {
			if (l === text) return false;
			text = l;
			return true;
		},
		render() {
			try {
				return [
					"",
					// Uniformly DIM with its sentence (round 30; was blue, before
					// that grenade red).
					` ${(theme as any).fg("dim", `✸ Generated in ${text}`)}`,
				];
			} catch {
				return ["", ` ✸ Generated in ${text}`];
			}
		},
		invalidate() {},
	};
}

export function spacerComponent(): { render: () => string[]; invalidate: () => void } {
	return { render: () => [""], invalidate() {} };
}

export interface ChildComps {
	count: number;
	comps: any[];
	tools: Map<string, any>;
	/** Which entry source the cache index refers to. */
	source?: "live" | "file";
	/** Components by stable message key, for in-place reconciliation. */
	keyed?: Map<string, any>;
	/** When each assistant message was first observed to finish. */
	finished?: Map<string, number>;
	/** Last file parse for THIS run. Shared across runs it throttled the wrong one. */
	parsedAt?: number;
}

/* ---------------- live reconciliation ---------------- */

/**
 * Build the child transcript the way MAIN is built: one component per
 * message, created the moment the message first appears and updated in
 * place thereafter.
 *
 * The old model kept TWO lists — components built from persisted entries
 * plus a "live tail" rebuilt each frame — and a message moved between them
 * when it was written to disk. That handoff is what produced both of the
 * subagent view's defects:
 *
 *  - Tool calls never streamed. A ToolExecutionComponent was only created
 *    once its assistant message had been persisted, so an in-flight call
 *    rendered nothing at all: thinking, then a gap, then a finished call.
 *  - The surface flickered. The gap is a height change, and it scales with
 *    the message — a five-paragraph reply measured a 96-row drop against a
 *    33-row viewport, which no magnitude guard can absorb.
 *
 * Reconciling against a stable key per message removes the handoff
 * entirely: nothing is ever dropped and rebuilt, so there is no gap to
 * mask. pi drives main the same way, which is why main never had either
 * symptom.
 */
export function reconcileChildComps(
	tui: TUI,
	cache: ChildComps,
	msgs: any[],
	theme: Theme,
	think: ThinkingView,
): boolean {
	const mdTheme = getMarkdownTheme(); // throws when theme absent -> caller falls back
	cache.keyed ??= new Map();
	const seen = new Set<string>();
	const comps: any[] = [];
	let changed = false;

	/** Reuse the component for `key`, or make one and remember it. */
	const take = <T>(key: string, make: () => T, update?: (c: T) => void): T => {
		let c = cache.keyed!.get(key) as T | undefined;
		if (c === undefined) {
			c = make();
			cache.keyed!.set(key, c as any);
			changed = true;
		} else if (update) {
			update(c);
		}
		seen.add(key);
		comps.push(c);
		return c;
	};

	const textOf = (m: any) =>
		(Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }])
			.filter((b: any) => b?.type === "text")
			.map((b: any) => String(b.text ?? ""))
			.join("\n");

	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (!m || typeof m !== "object") continue;
		const role = m.role;

		if (role === "user") {
			// Content length is part of the key because UserMessageComponent
			// takes its text at construction and cannot be updated: a purely
			// positional key would reuse a component whose text had changed
			// and quietly render the old prompt.
			const body = textOf(m);
			if (comps.length) take(`s:${i}`, () => spacerComponent());
			take(`u:${i}:${body.length}`, () => new UserMessageComponent(body, mdTheme, 1));
			continue;
		}

		if (role === "assistant") {
			const key = `a:${m.responseId ?? m.timestamp ?? i}`;
			take(
				key,
				() => new AssistantMessageComponent(m as never, think.hide, mdTheme, think.label, 1),
				(c: any) => {
					// In place — this is the whole point. Replacing the
					// component here would reintroduce the handoff. The
					// thinking-visibility setters are live too (pi flips them on
					// the shift+tab cycle), and each re-runs updateContent, so
					// they go FIRST and updateContent closes the update.
					try {
						c.setHideThinkingBlock?.(think.hide);
						c.setHiddenThinkingLabel?.(think.label);
						c.updateContent?.(m as never);
						changed = true;
					} catch {}
				},
			);

			const blocks = Array.isArray(m.content) ? m.content : [];
			const stop = String(m.stopReason ?? "");
			const failed = stop === "error" || stop === "aborted" || !!m.errorMessage;
			const calls = blocks.filter((b: any) => b?.type === "toolCall");

			for (let ci = 0; ci < calls.length; ci++) {
				const b = calls[ci];
				const id = String(b.id ?? `${key}:tc${ci}`);
				// Keyed by POSITION, not by the tool-call id. The id does not
				// exist until the arguments finish streaming, so an id-based
				// key changed identity mid-flight: the component was rebuilt,
				// and with it went the pager's per-row expand override — which
				// is why a streaming tool could not be clicked open until it
				// had finished.
				const tk = `t:${key}:${ci}`;
				const tc = take(
					tk,
					() => {
						const def = toolDefs.get(String(b.name ?? ""));
						return new ToolExecutionComponent(
							String(b.name ?? "tool"),
							id,
							b.arguments ?? {},
							{ showImages: false },
							def,
							tui,
							process.cwd(),
						);
					},
					(c: any) => {
						// Arguments arrive token by token while the call is
						// still being generated; feeding them in is what makes
						// a subagent tool call stream like main's.
						try {
							c.updateArgs?.(b.arguments ?? {});
						} catch {}
					},
				) as any;
				cache.tools.set(id, tc);
				// Only once the assistant message is finished are the
				// arguments known to be complete.
				if (stop && stop !== "pending") {
					try {
						tc.setArgsComplete?.();
						tc.markExecutionStarted?.();
					} catch {}
				}
			}

			// Turn-closing marker, matching main's loader. Only once the
			// message is genuinely FINISHED: a streaming message has no
			// toolCall blocks yet and stopReason "pending", so testing only
			// for "no tool calls" stamped "Generated in 0s" underneath a
			// reply that was still being written.
			const done = !!stop && stop !== "pending";
			if (done && !failed && calls.length === 0) {
				// m.timestamp is when the message STARTED, so the end has to
				// come from somewhere else: the next message if the turn is
				// already over, otherwise the moment we first saw it finish.
				cache.finished ??= new Map();
				const next = msgs[i + 1];
				let end = Number(next?.timestamp ?? Number.NaN);
				if (!Number.isFinite(end)) {
					if (!cache.finished.has(key)) cache.finished.set(key, Date.now());
					end = cache.finished.get(key) as number;
				}
				const start = Number(m.timestamp ?? Number.NaN);
				if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
					const secs = Math.max(0, Math.round((end - start) / 1000));
					const label = fmtSecs(secs);
					take(
						`g:${key}`,
						() => genTimeComponent(label, theme),
						(c) => {
							// The estimate improves once the NEXT message lands —
							// update in place, never rebuild (see genTimeComponent).
							if (c.setLabel?.(label)) changed = true;
						},
					);
				}
			}
			continue;
		}

		if (role === "toolResult") {
			const tc = cache.tools.get(String(m.toolCallId ?? ""));
			try {
				// A RESULT implies the call started, whatever its message still
				// reads: the streaming partial stands in for the persisted
				// assistant message until it is released (childKids), so for a
				// few frames the tool held its result while its message read
				// "pending" and markExecutionStarted had not run — the renderer
				// stamped the end before the start and the act read `· -0.3s`
				// (2026-08-29, seen beside main's `· 1.0s`).
				tc?.setArgsComplete?.();
				tc?.markExecutionStarted?.();
				tc?.updateResult?.({ content: m.content ?? [], details: m.details, isError: !!m.isError }, false);
				changed = true;
			} catch {}
			continue;
		}

		if (role === "custom") {
			// A delivered message (see buildChildComps): the pager's act renders
			// it; the component only has to exist, keyed like a user message.
			const body = textOf(m);
			if (comps.length) take(`s:${i}`, () => spacerComponent());
			take(`c:${i}:${body.length}`, () => new CustomMessageComponent(m as never, undefined, mdTheme, 1));
			continue;
		}
	}

	// Drop components whose messages are gone (a branch switch, a compaction).
	for (const k of [...cache.keyed.keys()]) {
		if (!seen.has(k)) {
			cache.keyed.delete(k);
			changed = true;
		}
	}
	if (comps.length !== cache.comps.length) changed = true;
	cache.comps = comps;
	return changed;
}
