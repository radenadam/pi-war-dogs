/**
 * The reading surface: pi's live component tree rendered inside a
 * full-screen overlay, with the bottom UI drawn inside it.
 *
 * While open, the reading-surface containers are DETACHED from pi's root
 * so pi's own frames stay tiny and its full redraws cannot flicker
 * through. The tail (status, widgets, editor, footer) is read live from
 * tui.children each frame rather than snapshotted, because setFooter
 * removes, disposes and re-adds — a snapshot would render a disposed
 * component after any /reload.
 *
 * Folding is pager-owned: tools render EXPANDED with their `expanded`
 * flag flipped only inside a single render call, so pi's transcript
 * state never changes, which is what keeps toggles flicker-free. A
 * collapsed act rests as its SENTENCE (actSentence); the subagent folds
 * to its label (LABEL_FOLD_TOOLS) as a nested narrative.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { openExternal } from "../../util/opener.ts";
import * as path from "node:path";
import {
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	copyToClipboard,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	sliceByColumn,
	truncateToWidth as ansiTruncate,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import {
	abortCause,
	abortRun,
	childrenOf,
	descendantCount,
	elapsedOf,
	knownRuns,
	liveMessageFor,
	registry,
	sessionFor,
	teamWorking,
	statsFor,
	turnStartFor,
	sessionEndOf,
} from "../../agents/run.ts";
import type { RunConfig, SubagentRun as SubagentRunInfo } from "../../agents/run.ts";
import {
	invert,
	leadingBg,
	openingBg,
	runMarkId,
	sanitize,
	stripAnsi,
	stripBgSeqs,
	underline,
	wrapPlain,
} from "../../util/ansi.ts";
import { fmtSecs, fmtTokens, plural, srcLines } from "../../util/format.ts";
import { shortenPath } from "../../util/paint.ts";
import { STAMP_ROW_RE } from "../../util/stamp.ts";
import { bashBackgrounded, bashPrograms } from "../../util/shell.ts";
import { workingLine } from "../hud/loader.ts";
import { attachmentPath } from "../../tools/attachments.ts";
import { parseBashResultMessage, parseBatchResultMessage } from "../tools/bash.ts";
import { bgSeqOf, evidenceSeq, highlightField } from "../tools/syntax.ts";
import { baseTone } from "../tools/gutter.ts";
import { parsePeerMessage, parseSubagentResultMessage, splitTrailer } from "../tools/subagent.ts";
import { parseBriefMessage } from "../tools/brief.ts";
import { parseInjectMessage } from "../tools/inject.ts";
import type { ParsedResultMessage } from "../tools/subagent.ts";
import { bumpCacheGen, compCache, getCacheGen } from "./flatten.ts";
import {
	MAX_TOOL_RESULT_LINES,
	buildChildComps,
	childEntriesToRawLines,
	pushText,
	readChildEntries,
	reconcileChildComps,
	runEntries,
	summarizeArgs,
} from "./runview.ts";
import type { ChildComps, RawLine, ThinkingView } from "./runview.ts";
import { clearFocusedRun, requestOpenRun, setFocusedRun, setOpenRunHook } from "./state.ts";
import { toolDefs } from "./toolmap.ts";
import { familyRuns, stationCollapsed, stationRuns } from "./station.ts";
import type { StationRow } from "./station.ts";

export const TAIL_CHILDREN = 5;
/**
 * Side pad — and the beat gutter. The state
 * glyph is painted INTO these two columns by the render loop (` ●` at
 * column 1), so content keeps exactly the x-position it had before the
 * beat redesign: the glyph lives in the margin, never appended to it.
 */
const PAD_X = 1;
/**
 * Tools that fold to the label alone. subagent's first output row is the
 * bare heading "Prompt", so showing "one line of output" showed nothing
 * useful. Its run tree stays visible because that lives in the call block.
 */
const LABEL_FOLD_TOOLS = new Set(["subagent", "agent"]);

/** The agent tool's tree shape belongs to the `run` action alone; every other action rests as a sentence. */
function labelFoldFor(toolName: string, args: unknown): boolean {
	if (!LABEL_FOLD_TOOLS.has(toolName)) return false;
	if (toolName !== "agent") return true;
	const a = (args as { action?: unknown })?.action;
	return a === undefined || a === "run";
}

/**
 * Model + thinking read from a run's own transcript, cached per run.
 *
 * The live session answers this while a run works, and settle() snapshots it
 * onto the manifest — but runs that finished BEFORE that snapshot existed
 * have neither, and their footer showed no model at all. The transcript
 * always knows: pi writes a model_change entry when the session starts.
 * Read once per run, then cached, so this never touches disk on a repaint.
 */
const modelCache = new Map<string, { model?: string; thinking?: string }>();
function modelFromTranscript(run: SubagentRunInfo): { model?: string; thinking?: string } {
	const hit = modelCache.get(run.id);
	if (hit) return hit;
	const out: { model?: string; thinking?: string } = {};
	try {
		for (const e of readChildEntries(run.sessionDir) as any[]) {
			if (e?.type === "model_change" && e.modelId) out.model = String(e.modelId);
			else if (e?.type === "thinking_level_change" && e.thinkingLevel) out.thinking = String(e.thinkingLevel);
		}
	} catch {}
	modelCache.set(run.id, out);
	return out;
}

/**
 * Shadow Markdown per prose child, for the `wdProse` colour (see
 * renderProseChild). Keyed weakly on pi's component; the shadow keeps
 * pi-tui's own width cache, so a repaint at the same text costs nothing.
 */
const proseShadow = new WeakMap<object, { md: InstanceType<typeof Markdown>; seq: string; theme: unknown }>();

const LIVE_CACHE_MS = 150;

/** How long the follow pin resists a shrink before re-pinning. */
// Recovery after a handoff dip was measured at ~400ms, and that was with
// renders throttled; a window only a little larger than the observation is
// how a hold ends up firing sometimes and not others.
const FOLLOW_HOLD_MS = 1500;
/** Extra rows snapshotted so a hold survives the viewport growing. */
const HOLD_MARGIN = 12;

/**
 * Layout trace, off unless PI_WARDOGS_TRACE names a file.
 *
 * The followed view is pinned to `total - body`, so a transient dip in
 * EITHER number scrolls the surface up and the next frame puts it back —
 * which is what a "flicker to the view above and back" actually is. This
 * records both per frame so the dip can be read off instead of guessed at.
 * Costs one env lookup per frame when disabled.
 */
const TRACE_PATH = process.env.PI_WARDOGS_TRACE;
let traceLast = "";
function trace(fields: Record<string, unknown>) {
	if (!TRACE_PATH) return;
	try {
		const line = Object.entries(fields)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		// Only transitions matter; a still surface would bury them.
		if (line === traceLast && !line.startsWith("ev=")) return;
		traceLast = line;
		fs.appendFileSync(TRACE_PATH, `${Date.now()} ${line}\n`);
	} catch {}
}
const collapseOverride = new Map<string, boolean>();
// Live (normal-looking) view by default; ctrl+r flips to raw source.
let liveMode = true;
const thinkState = new WeakMap<object, Map<number, { gen: number; val: boolean }>>();
let toolsExpandedAll = false;
let toolGen = 0;
const toolOverride = new WeakMap<object, { gen: number; val: boolean }>();
/**
 * Per-beat WIRE VIEW (2026-08-22, maintainer): the pretty surface hides the
 * model's bookkeeping (the trailing [timestamp: …] stamp, webfetch's head
 * line), and CTRL+CLICK on a beat flips it to the VERBATIM model-facing
 * text (the result's text blocks for a tool, the delivered message for a
 * background result, the submitted text for a prompt), stamps, run ids and
 * provenance lines included — ctrl+click again flips back. On a collapsed
 * act it expands straight into wire. Token-open keeps precedence: a
 * ctrl+click ON a path or URL still opens it. A panel in wire view says so
 * with a dim `· wire` on its head (a visible `raw`/`pretty` head-row
 * button was built and RETRACTED the same day — maintainer: looks weird).
 * Per beat and sticky — there is no global wire mode (ctrl+r's raw-source
 * view is the whole-surface escape hatch); the bit rides sigFor, so a
 * toggle re-renders through the cache like every fold. shift+click can
 * never serve here: the terminal keeps shift for native selection and the
 * report never reaches the pager (Known limitations).
 */
const wireView = new WeakMap<object, boolean>();
const wireOn = (c: object) => wireView.get(c) === true;
/**
 * Un-merged clusters, keyed by the cluster's FIRST member component
 * (stable: members only ever join at the tail). Clicking a cluster's
 * summary row un-merges it back into its beats — one-way; the individual
 * acts are already one-liners, so there is nothing to re-merge for.
 * clusterGen enters the flatten key so an un-merge invalidates the
 * assembled prefix (component signatures don't change on this click).
 */
/**
 * Blink marker (round 31): a cached glyph prefixed with this blinks at the
 * COMPOSITION layer — the render loop, which runs every frame, decides
 * glyph-or-blank at paint time. The cache itself stays phase-free: baking
 * Date.now() parity into cached renders is exactly the aliasing bug that
 * made the running ● never render (round 30 audit).
 */
const BLINK = "\x00b";

const clusterOpen = new WeakMap<object, { gen: number; val: boolean }>();
let clusterGen = 0;
/**
 * ctrl+o drives CLUSTERS too (round 29): expand-all opens every summary,
 * collapse-all folds them. Per-cluster clicks override the global until
 * the next ctrl+o (the generation invalidates them — the toolOverride
 * pattern).
 */
let clustersOpenAll = false;
let clusterAllGen = 0;
function clusterOpenState(key: object): boolean {
	const e = clusterOpen.get(key);
	return e && e.gen === clusterAllGen ? e.val : clustersOpenAll;
}
/**
 * Whether MAIN's agent loop is live — between agent_start and agent_settled
 * (round 23, the two experiences): while working, the machinery AFTER the
 * last user prompt stays UNCLUSTERED and leaks snippets; clustering happens
 * only once the final response has landed. Mirrored from events by mod.ts —
 * the flatten cannot see the loop directly. Child views read their run's
 * own status instead.
 */
let agentWorking = false;
/**
 * Whether the VIEWED run is working — the child view's counterpart of
 * agentWorking for the clock bucket in sigFor (2026-08-29: the bucket read
 * main's state, so a lead's view showed its workers' tree clocks frozen at
 * the first frame while main sat idle — the maintainer's "· 0s for ever").
 * Set per frame by render() from the run under view.
 */
let viewWorking = false;
export function setAgentWorking(v: boolean) {
	agentWorking = v;
}

/**
 * Stable identity for a component's PRE beat (round 26). A message with
 * leading thinking emits TWO beats; keying both on the component made the
 * prose beat overwrite the pre's row in beatRows, so collapse-return and
 * the fold flash landed on the wrong beat. The pre key is per-component
 * and weak, so it lives exactly as long as the component does.
 */
const preKeys = new WeakMap<object, object>();
function preKeyOf(sub: object): object {
	let k = preKeys.get(sub);
	if (!k) {
		k = {};
		preKeys.set(sub, k);
	}
	return k;
}

/** The tools whose sentences/soft-errors our grammar owns; everything else
 *  on the surface is an MCP-adapter (or foreign) tool. */
const GRAMMAR_TOOLS = new Set([
	"bash",
	"powershell",
	"read",
	"write",
	"edit",
	"webfetch",
	"kimi-websearch",
	"subagent",
	"agent",
	// pi's own foldable beats (see foldName): they are named acts too, so
	// the structural error sniff for FOREIGN tools must not run on them.
	"user-bash",
	"compaction",
	"branch",
	"skill",
]);

/**
 * The CANVAS act (dev/internals/README.md draft 6): a `write` whose path
 * resolves under `<cwd>/canvas/` is display-classed `canvas` — sentence
 * `created/revised canvas • <title from the filename>`, cluster `created
 * N canvases`, the full path and the stats row in its panel. Pure
 * renderer-side sugar keyed on the path: the model never knows, and a
 * miss is the plain write act. `revised` is NEIGHBOUR-DERIVED (an earlier
 * write-beat to the same path in this source view), so it is FIXED per
 * component at its first walk (a component always enters as the tail
 * once) and rides sigFor via canvasSig — the render cache stays coherent
 * under the fast path. The surface's canvasFirst map (keyed
 * `source|path`) holds each path's first writer; contentReplaced()
 * clears it (/tree, compaction).
 */
const canvasFlags = new WeakMap<object, boolean>();
const canvasSig = (sub: object): string => {
	const f = canvasFlags.get(sub);
	return f === undefined ? "" : f ? ":cv1" : ":cv0";
};
function canvasPathOf(args: unknown): string | null {
	const a = (args ?? {}) as Record<string, unknown>;
	const p = typeof a.file_path === "string" ? a.file_path : typeof a.path === "string" ? a.path : "";
	if (!p) return null;
	const root = path.resolve(process.cwd(), "canvas");
	const abs = path.resolve(process.cwd(), p);
	return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}
function canvasTitle(abs: string): string {
	const base = path.basename(abs);
	const stem = base.replace(/\.[^.]+$/, "");
	return (stem || base).replace(/[-_]+/g, " ").trim() || base;
}

/**
 * The act NAME for a foldable chat component — the one gate on the tool
 * branch of `renderSubFresh`/`sigFor`.
 *
 * LOAD-BEARING (round 31 audit): the branch used to be entered by the
 * `setExpanded`/`expanded` DUCK-TYPE alone, and four of pi's own components
 * answer that duck-type without being tools at all. `!command`
 * (BashExecutionComponent), `/compact` and `/tree` summaries and a skill
 * invocation therefore fell into a code path that reads
 * `toolName`/`args`/`result`/`isPartial`: their signature collapsed to the
 * constant `t0:0:0:0:0:0` (so the render cache served the FIRST frame for
 * the life of the session — a `!` command stayed empty forever), they had
 * no `actSentence` case, and they clustered as `called 1 mcp`. Naming them
 * here is what lets the branch be gated on a NAME and every non-tool
 * component be routed explicitly to the generic branch below it.
 */
function foldName(sub: any): string | undefined {
	if (typeof sub?.toolName === "string") return sub.toolName;
	if (sub instanceof BashExecutionComponent) return "user-bash";
	if (sub instanceof CompactionSummaryMessageComponent) return "compaction";
	if (sub instanceof BranchSummaryMessageComponent) return "branch";
	if (sub instanceof SkillInvocationMessageComponent) return "skill";
	return undefined;
}

/** Does this component fold as an ACT (the tool branch), rather than render flat? */
function isFoldableAct(sub: any): boolean {
	return typeof sub?.setExpanded === "function" && typeof sub?.expanded === "boolean" && foldName(sub) !== undefined;
}

/**
 * war-dogs' OWN delivered-result messages — a background subagent's answer
 * (`subagent-result`) and a background bash job's output (`bash-result`),
 * both sent as custom messages through `pi.sendMessage`. They are MACHINERY
 * and fold as an act of their own kind (maintainer: "the same as any other
 * tool"): one sentence at rest, the answer behind the fold, a 5-row snippet
 * inside the working window — the delivery itself starts or joins a turn, so
 * the model IS working when it lands — and a cluster verb of their own. pi's
 * CustomMessageComponent has no fold state of its own, so the pager keys the
 * toggle on the component like every tool (toolOverride) and reads the text
 * through the renderers' shared parsers.
 */
/**
 * The /ask command's display-only entry (tools/ask.ts). Machinery of the
 * USER's voice: it folds like an act — one line at rest, the answer
 * behind the fold — wears a bold `?` in the gutter (the prompt's colour;
 * asking is the user speaking, so the glyph persists like the ❯), and
 * clusters ONLY with other asks, the way pi's error turns keep their own
 * cluster (maintainer, 2026-08-24: "ask should never go into clustering
 * [with tools] — it has its own"). Duck-typed on the entry, not the
 * class: pi does not export CustomEntryComponent.
 */
interface AskEntryData {
	target?: string;
	q?: string;
	a?: string;
	err?: string;
	shared?: boolean;
}
function askEntryOf(sub: any): AskEntryData | undefined {
	if (typeof sub?.setExpanded !== "function") return undefined;
	const e = (sub as any).entry;
	return e && e.customType === "ask" ? ((e.data ?? {}) as AskEntryData) : undefined;
}

type OwnResultKind =
	| "agent-result"
	| "subagent-result"
	| "bash-result"
	| "background-results"
	| "peer-message"
	| "session-brief"
	| "inject";
/**
 * An IDLE-time delivery is a user-role message (tools/delivery.ts, the
 * delivery-turn rule): its provenance first line names the kind. Never a
 * prompt on this surface — the same act as the custom-message form.
 */
function deliveryKindOfUserText(text: unknown): OwnResultKind | undefined {
	if (typeof text !== "string") return undefined;
	const first = text.split("\n", 1)[0] ?? "";
	if (first.startsWith("[agent result, delivered by the agent tool")) return "agent-result";
	if (first.startsWith("[background results, ")) return "background-results";
	if (/^\[background (?:bash|powershell) result, delivered by the (?:bash|powershell) tool/.test(first))
		return "bash-result";
	// A peer session's message, and (2026-08-29) an agent of this session
	// messaging main over the local frame path — same shape, same act; the
	// agent form drew as a prompt box with its provenance line showing.
	if (
		first.startsWith("[message from session_") ||
		first.startsWith("[message from your user") ||
		first.startsWith("[message from agent_")
	)
		return "peer-message";
	return undefined;
}

/** The message a parser reads: the custom message itself, or a synthetic one over a delivery-shaped user message. */
function ownMessageOf(sub: any): any {
	if (sub instanceof CustomMessageComponent) return (sub as any).message;
	const kind = deliveryKindOfUserText((sub as any)?.text);
	return { customType: kind, content: [{ type: "text", text: String((sub as any)?.text ?? "") }] };
}

function ownResultKind(sub: any): OwnResultKind | undefined {
	if (sub instanceof UserMessageComponent) return deliveryKindOfUserText((sub as any)?.text);
	if (!(sub instanceof CustomMessageComponent)) return undefined;
	const t = String((sub as any)?.message?.customType ?? "");
	return t === "agent-result" ||
		t === "subagent-result" ||
		t === "bash-result" ||
		t === "background-results" ||
		t === "peer-message" ||
		t === "session-brief" ||
		t === "inject"
		? t
		: undefined;
}

/**
 * The verbatim MODEL-FACING text of a tool result or custom message — the
 * text blocks joined, exactly as convertToLlm hands them over. This is what
 * the per-beat wire view shows: for write/edit that is the confirmation
 * sentence, never the pretty diff; stamps, run ids and provenance lines
 * included. Empty when there is nothing textual (a pure-image result) —
 * which is also the gate for showing the wire control at all.
 */
function resultWireText(holder: any): string {
	const c = holder?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => String(b.text))
		.join("\n");
}

/**
 * PRETTY view: drop the trailing `[timestamp: …]` row from a tool's RENDERED
 * result rows. The stamp is the model's clock (util/stamp.ts) — the UI
 * shows relative times, so on screen it is noise (splitTrailer already
 * consumes it for the subagent family; this is the same subtraction for
 * every renderer that prints the result text verbatim: bash, MCP, errors,
 * pi's plain-Text fallback). TAIL-ANCHORED on purpose: the walk skips only
 * blanks and pi's own Took/Elapsed footer (bash renders it AFTER the result
 * text), so a stamp-shaped line INSIDE content — a log tail a command
 * happens to print — is never touched. The wire view shows the stamp again.
 */
function stripStampRows(rows: string[]): string[] {
	// Trailing METADATA rows, innermost first: the stamp, then a `[run id: …]`
	// (wire-only since 2026-08-22 — a bash receipt's id sits right above its
	// stamp). Each strip takes the blank run that separated it from the text.
	let out = rows;
	for (const re of [STAMP_ROW_RE, /^\[run id: [^\]]+\]$/]) {
		for (let i = out.length - 1; i >= 0; i--) {
			const vis = stripAnsi(out[i]).trim();
			if (!vis || /^(?:Took|Elapsed)\b/.test(vis)) continue;
			if (!re.test(vis)) break;
			out = out.slice(0, i).concat(out.slice(i + 1));
			let j = i - 1;
			while (j >= 0 && !stripAnsi(out[j] ?? "").trim()) out.splice(j--, 1);
			break;
		}
	}
	return out;
}

/**
 * pi's `(ctrl+o to expand)` / `(ctrl+o to collapse)` hints. Folding is
 * pager-owned and ctrl+o means expand/collapse ALL here, so the hint is a
 * lie wherever it lands — and it lands on OUTPUT rows too (pi's bash-mode
 * status row, a tool result's tail), which the old call-rows-only strip
 * never reached.
 *
 * The KEY is not hardcoded: pi builds the hint with `keyHint`, whose key
 * text comes from the user's keybindings (and is EMPTY when none are
 * loaded), so `ctrl\+o` matched neither a rebound key nor `( to collapse)`.
 * Anchored to the end of the row, which is where pi always puts it — that
 * anchor is what keeps prose like "(easy to expand)" out of the match.
 */
const CTRL_O_HINT = /\s*\(\s*(?:[A-Za-z0-9]+(?:[+/][A-Za-z0-9]+)*\s+)?to (?:expand|collapse)\)\s*$/;

/**
 * A cheap O(1) fingerprint of a string's TAIL, for render-cache signatures.
 *
 * Length alone cannot see an in-place rewrite that keeps the same size, and
 * hashing the whole string would be per-frame O(total) — exactly what the
 * prefix cache exists to avoid. The last 24 characters are where an edit
 * shows up in the components this signs (pi's status Text, a streaming
 * Markdown child).
 */
function endHash(s: string): number {
	let h = s.length;
	for (let i = Math.max(0, s.length - 24); i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

/**
 * pi's thinking RUNS for a message, built exactly the way
 * `AssistantMessageComponent.updateContent` builds them: blocks TRIMMED,
 * empties skipped, consecutive blocks joined with a blank line.
 */
function thinkingRuns(msg: any): string[] {
	const runs: string[] = [];
	let cur: string[] | null = null;
	for (const b of (Array.isArray(msg?.content) ? msg.content : []) as any[]) {
		if (b?.type === "thinking") {
			const t = typeof b.thinking === "string" ? b.thinking.trim() : "";
			if (t) (cur ??= []).push(t);
		} else if (cur) {
			runs.push(cur.join("\n\n"));
			cur = null;
		}
	}
	if (cur) runs.push(cur.join("\n\n"));
	return runs;
}

/**
 * Visual-only error detection for tools OUTSIDE our grammar (round 28,
 * maintainer: "structural, not per-tool"): the MCP adapter marks THROWN
 * errors as isError, but a payload-level failure arrives as a "successful"
 * result and rendered white. Conservative structural shapes only — a
 * leading Error line, or a JSON body whose TOP LEVEL says ok:false /
 * error / isError — never a substring scan (a file that merely contains
 * "Error" must not go red). Purely paint: the result the model sees is
 * untouched.
 */
function errorShapedResult(result: any): boolean {
	try {
		const t = ((result?.content ?? []) as any[])
			.filter((b) => b?.type === "text")
			.map((b) => String(b.text ?? ""))
			.join("\n")
			.trimStart();
		if (!t) return false;
		if (/^(?:###\s*)?error\b/i.test(t)) return true;
		if (t.startsWith("{") && t.length < 65536) {
			const o = JSON.parse(t);
			if (o && typeof o === "object" && !Array.isArray(o)) {
				if (o.ok === false || o.isError === true) return true;
				if ("error" in o && o.error) return true;
			}
		}
	} catch {}
	return false;
}

/**
 * pi-mcp-adapter's `formatJsonish` (tool-result-renderer.ts) MINUS its cut:
 * the pager rebuilds an MCP call's args block from the SOURCE args —
 * JSON.stringify(v, null, 2), a string arg re-parsed when it is JSON — in
 * full. The adapter's own renderer truncates at 1500 chars with `…`, which
 * is right for a scrollback card and wrong for evidence you opened to read
 * (maintainer, 2026-08-20: a long mcpScript's args were cut mid-line).
 */
function mcpJsonish(value: unknown): string {
	if (typeof value === "string") {
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * The MCP adapter's DIRECT tools are named `<server>_<tool>` (types.ts
 * formatToolName; `.` in a tool name becomes `_`) and registered with
 * `label: "MCP: <tool>"`; the pager's toolmap holds that definition, so the
 * name splits back into its parts. Returns undefined for anything that is
 * not a direct MCP tool.
 */
function mcpDirectParts(name: string): { tool: string; server: string } | undefined {
	try {
		const label = String((toolDefs.get(name) as any)?.label ?? "");
		if (!label.startsWith("MCP: ")) return undefined;
		const tool = label.slice(5).trim();
		if (!tool) return undefined;
		const suffix = `_${tool.replace(/\./g, "_")}`;
		const server = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
		return { tool, server };
	} catch {
		return undefined;
	}
}
function hasUsefulObjectContent(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

/** Is any run in this family still working — the root or any descendant? */
function subFamilyLive(id: string, depth = 0): boolean {
	if (depth > 6) return false;
	const r = registry.get(id)?.run ?? knownRuns.get(id);
	if (r?.status === "working" || r?.status === "queued") return true;
	return childrenOf(id).some((k) => k.status === "working" || k.status === "queued" || subFamilyLive(k.id, depth + 1));
}
export const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/**
 * Any-motion mouse reporting (1003+1006) — and AUTOWRAP OFF (DECAWM, ?7)
 * while the pager owns the screen. pi-tui UNDER-measures complex-script
 * graphemes (a Devanagari/Bengali base+matra clusters to width 1 while the
 * terminal draws the matra as its own spacing cell — [अंगिका] measures 5,
 * draws 7; [বিষ্ণুপ্রিয়া মণিপুরী] measures 11, draws 18), so a composited
 * row padded to width-1 by pi-tui's count can be DRAWN wider than the
 * terminal: autowrap then inserts a physical line break, the screen
 * scrolls, and pi-tui's diff model no longer matches reality — stale frame
 * fragments (a second title bar, banner shreds mid-panel) that persist
 * until a full repaint (demonstrated 2026-08-22 with the Wikipedia
 * language list, in VTE and reproduced in tmux). With autowrap off the
 * overwide row CLIPS at the last column instead — the benign, emoji-class
 * artifact (that row's tail and scrollbar cell overwritten). The measure
 * itself is unfixable from here (see the emoji ledger entry: correcting it
 * breaks compositing the other way). Restored with the mouse modes on
 * every exit path; stock pi never touches DECAWM, so `?7h` is always the
 * right restore.
 */
export const MOUSE_ENABLE = "\x1b[?1003h\x1b[?1006h\x1b[?7l";
export const MOUSE_DISABLE = "\x1b[?7h\x1b[?1006l\x1b[?1003l";
export const PGUP = /^\x1b\[(?:5(?:;\d+)?~|57421(?:;\d+)?u)$/;
export const PGDN = /^\x1b\[(?:6(?:;\d+)?~|57422(?:;\d+)?u)$/;
export const HOME = /^(?:\x1b\[(?:1(?:;\d+)?~|7~|H|57423(?:;\d+)?u)|\x1bOH)$/;
export const END = /^(?:\x1b\[(?:4~|8~|F|57424(?:;\d+)?u)|\x1bOF)$/;
// Exact ctrl modifier (CSI-u `;5`), not `;\d+`: the loose form matched EVERY
// modifier on o/r — shift+ctrl+o is pi's /tree filter cycle and reached the
// pager instead (demonstrated). BACK_KEY below already spells its modifier.
export const CTRL_O = /^(?:\x0f|\x1b\[111;5u)$/;
export const CTRL_R = /^(?:\x12|\x1b\[114;5u)$/;
export const STATION_KEY = /^(?:\x1bs|\x1b\[115;6u|\x1b\[27;6;115~)$/;
export const BACK_KEY = /^(?:\x13|\x1b\[115;5u|\x1b\[27;5;115~)$/;

export function buildRawLines(ctx: ExtensionContext): RawLine[] {
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.buildContextEntries();
	} catch {
		entries = [];
	}
	return entriesToRawLines(entries, "m");
}

function entriesToRawLines(entries: unknown[], idPrefix: string): RawLine[] {
	const lines: RawLine[] = [];
	let idx = 0;
	for (const entry of entries as any[]) {
		idx++;
		try {
			if (entry?.type !== "message" || !entry.message) continue;
			const m = entry.message;
			const entryId: string = `${idPrefix}:${String(entry.id ?? `e${idx}`)}`;
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
			if (m.role === "user") {
				lines.push({ text: "", kind: "plain" });
				lines.push({ text: "❯ you", kind: "user" });
				for (const b of content) {
					if (b.type === "text") pushText(lines, b.text, "plain");
					else if (b.type === "image") lines.push({ text: "[image]", kind: "dim" });
				}
			} else if (m.role === "assistant") {
				lines.push({ text: "", kind: "plain" });
				lines.push({ text: "✦ assistant", kind: "assistant" });
				let ti = 0;
				for (const b of content) {
					if (b.type === "text") pushText(lines, b.text, "plain");
					else if (b.type === "thinking") {
						ti++;
						const id = `${entryId}:think:${ti}`;
						const body = String(b.thinking ?? b.text ?? "");
						const n = srcLines(body);
						lines.push({
							text: `${isCollapsed(id) ? "▸" : "▾"} thinking · ${plural(n, "line")}`,
							kind: "dim",
							blockId: id,
						});
						if (!isCollapsed(id)) pushText(lines, body, "dim", id);
					} else if (b.type === "toolCall")
						lines.push({
							text: `⚙ ${b.name ?? b.toolName ?? "tool"} · ${summarizeArgs(b.arguments)}`,
							kind: "tool",
						});
				}
			} else if (m.role === "toolResult") {
				const id = `tr:${String(m.toolCallId ?? entryId)}`;
				const texts = content.filter((b: any) => b.type === "text").map((b: any) => String(b.text ?? ""));
				const body = texts.join("\n");
				const n = srcLines(body);
				const name = String(m.toolName ?? "tool");
				lines.push({
					text: `${isCollapsed(id) ? "▸" : "▾"} ${name} output · ${plural(n, "line")}`,
					kind: "tool",
					blockId: id,
				});
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
	if (!lines.length) lines.push({ text: "(empty session)", kind: "dim" });
	return lines;
}

/**
 * pi's root layout is not fixed: 0.83 mounts header, loaded-resources and
 * chat containers directly on the TUI; 0.84.2 wraps the three in one
 * `documentContainer` (a bare Container of bare Containers). The flatten reads
 * ONE level below each head kid, so on 0.84.2 it saw three Containers instead
 * of messages, signed them as generic ("p" — never changes) and froze the
 * surface on its first frame with no error anywhere. Expand such wrappers to
 * their children first. The test is CLASS IDENTITY, deliberately: message
 * components carry `.children` too, so "children of children" would flatten
 * messages into their parts; only a bare Container whose every child is a
 * bare Container is a wrapper. Anything pi ships in a shape neither rule
 * covers falls back to today's behaviour.
 */
function unwrapContainers(kids: any[]): any[] {
	const isBare = (c: any) => c?.constructor === Container && Array.isArray(c.children);
	const isWrapper = (c: any) => isBare(c) && c.children.length > 0 && c.children.every(isBare);
	let out = kids;
	for (let depth = 0; depth < 4 && out.some(isWrapper); depth++) {
		const next: any[] = [];
		for (const k of out) {
			if (isWrapper(k)) next.push(...k.children);
			else next.push(k);
		}
		out = next;
	}
	return out;
}

function pushAll<T>(dst: T[], src: T[]) {
	for (const x of src) dst.push(x);
}

function thinkIsExpanded(sub: object, ti: number): boolean {
	// ctrl+o reaches thinking too (round 29): expand-all opens the texts,
	// per-block clicks override until the next toggle-all (the toolOverride
	// generation pattern).
	const e = thinkState.get(sub)?.get(ti);
	return e && e.gen === toolGen ? e.val : toolsExpandedAll;
}

function thinkToggle(sub: object, ti: number) {
	let m = thinkState.get(sub);
	if (!m) {
		m = new Map();
		thinkState.set(sub, m);
	}
	m.set(ti, { gen: toolGen, val: !thinkIsExpanded(sub, ti) });
}

function pagerToolExpanded(comp: object): boolean {
	const o = toolOverride.get(comp);
	return o && o.gen === toolGen ? o.val : toolsExpandedAll;
}

interface LineRange {
	start: number;
	end: number;
	action: () => void;
	/** Optional content-col span: the click must land ON the text (round 6). */
	a?: number;
	b?: number;
	/** Fires on ctrl+click only (the wire view); invisible to plain clicks. */
	ctrl?: boolean;
}

export interface LocalRange {
	s: number;
	e: number;
	action: () => void;
	/** Optional content-col span: the click must land ON the text (round 6). */
	a?: number;
	b?: number;
	/** Fires on ctrl+click only (the wire view); invisible to plain clicks. */
	ctrl?: boolean;
}

export interface LocalBlock {
	s: number;
	e: number;
	src: string;
}

/** One component's flattened beat: display rows + interactivity + glyph seat. */
/** beatRows key of a standalone skill's synthesised prompt box (the skill component keys its own attached row). */
const skillBoxKeys = new WeakMap<object, object>();

interface RenderedBeat {
	lines: string[];
	ranges: LocalRange[];
	blocks: LocalBlock[];
	head?: { row: number; glyph: string };
	/** Fold handles: row (relative) + content-column span that highlights on hover. */
	handles?: { row: number; a: number; b: number }[];
	/** Informational beat: no side pad, text aligned with the glyph column. */
	flushLeft?: boolean;
	/** Beat kind (clustering eligibility and box/info handling). */
	kind?: "prose" | "act" | "open" | "info" | "box";
	/** An open panel's padding row (see flatten.ts CompCacheBeat.pad). */
	pad?: string;
	/**
	 * Extra gutter glyphs on rows WITHIN the beat — thinking's ●/─ marks
	 * live in the same column as every other indicator (round 4: the
	 * inline mark read as "indented").
	 */
	marks?: { row: number; glyph: string }[];
	/**
	 * Act metadata for CLUSTERING (refinement §6): settled successful acts
	 * merge into one summary beat at assembly; an error or a running act
	 * breaks the cluster and stays visible. Thinking carries its line count
	 * for the member label.
	 */
	act?: { tool: string; err: boolean; running: boolean; lines?: number };
	/**
	 * A voice message's machinery PRELUDE — its leading thinking, split out
	 * (round 24) so it clusters with the acts around it.
	 */
	pre?: RenderedBeat;
	/** Hover the beat's handle rows as ONE control (working thinking view). */
	groupHandles?: boolean;
}

interface SelPoint {
	idx: number;
	col: number;
}

/* --- module state carried over from the original pager --- */

export const isCollapsed = (id: string) => collapseOverride.get(id) ?? true;

let runsCache: { at: number; runs: SubagentRunInfo[] } | null = null;

/**
 * The session's run family, behind a 250ms cache. Called from titleBar()
 * on EVERY render; the filter itself is station.ts's familyRuns() (one
 * implementation, in-memory, no filesystem) — the cache only bounds how
 * often it re-runs per frame. Status flips show through the cache
 * immediately (shared run objects); only MEMBERSHIP lags ≤250ms.
 */
export function subagentRuns(): SubagentRunInfo[] {
	const now = Date.now();
	if (runsCache && now - runsCache.at < 250) return runsCache.runs;
	const family = familyRuns();
	runsCache = { at: now, runs: family };
	return family;
}

export class PagerComponent {
	private rawLines: RawLine[] = [];
	private rawWrapped: RawLine[] = [];
	private rawWrappedWidth = -1;
	private liveLines: string[] = [];
	private liveRanges: LineRange[] = [];
	private liveBlocks: { s: number; e: number; src: string }[] = [];
	private liveAt = 0;
	private liveWidth = -1;
	private liveSource = "main";
	/** Each canvas path's FIRST writer component, keyed `source|path` (the canvas act's created/revised). */
	private canvasFirst = new Map<string, object>();
	private liveDirty = true;
	private offset = 0;
	private follow = true;
	private lastBody = 10;
	private lastWidth = 80;
	private lastTotal = 0;
	/** The composited bottom UI of the last frame (the editor's rows among them), for ctrl+click on `[^image N]`. */
	private lastTailLines: string[] = [];
	/** An `[^image N]` ref in the input bar under the mouse — underlined like a link. */
	private tailRefHover: { row: number; a: number; b: number } | null = null;
	/** Measure the surface last laid content out at, for copy un-wrapping. */
	private lastContentW = 0;
	/** Reads the live editor buffer; wired by mod.ts, which owns ctx. */
	private editorTextFn?: () => string;
	/** When the follow pin first outran the content; 0 when pinned. */
	private followHoldAt = 0;
	/** Last drawn window, kept to ride out a handoff dip. */
	private holdWindow: string[] = [];
	/** Glyphs for the held window rows, parallel to holdWindow. */
	private holdHeads: (string | undefined)[] = [];
	/** Flush-left flags for the held window rows, parallel to holdWindow. */
	private holdFlush: boolean[] = [];
	/** Beat-glyph seat per absolute surface row; painted into the side pad. */
	private liveHeads = new Map<number, string>();
	/** Rows rendered without the side pad (informational beats). */
	private liveFlush = new Set<number>();
	/** Fold handles by absolute row: the TEXT span that highlights on hover. */
	private liveHandles = new Map<number, { a: number; b: number }>();
	/**
	 * Fold-handle ROWS currently under the mouse, if any. A row span, not a
	 * single row (round 26): a wrapped cluster header is ONE control, so
	 * hovering any of its rows lights all of them; each row lights its own
	 * text span from liveHandles.
	 */
	private hoverFold: { from: number; to: number } | null = null;
	/** Rows that hover as ONE control (wrapped cluster headers), by row. */
	private liveHandleGroup = new Map<number, { from: number; to: number }>();
	/**
	 * Flash (round 26): a set of rows inverts for ~½ s so the eye lands on
	 * them — the collapse-return (folding scrolled the view back to the
	 * beat's head row) and, since 2026-08-20, the SETTLE: the cluster headers
	 * the just-finished turn's machinery folded into (maintainer: "when the
	 * calls are clustered, the cluster highlights").
	 */
	private flashRow: { rows: Set<number>; until: number } | null = null;
	/** Armed by turnSettled(): the next flatten flashes the clusters it forms after the last prompt. */
	private settleFlash = false;
	private flashTimer: ReturnType<typeof setTimeout> | null = null;
	private flash(rows: Iterable<number>): void {
		const set = new Set(rows);
		if (!set.size) return;
		this.flashRow = { rows: set, until: Date.now() + 550 };
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flashRow = null;
			this.flashTimer = null;
			try {
				this.tui.requestRender();
			} catch {}
		}, 570);
		(this.flashTimer as { unref?: () => void }).unref?.();
	}
	private holdTotal = 0;
	/** Which list the child view's rows came from, for the trace. */
	private lastCacheN = 0;
	private lastLiveN = 0;
	private sbDragging = false;
	private surfaceIsLive = true;
	private jumpBtn: { row: number; c0: number; c1: number } | null = null;
	private pillHover = false;
	/** Hovered openable token: one segment per display row it spans (a wrapped URL underlines whole). */
	private hoverLink: { segs: { idx: number; a: number; b: number }[]; key: string } | null = null;
	// Station view: alt+s toggles it against main. It is NOT part of a
	// cycle — subagent transcripts are reached only by clicking a row.
	private station = false;
	private stationRows: StationRow[] = [];
	/** Parallel to the rendered display lines; null for decoration rows. */
	private stationDisplayRows: (StationRow | null)[] = [];
	private stationHover: number | null = null;
	/** The run whose FULL configuration is open (ctrl+hover; the arrow selection opens it too). */
	private stationDetail: number | null = null;
	/** A station press waiting to become a click — dropped the moment the drag starts. */
	private stationPendingClick: { row: number; col: number } | null = null;
	/** The station's last built display rows, the selection-copy source there. */
	private stationBuilt: string[] = [];
	private stationMaxW = 0;
	// Horizontal scroll, for families nested deeper than the screen is
	// wide. Depth is the horizontal axis and it is unbounded by design,
	// so this is the primary axis here, not an edge case.
	private hOffset = 0;
	private hDragging = false;
	// When set, the station shows only this run's subtree.
	private stationRoot: string | null = null;
	// `undefined` = never published. It must NOT start as null, or the
	// first publishView(null) short-circuits on the equality guard and
	// never clears a stale global left behind by a previous pager
	// instance — which is how typed input kept going to a subagent after
	// the view was gone.
	private viewPublished: string | null | undefined = undefined;
	/** Single reused component for the streaming assistant row. */
	// Clickable back segments on the run-view footer row.
	private backBtns: { c0: number; c1: number; target: string | null }[] = [];
	private backHover: number | null = null;
	// Subagent chat view: null = main, else the run id being viewed.
	private childView: string | null = null;
	private childCompCache = new Map<string, ChildComps>();
	private childTimer: ReturnType<typeof setInterval> | null = null;
	private childTimerMs = 0;
	/**
	 * Collapse returns to the beat (maintainer request): folding a panel from
	 * deep inside its output puts the beat's head row back at the screen row
	 * it was expanded from, instead of leaving the view stranded in unrelated
	 * scrollback. The expand click IS the sentence row, so its screen row at
	 * click time is the anchor.
	 */
	private beatRows = new Map<any, number>();
	/** How many rows the beat occupies from its beatRows start (the collapse-return flashes all of them). */
	private beatLens = new Map<any, number>();
	private collapseAnchor = new WeakMap<object, number>();
	private pendingScrollBeat: any = null;
	private lastClickScreenRow = 2;
	private selAnchor: SelPoint | null = null;
	private selHead: SelPoint | null = null;
	private selecting = false;
	private dragged = false;
	// The reading-surface containers detached from pi's root at open
	// time. Used to tell head from tail when rendering the live bottom
	// UI (see tailLines).
	private headSet: Set<any>;

	/**
	 * The SUBAGENT VIEW's own theme (visor — identity-blue canvas), fetched
	 * by mod.ts via ctx.ui.getTheme. Everything war-dogs paints (sentences,
	 * tiers, evidence fields, prompt box, frame tint, title) follows it in
	 * a child/station view; pi-rendered content (markdown prose, syntax)
	 * keeps pi's active theme — pi's components hold their own theme ref.
	 */
	private subTheme: Theme | null = null;
	setSubTheme(t: Theme | null) {
		this.subTheme = t;
	}

	/**
	 * The LIVE theme + visor, re-read once per frame: a /settings-driven theme
	 * change builds a new Theme object but never reaches the pager's
	 * invalidate on its own, so already-rendered history kept the OLD palette
	 * indefinitely (mixed-palette transcript until restart). A pointer compare
	 * per frame is free; on change everything cached with baked-in SGR is
	 * retired via invalidate().
	 */
	private themeSource?: () => { base: Theme | null; visor: Theme | null };
	setThemeSource(fn: () => { base: Theme | null; visor: Theme | null }) {
		this.themeSource = fn;
	}
	/**
	 * What the last sync saw, as a VALUE. `ctx.ui.theme` is pi's permanent
	 * module-level Proxy (README: "pi's `theme` is a LIVE PROXY"), so the
	 * old identity guard `src.base !== this.baseTheme` was dead — the object
	 * never changes, only what it resolves to — and the pager never learned
	 * a theme had been swapped (round 31 audit). One resolved sequence is
	 * enough to tell two palettes apart and costs one proxy read per frame.
	 */
	private themeProbe = "";
	private syncTheme() {
		try {
			const src = this.themeSource?.();
			if (!src?.base) return;
			const probe = `${(src.base as any).fg("accent", "\0")}${(src.base as any).fg("text", "\0")}`;
			if (probe === this.themeProbe && src.base === this.baseTheme) return;
			this.themeProbe = probe;
			this.baseTheme = src.base;
			if (src.visor) this.subTheme = src.visor;
			this.seqKey = "";
			this.invalidate();
		} catch {}
	}
	/** The theme for the CURRENT view: visor inside a run/station. */
	private get theme(): Theme {
		return (this.childView || this.stationRoot) && this.subTheme ? this.subTheme : this.baseTheme;
	}

	constructor(
		private tui: TUI,
		private baseTheme: Theme,
		private supplyRaw: () => RawLine[],
		private notify: (msg: string) => void,
		private headKids: any[],
	) {
		this.headSet = new Set(headKids);
		// Route cached run-row click ranges to THIS pager (see state.ts).
		setOpenRunHook((id) => this.openRun(id));
	}

	// Full refresh: content settled (message/tool finished). Only marks
	// the flatten dirty — the per-component cache is NOT cleared, because
	// sigFor() already detects every settle transition (isPartial flips,
	// content length grows) and clearing it costs ~2.7s per call on a
	// long transcript. See the compCache comment above.
	refresh() {
		this.rawWrappedWidth = -1;
		this.liveDirty = true;
		this.tui.requestRender();
	}

	// Content REPLACED, not grown or dipped: /tree navigation and compaction
	// swap the message list wholesale. A shrink from those looks exactly like
	// the streaming-handoff dip the follow-hold smooths (drop <= body), so
	// without this the removed messages stayed on screen for FOLLOW_HOLD_MS
	// plus poll granularity (~2.5s, traced: raw=23 total=31 drop=8 held=1).
	// Drop the hold so the new content applies on the next frame.
	contentReplaced() {
		this.followHoldAt = 0;
		this.holdTotal = 0;
		// /tree and compaction may remove a canvas path's first writer; the
		// map rebuilds from the surviving components on the next walk.
		this.canvasFirst.clear();
		this.refresh();
	}

	// The turn SETTLED — a shrink from here is the working window closing
	// (snippets vanish, the turn's machinery collapses into clusters), not
	// the streaming handoff dip the follow-hold exists to smooth. Without
	// this the settle collapse was held for FOLLOW_HOLD_MS and the view then
	// JUMPED (round 31 audit: ~1.5s frozen, then a shove). Mirrored from
	// mod.ts's agent_settled handler — the flatten cannot see the agent loop.
	// The hold itself is untouched: shortening FOLLOW_HOLD_MS would bring
	// back the flicker it was added for.
	turnSettled() {
		this.followHoldAt = 0;
		this.holdTotal = 0;
		// The settle is when the turn's machinery collapses into clusters:
		// flash the headers it folds into (consumed by the next flatten).
		this.settleFlash = true;
		this.refresh();
	}

	// Light refresh: streaming chunk — the always-fresh tail picks it
	// up; cached historical components are untouched.
	refreshLight() {
		this.liveDirty = true;
		this.tui.requestRender();
	}

	// Render the live bottom UI (status, widgets, editor incl. its
	// autocomplete popup, footer) — it is drawn INSIDE the overlay,
	// bottom-anchored, so pi's own layout shifts underneath are fully
	// covered and can't flicker through. The editor's cursor marker
	// passes through verbatim, so the hardware cursor stays correct.
	/**
	 * Breadcrumb + child-scoped stats, drawn INSTEAD of pi's own footer
	 * while a subagent chat view is open. Everything here belongs to the
	 * subagent: its model, its tokens, its cost, its context window —
	 * main's numbers would be actively misleading in this view.
	 */
	private runFooter(width: number, run: SubagentRunInfo): string {
		this.backBtns = [];
		// Walk up the parent chain so nested runs get the whole trail.
		const chain: SubagentRunInfo[] = [];
		const all = new Map(stationRuns().map((r) => [r.id, r]));
		let cur: SubagentRunInfo | undefined = all.get(run.parentId ?? "");
		let guard = 0;
		while (cur && guard++ < 32) {
			chain.unshift(cur);
			cur = all.get(cur.parentId ?? "");
		}

		// ---- right side first: the left side budgets around it ----
		const stat = (t: string) => this.fg("muted", t);
		let stats = "";
		let ctx = "";
		try {
			const s = statsFor(run.id);
			if (s) {
				const bits = [stat(`↑${fmtTokens(s.tokens?.input ?? 0)}`), stat(`↓${fmtTokens(s.tokens?.output ?? 0)}`)];
				const cr = s.tokens?.cacheRead ?? 0;
				const cw = s.tokens?.cacheWrite ?? 0;
				if (cr) bits.push(stat(`R${fmtTokens(cr)}`));
				if (cw) bits.push(stat(`W${fmtTokens(cw)}`));
				const prompt = (s.tokens?.input ?? 0) + cr + cw;
				if ((cr || cw) && prompt > 0) bits.push(stat(`CH${((cr / prompt) * 100).toFixed(1)}%`));
				if (s.cost) bits.push(this.fg("warning", `$${s.cost.toFixed(3)}`));
				stats = bits.join(" ");
				const cu = s.contextUsage;
				if (cu?.percent != null) {
					const p = cu.percent;
					ctx = this.fg(
						p > 90 ? "error" : p > 70 ? "warning" : this.viewAccent(),
						`${p.toFixed(1)}%/${fmtTokens(cu.contextWindow ?? 0)}`,
					);
				}
			}
		} catch {}
		// Live session while running, manifest snapshot once settled — a
		// finished run has no session left to ask, which is why this was blank.
		const model = (() => {
			try {
				const s = sessionFor(run.id);
				const fallback = s ? {} : modelFromTranscript(run);
				const id = s?.model?.id ?? run.model ?? fallback.model;
				const lvl = s?.thinkingLevel ?? run.thinking ?? fallback.thinking;
				if (!id) return "";
				return this.fg(this.viewAccent(), id) + (lvl ? this.fg("dim", ` • ${lvl}`) : "");
			} catch {
				return "";
			}
		})();
		const right = [stats, ctx, model].filter(Boolean).join(this.fg("dim", "  "));
		const rightW = visibleWidth(right);

		// ---- left side: main, then ancestors NEAREST first ----
		let left = "";
		let col = PAD_X;
		const accent = this.viewAccent();
		const addBtn = (label: string, target: string | null) => {
			const seg = ` ← ${label} `;
			const w = visibleWidth(seg);
			const hovered = this.backHover === this.backBtns.length;
			this.backBtns.push({ c0: col, c1: col + w, target });
			left += hovered ? invert(this.bold(this.fg(accent, seg))) : this.fg(accent, seg);
			col += w;
		};
		addBtn("main", null);
		// main is always reachable; the separator marks it as the fixed root.
		const sep = " │";
		left += this.fg("dim", sep);
		col += visibleWidth(sep);
		// Nearest ancestor first. A deep chain cannot fit, and the useful end
		// is the one next to you — dropping from the far end keeps "up one
		// level" always present.
		const budget = Math.max(0, width - rightW - PAD_X - 2);
		const near = [...chain].reverse();
		let shown = 0;
		for (const p of near) {
			const need = visibleWidth(` ← ${p.agent} `);
			if (col + need > budget) break;
			addBtn(p.agent, p.id);
			shown++;
		}
		if (shown < near.length) {
			const more = ` +${near.length - shown}`;
			left += this.fg("dim", more);
			col += visibleWidth(more);
		}

		// Measured from the rendered string, not from `col`. col starts at
		// PAD_X for the click hit-testing, and PAD_X was then subtracted a
		// second time here, so the right-hand group sat four columns shy of
		// the edge. Main's footer aligns to `width` exactly; this now matches.
		const gap = Math.max(1, width - visibleWidth(left) - rightW);
		return left + " ".repeat(gap) + right;
	}

	/**
	 * The run view's TRANSIENT NOTICE ("interrupted; it is idle…", "Opened
	 * link"). pi's `setStatus` statuses render on main's footer notice line
	 * (visual/hud/footer.ts), and a run view swaps that footer for its own —
	 * so every notice set from a run view was invisible (2026-08-29, the
	 * interrupt keys gave no visible feedback). The view refreshes on a timer
	 * while open, which is what retires the row after its time.
	 */
	private notice: { text: string; until: number } | null = null;
	setNotice(text: string, ms = 3000): void {
		this.notice = { text, until: Date.now() + ms };
		try {
			this.tui.requestRender();
		} catch {}
	}
	inChildView(): boolean {
		return !!this.childView;
	}
	private noticeLine(width: number): string[] {
		if (!this.notice) return [];
		if (Date.now() >= this.notice.until) {
			this.notice = null;
			return [];
		}
		return [ansiTruncate(` ${this.fg("dim", this.notice.text)}`, width, this.fg("dim", "..."))];
	}

	/**
	 * Working row for the run view — the subagent's own spinner and clock,
	 * not main's. Empty when the run is idle.
	 */
	private runWorkingLine(run: SubagentRunInfo): string[] {
		if (run.status !== "working") return [];
		// Elapsed for THIS turn, not since the run was first spawned.
		let from = run.startedAt;
		try {
			from = turnStartFor(run.id) ?? from;
		} catch {}
		// Reuse loader.ts's own working line so this is byte-identical to
		// main's — same grenade frames, same shimmering phrase, same clock.
		// Geometry: workingLine() carries a one-space lead (it mirrors main's
		// Loader paddingX); that column is sliced off here — and off main's
		// pi-rendered row in deindentWorkingRow — so the grenade touches the
		// terminal edge in the beat-glyph column (round 20).
		try {
			// Test the RESULT, not the function reference. `workingLine` is an
			// imported function and therefore always truthy; its impl is only
			// assigned by loader.enable(), so with `{"loader":false,"pager":true}`
			// it returns undefined and
			// `l.startsWith` threw once per frame for every running subagent
			// view. The local catch below happened to yield the right fallback,
			// so this was invisible: correct output, an exception per frame.
			const l = workingLine(from);
			if (l) return ["", l.startsWith(" ") ? l.slice(1) : l];
		} catch {}
		const secs = Math.max(0, Math.round((Date.now() - from) / 1000));
		const clock = fmtSecs(secs);
		return ["", `${this.beatGlyph("running")} ${this.fg("muted", "working")} ${this.fg("dim", clock)}`];
	}

	/**
	 * Queued-message indicator for the run view, byte-for-byte with main's:
	 * a "Steering: …" line per pending steer message and "Follow-up: …" per
	 * follow-up, read live from the run's own session. Empty when nothing is
	 * queued. This is what makes chatting with a subagent while it works read
	 * exactly like chatting with main.
	 */
	private runPendingLines(run: SubagentRunInfo): string[] {
		try {
			const s = sessionFor(run.id);
			if (!s) return [];
			const steering: readonly string[] = s.getSteeringMessages?.() ?? [];
			const followUp: readonly string[] = s.getFollowUpMessages?.() ?? [];
			if (!steering.length && !followUp.length) return [];
			const out: string[] = [""];
			for (const m of steering) out.push(` ${this.fg("dim", `Steering: ${sanitize(m).split("\n")[0]}`)}`);
			for (const m of followUp) out.push(` ${this.fg("dim", `Follow-up: ${sanitize(m).split("\n")[0]}`)}`);
			out.push(` ${this.fg("dim", "↳ alt+up to edit all queued messages")}`);
			return out;
		} catch {
			return [];
		}
	}

	/**
	 * Main's working row is rendered by pi's Loader with a one-space pad,
	 * parking the grenade one column right of the beat-glyph column. Slice
	 * that column off so the spinner touches the terminal edge like every
	 * other glyph (round 20). Detection: our own frame set right after a
	 * single leading space — no other tail row has that shape. The run
	 * view's working row is already zero-lead at source (runWorkingLine).
	 */
	private deindentWorkingRow(line: string): string {
		const plain = stripAnsi(line);
		return /^ [●◉✺✹✸✶] /.test(plain) ? sliceByColumn(line, 1, 100000, true) : line;
	}

	private tailLines(width: number, skipFooter = false, skipStatus = false): string[] {
		try {
			const lines: string[] = [];
			// Read the tail LIVE from pi's root each frame instead of using
			// refs captured at open time. setFooter() does removeChild +
			// DISPOSE + addChild (and /reload re-runs extensions, which does
			// exactly that), so a snapshot would keep rendering a disposed
			// component. The head containers are already spliced out of
			// tui.children; headSet only matters for the degenerate case
			// where there was nothing to detach.
			const all = ((this.tui as unknown as { children?: unknown[] }).children ?? []) as any[];
			const kids = all.filter((c) => !this.headSet.has(c));
			// In a subagent chat view the editor stays (that is how you talk
			// to it) but pi's footer is replaced by a run-scoped one, so drop
			// the last child — the footer is always the final root child.
			// In a run view the status row belongs to MAIN's agent, so it is
			// dropped along with main's footer; the run view draws its own.
			let use = kids;
			if (skipFooter && use.length > 1) use = use.slice(0, -1);
			if (skipStatus && use.length > 1) use = use.slice(1);
			for (const child of use) pushAll(lines, child?.render?.(width) ?? []);
			return lines;
		} catch {
			return [];
		}
	}

	viewHeight(): number {
		return this.tui?.terminal?.rows || 24;
	}

	/* ----- live view: flatten pi's real component tree ----- */

	/**
	 * Which children of an assistant component are THINKING. The old test
	 * matched a child against any thinking block by a 32-char text-prefix
	 * probe — so a reply that begins with the thinking's opening words (short
	 * thinking like "ready", or models drafting the reply inside thinking)
	 * classified the model's ANSWER as its inner voice: rendered as ◐
	 * thinking, duplicated, with no ● prose beat at all (reproduced byte-for-
	 * byte on a crafted session). pi builds ONE child per coalesced thinking
	 * RUN (consecutive blocks joined "\n\n"), so classify by exact text
	 * identity against the runs, in order, never more children than runs.
	 */
	/**
	 * Memo for thinkingChildSet (round 30): it joins every thinking block's
	 * text and compares against child texts — O(thinking chars) — and it is
	 * called from BOTH sigFor (per component, per flatten, per token event)
	 * and renderSubFresh. On a transcript with much thinking that was an
	 * O(total thinking) tax on every streamed token. The memo key is cheap
	 * length arithmetic; only a changed component recomputes.
	 */
	private thinkingChildSet(sub: any): Set<any> {
		const out = new Set<any>();
		try {
			const msg = sub?.lastMessage;
			const gcs = Array.isArray(sub?.contentContainer?.children) ? sub.contentContainer.children : null;
			if (!Array.isArray(msg?.content) || !gcs) return out;
			// STRUCTURAL classification (round 30, from pi's source): pi builds
			// each thinking run as the ONE Markdown child constructed with
			// defaultTextStyle {italic:true}; prose Markdown gets none
			// (assistant-message.js updateContent). The old exact-text match
			// raced pi's per-token child REBUILD and its TRIMMED run-joining —
			// a transient mismatch classified thinking as PROSE for a frame,
			// which was the maintainer's "expanded and recollapsed" flicker
			// (and, memoized, got stuck). The marker is race-free and O(kids).
			let sawMarker = false;
			for (const gc of gcs) {
				const style = (gc as any)?.defaultTextStyle;
				if (style && style.italic === true && typeof gc?.text === "string") {
					out.add(gc);
					sawMarker = true;
				}
			}
			const hasThinking = (msg.content as any[]).some(
				(b) => b?.type === "thinking" && String(b?.thinking ?? "").trim(),
			);
			if (sawMarker || !hasThinking) return out;
			// hideThinkingBlock: pi does NOT build a thinking Markdown at all —
			// it substitutes a plain `Text` carrying `hiddenThinkingLabel`
			// (assistant-message.js updateContent). That child has no
			// defaultTextStyle, so the structural marker cannot see it and the
			// classifier called it PROSE: the beat's ● landed on the
			// "Thinking..." label and the model's actual answer got no glyph
			// at all (round 31 audit, sess/think1.jsonl at width 120). Admit
			// the label rows themselves — one per thinking RUN, in order.
			if ((sub as any)?.hideThinkingBlock) {
				const label = String((sub as any).hiddenThinkingLabel ?? "Thinking...").trim();
				let li = 0;
				const nRuns = thinkingRuns(msg).length;
				for (const gc of gcs) {
					if (li >= nRuns) break;
					if ((gc as any)?.defaultTextStyle) continue;
					if (typeof gc?.text === "string" && stripAnsi(gc.text).trim() === label) {
						out.add(gc);
						li++;
					}
				}
				return out;
			}
			// FALLBACK (pi renamed defaultTextStyle): mirror updateContent's
			// EXACT run-building — blocks TRIMMED, empties skipped, a run per
			// consecutive stretch, joined "\n\n" — so equality cannot miss on
			// whitespace the way the old builder did.
			const runs = thinkingRuns(msg);
			let ri = 0;
			for (const gc of gcs) {
				if (ri >= runs.length) break;
				if (typeof gc?.text === "string" && gc.text === runs[ri]) {
					out.add(gc);
					ri++;
				}
			}
		} catch {}
		return out;
	}

	// State signature for a chat sub-component: when it changes, the
	// cached render is stale (tool expand flips, thinking folds, or the
	// component's content grew while streaming).
	private sigFor(sub: any): string {
		const gcs =
			sub?.lastMessage && Array.isArray(sub?.contentContainer?.children) ? sub.contentContainer.children : null;
		if (gcs) {
			// stopReason and errorMessage are part of the signature: the beat's
			// glyph (prose vs error red) and the thinking row's settle state
			// both depend on them — without them here, the frame cached at the
			// streaming handoff is served forever. hideThinkingBlock too: pi
			// flips it on live components when the setting changes, and the
			// flatten renders thinking itself, so the flip must invalidate.
			// CONTRACT (rounds 30-31): this branch carries NO clock, so nothing
			// time-varying may enter the assistant beat's cached RENDER. A
			// blink is expressed as the phase-free BLINK marker and decided at
			// COMPOSITION time — baking Date.now() parity here is exactly the
			// missing-glyph aliasing the audit demonstrated.
			// The content SHAPE too (round 31 audit): the thinking view flips
			// from a moving TAIL to a static HEAD the moment anything lands
			// after the thinking in the MESSAGE (`msgHasPostThink`), and a
			// toolCall block adds no child and no text — so the signature was
			// byte-identical across a render that changed completely, and the
			// cache served the tail view for the rest of the turn. One
			// character per block; O(blocks), no clock.
			const shape = ((sub.lastMessage?.content ?? []) as any[]).map((b) => String(b?.type ?? "?")[0]).join("");
			// …and a hash of the LAST child's tail. Length alone cannot see an
			// in-place rewrite that happens to keep the same size (probe C in
			// probes/surface.mjs); this is O(1) and, like everything else in
			// this branch, carries no clock.
			const last = gcs.length ? gcs[gcs.length - 1] : null;
			const tailH = typeof last?.text === "string" ? endHash(last.text) : 0;
			let sig = `a${gcs.length}:${String(sub.lastMessage?.stopReason ?? "")}:${sub.lastMessage?.errorMessage ? 1 : 0}:${sub.hideThinkingBlock ? 1 : 0}:${shape}:${tailH}:`;
			let len = 0;
			let ti = 0;
			const thinkSet = this.thinkingChildSet(sub);
			for (const gc of gcs) {
				if (typeof gc?.text === "string") len += gc.text.length;
				if (thinkSet.has(gc)) sig += thinkIsExpanded(sub, ti++) ? "1" : "0";
			}
			return `${sig}:${len}`;
		}
		if (isFoldableAct(sub)) {
			// Include the result TEXT length, not just the block count:
			// content.length is almost always 1, so a result whose text
			// changed in place would otherwise keep serving a stale
			// cached render now that the cache is never cleared.
			let rlen = 0;
			const rc = sub.result?.content;
			if (Array.isArray(rc)) for (const b of rc) if (typeof b?.text === "string") rlen += b.text.length;
			// A RUNNING tool animates (spinners, live elapsed, streaming
			// tails) without its content length changing, so bucket by time
			// while partial. Without this the cache serves a frozen frame to
			// any running tool that has fallen out of the always-fresh
			// streaming tail — which is exactly what happens with several
			// subagents in flight at once.
			const tick = sub.isPartial ? `:${Math.floor(Date.now() / 120)}` : "";
			// isError colours the glyph and outcome; the bash `description`
			// arg is the collapsed sentence — both must invalidate the cache.
			const dlen = typeof sub.args?.description === "string" ? sub.args.description.length : 0;
			// The subagent beat renders LIVE RUN STATE (tree glyphs, clocks,
			// children) that changes without the component changing — a
			// BACKGROUND call's tool result settles at launch, so nothing the
			// base signature sees ever moves again and the cache served the
			// launch frame forever (frozen ✳, stale clock, children never
			// appearing). Fold the run family's state in: status + direct-child
			// statuses + descendant count, plus a 1s clock bucket while
			// anything is live (the strip's ticker keeps frames coming; this
			// makes them see fresh state).
			let runSig = "";
			if (["subagent", "agent"].includes(String((sub as any).toolName ?? ""))) {
				const rid = (sub as any).result?.details?.runId;
				if (typeof rid === "string") {
					const root = registry.get(rid)?.run ?? knownRuns.get(rid);
					const kids = childrenOf(rid);
					let kidSig = "";
					for (const k of kids) kidSig += k.status[0];
					// The DEEP family, not direct kids only (round 30 audit): the
					// render keys the tree-vs-one-line choice on subFamilyLive,
					// so a grandchild settling must invalidate this cache too.
					// A background launch's RESTING row carries no clock (2026-08-20),
					// so its 1s bucket would only churn the cache; it still ticks
					// while the beat is open (the panel's tree shows the live
					// elapsed) or while the turn is working (the tree is the
					// snippet) — a baked clock must never freeze on screen.
					const famLive =
						subFamilyLive(rid) && (!root?.background || pagerToolExpanded(sub) || agentWorking || viewWorking);
					runSig = `:R${root?.status?.[0] ?? "?"}${kidSig}:${descendantCount(rid)}${famLive ? `:L${Math.floor(Date.now() / 1000)}` : ":S"}`;
				}
			}
			// pi's OWN foldables carry their state in their own fields, not in
			// `result`/`isPartial`/`args` — with none of those present every
			// one of them signed the constant `t0:0:0:0:0:0` and the cache
			// served their FIRST frame for the life of the session (round 31
			// audit: a `!command` beat rendered its opening border rule and
			// never showed a byte of output). All O(1): counts and lengths,
			// never the joined text.
			let ownSig = "";
			const kind = foldName(sub);
			if (kind === "user-bash") {
				const out = (sub as any).outputLines;
				const n = Array.isArray(out) ? out.length : 0;
				// The LAST line's length too: appendOutput() concatenates a
				// partial chunk onto it without growing the array.
				const tailLen = n ? String(out[n - 1] ?? "").length : 0;
				ownSig = `:b${String((sub as any).command ?? "").length}:${n}:${tailLen}:${String((sub as any).status ?? "")}:${(sub as any).exitCode ?? "-"}`;
				// While it runs, output arrives with no other state change.
				if ((sub as any).status === "running") ownSig += `:${Math.floor(Date.now() / 120)}`;
			} else if (kind === "compaction" || kind === "branch") {
				const m = (sub as any).message;
				ownSig = `:m${String(m?.summary ?? "").length}:${m?.tokensBefore ?? "-"}:${m?.branchPoint ?? "-"}`;
			} else if (kind === "skill") {
				const b = (sub as any).skillBlock;
				ownSig = `:k${String(b?.name ?? "")}:${String(b?.content ?? "").length}`;
			}
			return `t${pagerToolExpanded(sub) ? 1 : 0}:${sub.isPartial ? 1 : 0}:${sub.result?.isError ? 1 : 0}:${rc?.length ?? 0}:${rlen}:${dlen}${tick}${runSig}${ownSig}${canvasSig(sub)}:W${wireOn(sub) ? 1 : 0}`;
		}
		// A delivered result: its text never changes after delivery, so the
		// fold state IS its state (the snippet flag rides in the cache key —
		// and the wire bit, like every beat that can flip to wire view).
		if (ownResultKind(sub)) return `r${pagerToolExpanded(sub) ? 1 : 0}${wireOn(sub) ? "w" : ""}`;
		// An /ask entry: immutable once appended; fold state plus length.
		{
			const ae = askEntryOf(sub);
			if (ae) return `q${pagerToolExpanded(sub) ? 1 : 0}:${String(ae.a ?? ae.err ?? "").length}`;
		}
		// GENERIC components. A constant here is a FROZEN component: pi's
		// `showStatus()` keeps ONE Text in the chat container and mutates it
		// in place (setText) for every status it shows — the shift+tab
		// thinking cycle, "Tool output: expanded", a compaction report — so
		// the pager displayed the FIRST status of the session forever (round
		// 31 audit, probes/statustext.mjs). Content-aware and O(1): the
		// text's LENGTH plus a cheap hash of its tail, which is where an
		// in-place rewrite of the same length shows up.
		// A component of OURS that renders from state it reads at render time
		// — the HUD banner: session id and name — has no text to hash and
		// signed the constant `p` (2026-08-23: a /name never reached the
		// header). It states its own signature instead; O(1), no clock.
		if (typeof sub?.wdSignature === "function") {
			try {
				return `s${String(sub.wdSignature())}`;
			} catch {}
		}
		const txt =
			typeof sub?.text === "string" ? sub.text : typeof sub?.getText === "function" ? String(sub.getText() ?? "") : "";
		if (!txt) return "p";
		// The wire bit matters only for the user box among generics; carrying
		// it on every text-bearing generic is cheap and safe.
		return `p${txt.length}:${endHash(txt)}${wireOn(sub) ? ":W1" : ""}`;
	}

	/**
	 * Beat-head glyph: state lives in the gutter as COLOUR, and the fold
	 * state lives in it as SHAPE (maintainer's verdict): tools carry a
	 * triangle — `▶` collapsed, `▼` expanded (both width-1, VS16-free) —
	 * while prose keeps the dot only for its error state. Running blinks
	 * the collapsed triangle bright/dim in the theme's secondary hue.
	 */
	/**
	 * Beat-head glyph. Round 8's hot take: OTHER THAN THE MODEL'S PROSE
	 * (and the user's ❯) THERE IS NO GLYPH — the triangles are gone. The
	 * one exception is unfinished work, which shows a presence-blinking
	 * circle; errors read as red TEXT, not a red mark.
	 */
	private beatGlyph(state: "error" | "running" | "prose"): string {
		if (state === "running") {
			const paint = (t: string) => {
				try {
					return (this.theme as any).fg("wdCall", t) as string;
				} catch {
					return this.fg("toolOutput", t);
				}
			};
			// The blink lives at the COMPOSITION layer (round 31): the cache
			// stores this phase-free marker and the render loop alternates
			// glyph/blank per frame. Never bake Date.now() parity here — that
			// was the round-30 aliasing bug that made this glyph never render.
			return BLINK + paint("●");
		}
		if (state === "error") return this.fg("error", "●");
		return this.fg("text", "●");
	}

	/**
	 * The collapsed act's SENTENCE (refinement §2): verb-headed prose with
	 * the numbers folded in, present-tense while running, `undefined` for
	 * tools this grammar doesn't know (they keep their call line + ⎿).
	 * Facts come from args / result details / the tool's OWN stats row —
	 * never from wrapped display rows.
	 */
	private actSentence(
		tool: string,
		sub: any,
		partial: boolean,
		details: Record<string, unknown>,
		stats: string,
	): string | undefined {
		const args = ((sub as any).args ?? {}) as Record<string, unknown>;
		const p = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const short = p ? shortenPath(p, process.cwd()) : "…";
		if (tool === "agent" && typeof args.action === "string" && args.action !== "run") {
			// The non-run actions rest as sentences; `run` takes the tree
			// shape (labelFoldFor) and never reaches here.
			const ids = Array.isArray(args.to) ? (args.to as string[]) : typeof args.to === "string" ? [args.to] : [];
			const named = ids.length === 1 ? knownRuns.get(ids[0]) : undefined;
			// Never "messaged 0 agents": a call whose args died mid-stream has
			// no `to` (stress audit, the (b) verdict) — name the absence.
			const who = named
				? `${named.agent} • ${named.title}`
				: ids.length === 1
					? ids[0]
					: ids.length === 0
						? "(no agent named)"
						: plural(ids.length, "agent");
			switch (args.action) {
				case "message":
					return `${partial ? "messaging" : "messaged"} ${who}`;
				case "ask":
					return `${partial ? "asking" : "asked"} ${who}`;
				case "wait":
					return partial
						? `holding for ${plural(Math.max(1, ids.length), "reply")}`
						: `held for ${plural(Math.max(1, ids.length), "reply")}`;
				case "status":
					// A bare status reports every working agent (tools/agent.ts).
					return `${partial ? "checking" : "checked"} ${ids.length === 0 ? "all agents" : who}`;
				case "stop":
					return `${partial ? "stopping" : "stopped"} ${who}`;
				case "list":
					return partial ? "listing agents" : "listed agents";
			}
		}
		if (tool === "bash" || tool === "powershell") {
			// Round 28 (maintainer): never COUNT commands — heredoc bodies once
			// split into absurd tallies ("ran 107 commands"). The noun is plain
			// `bash`; the detail is the model's own description, else the
			// derived program list (the verb phrase stays OURS so a "Bash …"
			// description can't reintroduce the name-stutter).
			const d = typeof args.description === "string" ? args.description.trim() : "";
			const progs = bashPrograms(typeof args.command === "string" ? args.command : "");
			const listed = progs.slice(0, 4).join(", ") + (progs.length > 4 ? ", …" : "");
			const detail = d || listed;
			// A command backgrounded with a trailing `&` returns at once and its
			// output never comes back (pi's bash has no background mode) — say so.
			const bg =
				args.background === true ||
				(tool === "bash" && bashBackgrounded(typeof args.command === "string" ? args.command : ""))
					? " in the background"
					: "";
			return `${partial ? "executing" : "executed"} ${tool}${bg}${detail ? ` • ${detail}` : ""}`;
		}
		if (tool === "user-bash") {
			// The `!command` beat is the USER's shell, not the model's tool
			// call, so it gets its own verb (`ran`, matching the cluster's
			// `ran N commands`) and reads its facts off the component: pi's
			// BashExecutionComponent has no args/result at all. Same rule as
			// bash — the derivation must not INVENT a noun, so an unparseable
			// command rests as the bare `command` (util/shell.ts).
			const progs = bashPrograms(typeof sub.command === "string" ? sub.command : "");
			const listed = progs.slice(0, 4).join(", ") + (progs.length > 4 ? ", …" : "");
			const detail = listed || "command";
			const st = String(sub.status ?? "");
			if (st === "running") return `running ${detail}`;
			if (st === "cancelled") return `cancelled ${detail}`;
			return `ran ${detail}`;
		}
		if (tool === "compaction") {
			// /compact and auto-compaction. The informative line is the token
			// count pi puts on its collapsed row — keep it IN the sentence,
			// which is all that rests on the surface.
			const n = Number(sub.message?.tokensBefore);
			return Number.isFinite(n) && n > 0 ? `compacted ${fmtTokens(n)} tokens of context` : "compacted the context";
		}
		if (tool === "branch") {
			const at = Number(sub.message?.branchPoint);
			return Number.isFinite(at) ? `branched at message ${at}` : "branched the conversation";
		}
		if (tool === "skill") {
			const name = typeof sub.skillBlock?.name === "string" ? sub.skillBlock.name.trim() : "";
			return name ? `used skill ${name}` : "used a skill";
		}
		if (tool === "read") {
			if (partial) return `reading ${short}`;
			const m = /^Read (\d+)(?: of (\d+))? lines?/.exec(stats);
			if (m)
				return m[2] ? `read ${short} (${m[1]} of ${m[2]} lines)` : `read ${short} (${plural(Number(m[1]), "line")})`;
			if (/^Read image/.test(stats)) return `read ${short} (image)`;
			return `read ${short}`;
		}
		if (tool === "write") {
			// A write under <cwd>/canvas/ is the CANVAS act: the sentence
			// carries the deliverable's title (the filename), the panel the
			// path and size (canvasPathOf / canvasFlags above).
			const cp = canvasPathOf(args);
			if (cp) {
				const revised = canvasFlags.get(sub) === true;
				const verb = partial ? (revised ? "revising" : "creating") : revised ? "revised" : "created";
				return `${verb} canvas • ${canvasTitle(cp)}`;
			}
			if (partial) return `writing ${short}`;
			const m = /^Wrote (\d+) lines?/.exec(stats);
			return m ? `wrote ${plural(Number(m[1]), "line")} to ${short}` : `wrote ${short}`;
		}
		if (tool === "edit") {
			if (partial) return `editing ${short}`;
			const m = /^Added (\d+) lines?, removed (\d+) lines?/.exec(stats);
			return m ? `edited ${short} (+${m[1]} −${m[2]})` : `edited ${short}`;
		}
		if (tool === "webfetch") {
			let host = "";
			try {
				host = new URL(String(args.url ?? "")).host;
			} catch {}
			const target = host || "the web";
			if (partial) return `fetching ${target}`;
			if (details.scout === true) {
				const n = Array.isArray(details.results) ? details.results.length : 0;
				return `scouted ${n} URL${n === 1 ? "" : "s"} for ${target}`;
			}
			if (typeof details.status === "string") {
				const tok =
					typeof details.contentChars === "number" && details.contentChars > 0
						? ` · ~${fmtTokens(Math.round((details.contentChars as number) / 4))} tokens`
						: "";
				return `fetched ${target} — ${details.status}${tok}${details.truncated ? " · truncated" : ""}`;
			}
			return `fetched ${target}`;
		}
		if (tool === "kimi-websearch") {
			const q = typeof args.query === "string" && args.query.trim() ? `"${args.query.trim()}"` : "the web";
			if (partial) return `searching ${q}`;
			if (typeof details.returned === "number") {
				const total = typeof details.total === "number" ? details.total : (details.returned as number);
				return `searched ${q} — ${details.returned} of ${total} result${total === 1 ? "" : "s"}`;
			}
			return `searched ${q}`;
		}
		if (tool === "mcp") {
			// The adapter's gateway tool. Its own call line reads `mcp call x @ y`
			// / `mcp search q` / `mcp status` (pi-mcp-adapter
			// tool-result-renderer.ts formatMcpProxyToolCallLines) — noun first,
			// which is not this grammar's verb-headed sentence (maintainer:
			// "calling/called mcp …"). Facts come from the call's args, one case
			// per shape the adapter itself distinguishes; the args JSON stays
			// behind the fold as evidence, since unlike webfetch's url it does not
			// restate the sentence.
			const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
			const at = str(args.server) ? ` @ ${str(args.server)}` : "";
			const v = (ing: string, ed: string) => (partial ? ing : ed);
			if (str(args.tool)) return `${v("calling", "called")} mcp ${str(args.tool)}${at}`;
			if (str(args.connect)) return `${v("connecting", "connected")} mcp ${str(args.connect)}`;
			if (str(args.describe)) return `${v("describing", "described")} mcp ${str(args.describe)}`;
			if (str(args.search)) return `${v("searching", "searched")} mcp "${str(args.search)}"${at}`;
			if (str(args.action)) return `${v("running", "ran")} mcp ${str(args.action)}${at}`;
			if (at) return `${v("listing", "listed")} mcp ${str(args.server)}`;
			return `${v("checking", "checked")} mcp status`;
		}
		if (tool === "mcpscript") {
			// The adapter's script tool: the model hands it JavaScript (`code`)
			// that calls MCP tools in a loop. The sentence counts the script's
			// lines (numbers live in the sentence); the code itself is the
			// evidence, highlighted as JavaScript (2026-08-20, maintainer:
			// "why there's no verb-ing" — it rested as the adapter's raw card).
			const code = typeof args.code === "string" ? args.code : "";
			const n = code.trim() ? srcLines(code.replace(/\s+$/, "")) : 0;
			return `${partial ? "running" : "ran"} mcp script${n ? ` (${plural(n, "line")})` : ""}`;
		}
		{
			// The adapter's PER-SERVER gateway (`mcp__<server>`, pi-mcp-adapter
			// types.js; 2026-08-29, the real-model MCP drive): the tool is in the
			// args like the plain gateway's, the server is the name's suffix. It
			// read `called mcp playwright @ mcp_` through the direct-tool split.
			const tn = String((sub as any).toolName ?? "");
			if (/^mcp__[^_]/.test(tn) && !tn.slice(5).includes("__")) {
				const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
				const server = str(args.server) || tn.slice(5);
				const called = str(args.tool);
				if (called) return `${partial ? "calling" : "called"} mcp ${called} @ ${server}`;
				return `${partial ? "listing" : "listed"} mcp ${server}`;
			}
			// A DIRECT MCP tool (`<server>_<tool>`): the same sentence the
			// gateway's `tool` call gets — `called mcp browser_tabs @ playwright`
			// — the facts from the definition's label (the tool's real name)
			// and, once the result is in, the adapter's own details.
			const direct = mcpDirectParts(tn);
			if (direct) {
				const server =
					typeof details.server === "string" && details.server.trim() ? details.server.trim() : direct.server;
				const toolName = typeof details.tool === "string" && details.tool.trim() ? details.tool.trim() : direct.tool;
				return `${partial ? "calling" : "called"} mcp ${toolName}${server ? ` @ ${server}` : ""}`;
			}
		}
		return undefined;
	}

	/**
	 * A row that counts as blank for beat trimming. Background-painted
	 * "blank" rows are NOT blank — they are a box's interior padding (the
	 * user prompt's breathing room), and trimming them collapses the box
	 * onto its text.
	 */
	private static isBlankRow(row: string): boolean {
		return !stripAnsi(row).trim() && !leadingBg(row);
	}

	/**
	 * Drop pi's `(ctrl+o to expand)` / `(Ctrl+O to collapse)` hints from
	 * rendered rows — CALL rows and OUTPUT rows alike.
	 *
	 * Matched on the row's VISIBLE text and cut by COLUMN, because pi builds
	 * the hint out of three separately-coloured pieces (`keyHint`: a muted
	 * `(`, the key in its own colour, a muted `)`), so the plain-string
	 * replace the call rows used could never see it — that is how
	 * `(ctrl+o to collapse)` kept leaking into open panels. A row that is
	 * NOTHING but the hint goes entirely.
	 */
	private static stripHints(rows: string[]): string[] {
		const out: string[] = [];
		for (const r of rows) {
			const plain = stripAnsi(r);
			const m = CTRL_O_HINT.exec(plain);
			if (!m) {
				out.push(r);
				continue;
			}
			const col = visibleWidth(plain.slice(0, m.index).replace(/\s+$/, ""));
			if (col > 0) out.push(sliceByColumn(r, 0, col, false));
		}
		return out;
	}

	/**
	 * Close a beat: trim its leading/trailing blank rows, push it onto the
	 * surface untouched (the glyph is painted into the side pad by the
	 * render loop, so content keeps its x-position), and remap the
	 * beat-local ranges/blocks/handles. Returns the surface row that should
	 * carry the glyph (undefined when the beat produced nothing / wants
	 * none) plus the remapped hover-handle rows.
	 */
	/** The `❯` of a prompt box: `wdPrompt`, caught fallback to accent. */
	private promptMark(s: string): string {
		try {
			return (this.theme as any).fg("wdPrompt", s) as string;
		} catch {
			return this.fg("accent", s);
		}
	}

	/** One row of a prompt box: `userMessageText` on `userMessageBg`, one space in. */
	private promptBoxRow(s: string): string {
		try {
			return (this.theme as any).bg("userMessageBg", ` ${this.fg("userMessageText", s)}`) as string;
		} catch {
			return ` ${s}`;
		}
	}

	/**
	 * The prompt box of a STANDALONE skill invocation (maintainer,
	 * 2026-08-23: every skill invocation is a prompt). pi builds a user
	 * component only for words after the block — a bare `/skill:name` has
	 * none (war-dogs' stamp is "words" to pi, so one exists carrying the
	 * stamp alone; an unstamped transcript has none at all) — so the box is
	 * built here from the skill itself, reading the invocation the user
	 * typed, in the user box's exact shape: pad, words, pad, the ❯ on the
	 * words row. No wire of its own — the attached `[skill]` row carries the
	 * block's wire; the stamp-only user component, when present, is what a
	 * wire would show, and emitSub skips it.
	 */
	private skillBox(sk: any, width: number): RenderedBeat {
		const lines: string[] = [];
		const ranges: LocalRange[] = [];
		const blocks: LocalBlock[] = [];
		const name = String((sk as any)?.skillBlock?.name ?? "").trim();
		const body: string[] = [this.promptBoxRow("")];
		for (const wl of wrapPlain(`/skill:${name}`, Math.max(4, width - 2))) body.push(this.promptBoxRow(wl));
		body.push(this.promptBoxRow(""));
		const flushed = this.flushBeat(lines, ranges, blocks, body, [], [], 1);
		return {
			lines,
			ranges,
			blocks,
			head: flushed.head === undefined ? undefined : { row: flushed.head, glyph: this.bold(this.promptMark("❯")) },
			kind: "box",
		};
	}

	private flushBeat(
		lines: string[],
		ranges: LocalRange[],
		blocks: LocalBlock[],
		body: string[],
		bodyRanges: LocalRange[],
		bodyBlocks: LocalBlock[],
		glyphAt: number | undefined,
		bodyHandles: { row: number; a: number; b: number }[] = [],
		bodyMarks: { row: number; glyph: string }[] = [],
	): {
		head?: number;
		handles: { row: number; a: number; b: number }[];
		marks: { row: number; glyph: string }[];
	} {
		let lead = 0;
		let end = body.length;
		while (lead < end && PagerComponent.isBlankRow(body[lead])) lead++;
		while (end > lead && PagerComponent.isBlankRow(body[end - 1])) end--;
		if (lead >= end) return { handles: [], marks: [] };
		const base = lines.length;
		for (let i = lead; i < end; i++) lines.push(body[i]);
		for (const r of bodyRanges) {
			const s = Math.max(r.s, lead) - lead + base;
			const e = Math.min(r.e, end) - lead + base;
			if (e > s) ranges.push({ s, e, action: r.action, a: r.a, b: r.b, ctrl: r.ctrl });
		}
		for (const b of bodyBlocks) {
			const s = Math.max(b.s, lead) - lead + base;
			const e = Math.min(b.e, end) - lead + base;
			if (e > s) blocks.push({ s, e, src: b.src });
		}
		const handles: { row: number; a: number; b: number }[] = [];
		for (const h of bodyHandles) if (h.row >= lead && h.row < end) handles.push({ ...h, row: base + h.row - lead });
		const marks: { row: number; glyph: string }[] = [];
		for (const m of bodyMarks) if (m.row >= lead && m.row < end) marks.push({ ...m, row: base + m.row - lead });
		const head = glyphAt === undefined ? undefined : base + Math.min(Math.max(glyphAt, lead), end - 1) - lead;
		return { head, handles, marks };
	}

	/**
	 * The model's PROSE, painted in the theme's `wdProse` colour.
	 *
	 * pi's markdown theme has no body-text painter (theme.js getMarkdownTheme:
	 * heading, link, code, quote, bullet… — no paragraph), and pi builds the
	 * prose Markdown with no `defaultTextStyle`, so a paragraph reaches the
	 * screen with NO foreground at all: it is the terminal's default colour,
	 * whatever that is, beside headings in `mdHeading` and code in `mdCode`
	 * (demonstrated: an ivory `text` var changed nothing on a prose row; the
	 * captured row carried no fg SGR). The theme's `text` never touched it. So
	 * a theme that sets `wdProse` (a war-dogs-only key; `""` = terminal default,
	 * the shipped value) has its prose rendered through a SHADOW Markdown —
	 * same text, padding, markdown theme and options as pi's component, plus a
	 * `defaultTextStyle` colour, exactly how pi paints thinking in
	 * `thinkingText`. pi's own component is never mutated and never invalidated,
	 * so nothing of this can reach the off state (pi renders its own component
	 * there); with no `wdProse`, or a stock theme without the key, this is
	 * `gc.render(width)` unchanged.
	 */
	private renderProseChild(gc: any, width: number): string[] {
		if (!(gc instanceof Markdown) || typeof (gc as any).text !== "string") return gc?.render?.(width) ?? [];
		// Underline OFF everywhere in prose (maintainer, 2026-08-20): pi-tui
		// underlines every markdown link (and H1); with the terminal's own
		// URL-hover underline on top that read as a double line. Colour keeps
		// the link; the hover underline (ours or the terminal's) is the cue.
		// PARAM-LEVEL, not a literal `\x1b[4m` replace: pi-tui's wrap re-opens
		// carried state on continuation rows as ONE merged SGR (`4;38;2;…m`),
		// so the literal strip cleaned a wrapped link's first row and left
		// every continuation underlined (demonstrated 2026-08-20 — and tmux
		// re-emits the attribute as a bare `4m`, which hid the mechanism).
		// Code fences render as pi draws them — the literal ``` rows (the
		// boxed form was tried 2026-08-20 and reverted the same day by the
		// maintainer: reflowing a wide block inside rails changed the code's
		// own line layout; the plain fence is honest).
		return this.paintHeadings(this.renderProseRows(gc, width), String((gc as any).text), width).map((r) =>
			PagerComponent.stripUnderline(r),
		);
	}

	/** Remove the underline attribute from every SGR in the row (4, 4:x, 21, 24), other params kept. */
	private static stripUnderline(row: string): string {
		if (!/\x1b\[[0-9;:]*m/.test(row)) return row;
		return row.replace(/\x1b\[([0-9;:]*)m/g, (m, params: string) => {
			if (!/(?:^|;)(?:4(?::[0-9]+)?|21|24)(?:;|$)/.test(params)) return m;
			const kept = params.split(";").filter((p) => !/^(?:4(?::[0-9]+)?|21|24)$/.test(p));
			return kept.length ? `\x1b[${kept.join(";")}m` : "";
		});
	}

	/**
	 * Headings by LEVEL (2026-08-20, maintainer: "a little bit of colour, at
	 * least for heading — blue, a different blue per level, semantically
	 * right"). pi-tui paints every heading with ONE `mdHeading` style (H1 also
	 * underlined, H2 bold, H3+ keep their `### `), and its theme table never
	 * learns the level — so the level is recovered here: the source's heading
	 * lines, in order, outside fenced code, against the rendered rows that
	 * OPEN with the `mdHeading` sequence (prose never does; a heading's
	 * continuation rows — a wrapped long heading — follow it without a blank
	 * and are folded into it). One-to-one, or nothing is touched: a miscount
	 * (a setext `===` heading, a wrap pi-tui styled differently) leaves pi's
	 * single colour rather than risk painting the wrong row. The `mdHeading`
	 * sequence is replaced everywhere on the row (inline pieces re-open it)
	 * by `wdHeading1`/`wdHeading2`/`wdHeading3` (3 and deeper); a theme
	 * without the keys keeps `mdHeading` for every level. Colour is the ONLY
	 * mark since 2026-08-20 (maintainer: "differentiated by color, that's
	 * it"): the `###` prefix pi-tui renders for H3+ is stripped, and H1's
	 * underline goes; the bold stays.
	 */
	private paintHeadings(rows: string[], text: string, width: number): string[] {
		const t = this.theme as any;
		const seqOf = (k: string): string => {
			try {
				return (t.fg(k, "\0") as string).split("\0")[0];
			} catch {
				return "";
			}
		};
		const head = seqOf("mdHeading");
		if (!head || !rows.length) return rows;
		// Six levels (maintainer, 2026-08-20: "I still can't differ 4-6") — a
		// lightness ramp, deepest darkest; a missing key falls back shallower.
		const lv: string[] = [];
		for (let li = 1; li <= 6; li++) lv.push(seqOf(`wdHeading${li}`) || lv[li - 2] || "");
		// The LEVEL MARK (2026-08-22, maintainer: "math power/superscript
		// alongside the heading, uniform colour"): when the theme gives
		// `wdHeadingMark` a colour, the heading's level rides as a superscript
		// digit (¹ … ⁶, width-1 glyphs, no variation selectors) after its last
		// row, in that colour — so every level can wear ONE hue and still
		// read. Absent or "", no mark (the ramp look). A theme may set the
		// mark and leave every wdHeadingN equal to mdHeading: the pass then
		// still runs (it used to bail on "nothing to repaint", which left
		// pi's ### prefixes in).
		const markSeq = seqOf("wdHeadingMark");
		const mark = /\x1b\[(?:38;|3[0-7]m|9[0-7]m)/.test(markSeq) ? markSeq : "";
		if (!mark && !lv.some((x) => x && x !== head)) return rows;
		// Source headings, in order, skipping fenced code.
		const levels: number[] = [];
		let fence: string | null = null;
		for (const line of text.split("\n")) {
			const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (f) {
				if (!fence) fence = f[1][0];
				else if (f[1][0] === fence) fence = null;
				continue;
			}
			if (fence) continue;
			const m = /^\s{0,3}(#{1,6})\s+\S/.exec(line);
			if (m) levels.push(m[1].length);
		}
		if (!levels.length) return rows;
		// Rendered heading groups: rows opening with the heading sequence, a
		// run of them (no blank between) being one heading.
		const groups: number[][] = [];
		let prev = -2;
		rows.forEach((row, i) => {
			const body = row.replace(/^ +/, "");
			if (!body.startsWith(head)) return;
			// BOLD is part of the heading's signature: a LINK row opens with
			// mdLink's colour, which a theme may map to the same hex as
			// mdHeading (canopy does — both blueBright), and colour alone then
			// counted URLs as headings, mismatched the source count and bailed
			// the whole pass (demonstrated 2026-08-20: a prose URL turned every
			// heading back to plain mdHeading with its ### restored).
			const lead = (/^(?:\x1b\[[0-9;]*m)+/.exec(body) ?? [""])[0];
			if (!/\x1b\[1(?:;|m)/.test(lead)) return;
			if (i === prev + 1) groups[groups.length - 1].push(i);
			else groups.push([i]);
			prev = i;
		});
		if (groups.length !== levels.length) return rows;
		const out = rows.slice();
		groups.forEach((g, gi) => {
			const seq = lv[Math.min(levels[gi], 6) - 1];
			for (const i of g) {
				if (seq && seq !== head) out[i] = out[i].split(head).join(seq);
				// H1's underline off — colour is the mark now.
				if (levels[gi] === 1) out[i] = PagerComponent.stripUnderline(out[i]);
			}
			// The `###` prefix off (pi-tui renders it for H3 and deeper, on the
			// heading's first row).
			if (levels[gi] >= 3) out[g[0]] = out[g[0]].replace(`${"#".repeat(levels[gi])} `, "");
			if (mark) {
				// The superscript after the heading's LAST row. Sliced to the
				// visible width first (renderer rows are width-padded — the
				// ledger's rule), unbold so it reads as a mark, not a word; a
				// row with no room keeps its text (autowrap is off, but a clip
				// is still a loss).
				// `¹` … `⁶`, a bare superscript digit (an `ᴴ¹` form was tried and
				// retracted the same day — maintainer: ugly).
				const last = g[g.length - 1];
				const vw = visibleWidth(stripAnsi(out[last]).replace(/\s+$/, ""));
				if (vw <= width - 2)
					out[last] =
						sliceByColumn(out[last], 0, vw, false) + "\x1b[22m" + mark + "⁰¹²³⁴⁵⁶"[Math.min(levels[gi], 6)] + "\x1b[0m";
			}
		});
		return out;
	}

	/** pi's render, or the wdProse shadow (see renderProseChild's caller). */
	private renderProseRows(gc: any, width: number): string[] {
		let seq = "";
		try {
			seq = ((this.theme as any).fg("wdProse", "\0") as string).split("\0")[0];
		} catch {
			seq = "";
		}
		// `""` (terminal default) resolves to a bare `\x1b[39m` — no colour, so
		// pi's own render stands.
		if (!/\x1b\[(?:38;|3[0-7]m|9[0-7]m)/.test(seq)) return gc.render(width);
		const g = gc as any;
		// The shadow's key includes the PROSE THEME's fingerprint: its painters
		// close over the live theme proxy, so a palette change must rebuild it.
		const key = `${seq}|${this.proseThemeKey()}`;
		let sh = proseShadow.get(gc);
		if (!sh || sh.theme !== g.theme || sh.seq !== key) {
			sh = {
				md: new Markdown(
					g.text,
					g.paddingX ?? 1,
					g.paddingY ?? 0,
					this.proseMarkdownTheme(g.theme),
					{ color: (t: string) => `${seq}${t}\x1b[39m` },
					g.options,
				),
				seq: key,
				theme: g.theme,
			};
			proseShadow.set(gc, sh);
		} else if ((sh.md as any).text !== g.text) {
			sh.md.setText(g.text);
		}
		return sh.md.render(width);
	}

	/** One resolved sequence per prose-only token — the shadow's rebuild key. */
	private proseThemeKey(): string {
		const t = this.theme as any;
		const seq = (k: string) => {
			try {
				return (t.fg(k, "\0") as string).split("\0")[0];
			} catch {
				return "";
			}
		};
		return `${seq("wdProseBold")}|${bgSeqOf(t, "wdCodeBg")}|${seq("mdHeading")}|${seq("mdCode")}|${seq("mdLink")}|${seq("mdListBullet")}`;
	}

	/**
	 * war-dogs' PROSE markdown theme — pi's `getMarkdownTheme()` shape (a table
	 * of painters pi-tui's Markdown calls) over the live theme, plus what pi's
	 * table cannot express: bold in its own tier (`wdProseBold`) and inline
	 * code as a PILL (`wdCodeBg` behind `mdCode`). Both are war-dogs-only keys;
	 * absent or `""`, bold is SGR bold alone and code has no background —
	 * pi's own look. Everything else (headings, links, bullets, quotes, rules,
	 * code blocks, the code-block highlighter) reads the `md*` tokens exactly
	 * as pi does, so a theme keeps steering them.
	 *
	 * The bold tier and headings: pi-tui builds a heading as
	 * `heading(bold(underline(text)))`, so a colour inside `bold` would sit
	 * INSIDE the heading's colour and win — every heading would wear the bold
	 * tier. `heading` therefore removes the bold tier's own sequence from its
	 * text before painting; sequence-exact, so nothing else is touched.
	 */
	private proseMarkdownTheme(base: any): any {
		const t = this.theme as any;
		const fg = (k: string, s: string): string => {
			try {
				return t.fg(k, s) as string;
			} catch {
				return s;
			}
		};
		const seqOf = (k: string): string => {
			try {
				return (t.fg(k, "\0") as string).split("\0")[0];
			} catch {
				return "";
			}
		};
		const boldSeq = /\x1b\[(?:38;|3[0-7]m|9[0-7]m)/.test(seqOf("wdProseBold")) ? seqOf("wdProseBold") : "";
		// A war-dogs bg token is filed as an fg by pi (syntax.ts bgSeqOf).
		const codeBg = bgSeqOf(t, "wdCodeBg");
		const bold = (s: string) => {
			const b = `\x1b[1m${s}\x1b[22m`;
			return boldSeq ? `${boldSeq}${b}\x1b[39m` : b;
		};
		// A link's TEXT arrives already wrapped in the prose colour — pi-tui
		// renders `link(underline(renderInlineTokens(tokens)))`, and the inner
		// tokens carry defaultTextStyle — so `mdLink` landed OUTSIDE the prose
		// sequence and never showed: link text rendered in plain prose white
		// (demonstrated 2026-08-22, the maintainer's hyperlink test). Every
		// prose open inside the link is re-opened as the link colour instead.
		const proseSeq = seqOf("wdProse");
		const linkSeq = seqOf("mdLink");
		return {
			heading: (s: string) => fg("mdHeading", boldSeq ? s.split(boldSeq).join("") : s),
			link: (s: string) => fg("mdLink", proseSeq && linkSeq ? s.split(proseSeq).join(linkSeq) : s),
			linkUrl: (s: string) => fg("mdLinkUrl", s),
			code: (s: string) => (codeBg ? `${codeBg}${fg("mdCode", s)}\x1b[49m` : fg("mdCode", s)),
			codeBlock: (s: string) => fg("mdCodeBlock", s),
			codeBlockBorder: (s: string) => fg("mdCodeBlockBorder", s),
			quote: (s: string) => fg("mdQuote", s),
			quoteBorder: (s: string) => fg("mdQuoteBorder", s),
			hr: (s: string) => fg("mdHr", s),
			listBullet: (s: string) => fg("mdListBullet", s),
			bold,
			italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
			underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
			strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
			// Code blocks: pi's own highlighter and stock syntax palette — the
			// PROSE palette; the field palette belongs to the panels.
			highlightCode: base?.highlightCode,
			codeBlockIndent: base?.codeBlockIndent,
		};
	}

	private renderSubFresh(sub: any, width: number, snippet: boolean, lead?: string): RenderedBeat {
		const lines: string[] = [];
		const ranges: LocalRange[] = [];
		const blocks: LocalBlock[] = [];
		// Beats build here, then flushBeat() moves them onto the surface and
		// reports which surface row carries the state glyph.
		const body: string[] = [];
		const bodyRanges: LocalRange[] = [];
		const bodyBlocks: LocalBlock[] = [];
		const bodyHandles: { row: number; a: number; b: number }[] = [];
		// A handle's hover span: the row's visible text, lead to end.
		// The span ends at the last VISIBLE character: rendered rows arrive
		// width-padded with trailing spaces, so visibleWidth(row) reached the
		// render width and a "text-only" span covered the whole line (round 6
		// — the trace showed span=1..130 on a 19-column sentence).
		const spanOf = (row: string) => ({
			a: (/^ */.exec(stripAnsi(row)) as RegExpExecArray)[0].length,
			b: visibleWidth(stripAnsi(row).replace(/\s+$/, "")),
		});
		try {
			const gcs =
				sub?.lastMessage && Array.isArray(sub?.contentContainer?.children) ? sub.contentContainer.children : null;
			if (gcs) {
				let thinkRun = 0;
				// The dot goes on the model's NARRATION: the first prose row.
				// Thinking rows carry their own marks in the SAME gutter
				// column (round 4: the inline mark read as "indented").
				let glyphAt: number | undefined;
				const bodyMarks: { row: number; glyph: string }[] = [];
				// Round 24: thinking that PRECEDES the prose splits into its own
				// machinery beat (`pre`), so it clusters with the acts around it
				// — the maintainer's "some thinking hasn't been clustered yet".
				// Thinking that appears after prose has begun (rare interleave)
				// stays embedded in the voice beat. A message with no prose at
				// all IS its pre — the thinking-only act of round 23.
				const preBody: string[] = [];
				const preRanges: LocalRange[] = [];
				const preBlocks: LocalBlock[] = [];
				const preHandles: { row: number; a: number; b: number }[] = [];
				const preMarks: { row: number; glyph: string }[] = [];
				let prose = false;
				let preOpen = false;
				let preLines = 0;
				let preGroupHandles = false;
				let bodyGroupHandles = false;
				// Expanded thinking wears the evidence field (round 24) — the
				// text keeps its muted italic voice; only the ground changes.
				const thinkBg = (row: string) => {
					try {
						return (this.theme as any).bg("toolPendingBg", row) as string;
					} catch {
						return row;
					}
				};
				// Streaming = the message has neither settled nor failed yet;
				// the LAST block's thinking mark blinks by presence while the
				// model is still writing it (round 4/7). Round 28, demonstrated
				// live: pi's PARTIAL messages carry stopReason "pending" (see
				// runview.ts's `stop !== "pending"`), so testing bare truthiness
				// classified every streaming message as settled — the working
				// tail never fired and labels read past-tense mid-write.
				const liveMsg = sub.lastMessage as { stopReason?: string; errorMessage?: string } | undefined;
				const stop0 = String(liveMsg?.stopReason ?? "");
				const msgStreaming = (!stop0 || stop0 === "pending") && !liveMsg?.errorMessage;
				// Anything AFTER the thinking in the MESSAGE (prose text or a
				// tool call) means the thinking itself is finished even though
				// stopReason stays "pending" until message_end. Round 30 audit:
				// the old `!prose` test was evaluated before any prose CHILD had
				// rendered — thinking children precede prose children — so the
				// moving-tail view persisted through the whole prose stream.
				const msgHasPostThink = ((sub.lastMessage?.content ?? []) as any[]).some(
					(b) => (b?.type === "text" && String(b.text ?? "").trim()) || b?.type === "toolCall",
				);
				// pi's hideThinkingBlock, mirrored from the component itself
				// (pi flips the field on live components when the setting
				// changes): hidden means HIDDEN — no one-row fold either.
				const hideThink = !!(sub as any).hideThinkingBlock;
				const thinkSet = this.thinkingChildSet(sub);
				// Hidden thinking still has a real LINE COUNT — pi hid the text,
				// not the fact — so a cluster's `thought for N lines` stays honest.
				const hiddenRuns = hideThink ? thinkingRuns(sub.lastMessage) : [];
				for (const gc of gcs) {
					if (thinkSet.has(gc) && hideThink) {
						// pi's hideThinkingBlock swaps the thinking Markdown for a
						// plain Text carrying its `hiddenThinkingLabel` (README:
						// "hidden renders pi's stock Thinking... label"). That
						// label is MACHINERY: it keeps thinking's ◐ in the gutter
						// and routes to the pre beat like any other thinking run.
						// Classified as prose it STOLE the beat's ● and the model's
						// answer below got no glyph at all (round 31 audit,
						// sess/think1.jsonl at width 120).
						const tb = prose ? body : preBody;
						const tm = prose ? bodyMarks : preMarks;
						const from = tb.length;
						pushAll(tb, gc?.render?.(width) ?? []);
						let at = -1;
						for (let i = from; i < tb.length; i++)
							if (stripAnsi(tb[i]).trim()) {
								at = i;
								break;
							}
						if (at < 0) {
							tb.length = from;
							continue;
						}
						const ti0 = thinkRun++;
						// The hidden label blinks like any streaming thinking mark —
						// phase-free marker, decided at composition (round 31).
						const live = msgStreaming && !msgHasPostThink && ti0 === thinkSet.size - 1;
						tm.push({ row: at, glyph: (live ? BLINK : "") + this.fg("thinkingText", "◐") });
						if (!prose) preLines += srcLines(hiddenRuns[ti0] ?? "");
						continue;
					}
					if (!thinkSet.has(gc)) {
						const s0 = body.length;
						pushAll(body, this.renderProseChild(gc, width));
						if (body.length > s0 && glyphAt === undefined) {
							// First rendered row of prose may be the component's
							// own blank padding; the glyph goes on its first
							// CONTENT row.
							for (let i = s0; i < body.length; i++)
								if (stripAnsi(body[i]).trim()) {
									glyphAt = i;
									break;
								}
						}
						if (glyphAt !== undefined) prose = true;
						if (typeof gc?.text === "string" && body.length > s0)
							bodyBlocks.push({ s: s0, e: body.length, src: gc.text });
						continue;
					}
					// Route this thinking block to the PRE beat until prose begins.
					const tb = prose ? body : preBody;
					const tr = prose ? bodyRanges : preRanges;
					const tk = prose ? bodyBlocks : preBlocks;
					const th = prose ? bodyHandles : preHandles;
					const tm = prose ? bodyMarks : preMarks;
					const ti = thinkRun++;
					const expanded = thinkIsExpanded(sub, ti);
					const s = tb.length;
					/** Working glyph view: the whole block is on screen — nothing to open. */
					let workingThinkFull = false;
					// Thinking's mark is `◐` (round 10, pick G+half-moon) in BOTH
					// fold states — thinking's own colour, presence-blinking
					// while the model is still writing the block.
					const src = String(gc.text ?? "");
					const n = srcLines(src);
					const first = sanitize(src.split("\n").find((l) => l.trim()) ?? "");
					// STREAMING = the message is still open, nothing has landed
					// after the thinking yet, and this is the LAST thinking run.
					// Round 28: keying on pi's literal last container child broke
					// whenever pi appended a child; round 30: keying on the
					// `prose` routing flag kept the tail alive through the whole
					// prose stream (audit) — the MESSAGE content decides now.
					const thinkStreaming = msgStreaming && !msgHasPostThink && ti === thinkSet.size - 1;
					// The ◐ presence-blinks WHILE STREAMING via the composition-
					// layer marker (round 31) — the cache stays phase-free (the
					// round-30 bake bug); a settled block's mark is static.
					const mark = (g: string) => (thinkStreaming ? BLINK : "") + this.fg("thinkingText", g);
					if (!prose) {
						preLines += n;
						if (expanded) preOpen = true;
					}
					// A one-liner that simply FITS its row is COMPLETE: nothing
					// is hidden, so it is not expandable — no suffix, no hover
					// light, no click, and the ● never changes.
					const fits = n === 1 && visibleWidth(first) <= Math.max(8, width - 2);
					if (thinkStreaming || snippet) {
						// GLYPH VIEW while the model works (rounds 29-30,
						// maintainer: "nothing is clustered when the model is
						// working"): no label, no ⎿, no field — the ◐ carries the
						// identity and 5 visible NON-BLANK lines show plain (blank
						// paragraph gaps once ate the budget down to 1-3 rows).
						// A streaming block shows its MOVING TAIL; a block already
						// finished inside the window shows its head. EXPANSION IS
						// IGNORED here — an expand-all left on turned the working
						// view into the full field panel and dragged the frame
						// rate down with it; the cluster view begins at settle.
						// A fixed-height window of 5 display ROWS, built from WRAPPED
						// source lines nearest the view's edge — never truncated. The
						// truncated form froze the working view: a thinking paragraph
						// is one long source line, and once it outgrew the row its
						// visible prefix stopped changing while every further token
						// streamed invisibly until the newline — 200–500 ms freezes
						// then a jump, on every paragraph, while stock (which wraps)
						// streamed on (demonstrated 2026-08-18 against a 400-column
						// mock thinking line: 14 screen gaps > 150 ms vs 1 in stock).
						// EXPANDED is honoured again (round 31 — affordable now
						// that the flicker/bypass roots are dead; the audit
						// measured a full 200-line wrap at ~0.55ms): the click
						// opens the FULL text in this same plain style, growing
						// live while it streams; the label/field form stays
						// settled-only per the maintainer's working doctrine.
						const from = tb.length;
						// The WORKING view is quiet (maintainer): everything the window
						// leaks — thinking's tail included — wears the low white relative
						// to the prose, whatever tier the settled open panel uses.
						// `muted`, not `thinkingText`.
						if (expanded) {
							// Open = already lit: the full text does NOT hover (2026-08-20,
							// maintainer) — like every open panel, a click anywhere on
							// it folds (the row-wide range below), nothing previews.
							for (const raw of src.replace(/\s+$/, "").split("\n"))
								for (const wl of wrapPlain(sanitize(raw), Math.max(4, width - 2)))
									tb.push(` ${this.fg("muted", `\x1b[3m${wl}\x1b[23m`)}`);
						} else {
							const all = src
								.replace(/\s+$/, "")
								.split("\n")
								.filter((l) => l.trim());
							const inner = Math.max(8, width - 2);
							// Wrap only the source lines the window can show — from
							// the END for a streaming tail, from the START for a
							// finished head — so the cost is O(rows shown), not
							// O(thinking), whatever the block's length.
							const rows: string[] = [];
							let consumed = 0;
							if (thinkStreaming) {
								for (let li = all.length - 1; li >= 0 && rows.length < 5; li--, consumed++)
									rows.unshift(...wrapPlain(sanitize(all[li]), inner));
							} else {
								for (let li = 0; li < all.length && rows.length < 5; li++, consumed++)
									pushAll(rows, wrapPlain(sanitize(all[li]), inner));
							}
							const view = thinkStreaming ? rows.slice(-5) : rows.slice(0, 5);
							// Anything out of view — a source line beyond the window,
							// or rows of a wrapped one — makes the block expandable; a
							// block that FITS its window is complete (the rest rule for
							// a fitting one-liner, 2026-08-20 maintainer): no hover
							// light, no click, nothing to open.
							// A block still STREAMING is always expandable, however
							// short so far (maintainer: "if the token is streaming we
							// can expand it") — complete means finished AND on screen.
							const cut = consumed < all.length || rows.length > view.length;
							workingThinkFull = !cut && !thinkStreaming;
							for (const shown of view) {
								tb.push(` ${this.fg("muted", `\x1b[3m${shown}\x1b[23m`)}`);
								// Every visible row hovers — grouped below, so the
								// whole block lights as one control (round 30).
								if (!workingThinkFull) th.push({ row: tb.length - 1, ...spanOf(tb[tb.length - 1]) });
							}
							// The counter says LINES (round 30's one vocabulary).
							if (cut) tb.push(` ${this.fg("dim", `… (${plural(n, "line")} total)`)}`);
						}
						tm.push({ row: from, glyph: mark("◐") });
						if (prose) bodyGroupHandles = true;
						else preGroupHandles = true;
					} else if (!expanded) {
						// Thinking rests as ONE ROW of its own text, folded at THIS
						// layer (never pi's ctrl+t, which hides every block globally
						// with no per-block expand). The row is the first source
						// line cut to fit; whenever anything is cut or hidden, the
						// row says so inline: `text ... (N lines total)`. Hover
						// highlights the row (see handles) — that is the affordance.
						let row: string;
						if (fits) {
							row = ` ${this.fg("muted", `\x1b[3m${first}\x1b[23m`)}`;
						} else {
							const suffix = ` ... (${n} line${n === 1 ? "" : "s"} total)`;
							const budget = Math.max(8, width - 2 - suffix.length);
							// truncateToWidth appends \x1b[0m, which would reset the
							// outer dim and render the suffix white — strip it.
							const shown = visibleWidth(first) > budget ? stripAnsi(ansiTruncate(first, budget, "")) : first;
							row = ` ${this.fg("muted", `\x1b[3m${shown}${suffix}\x1b[23m`)}`;
						}
						tb.push(row);
						tm.push({ row: tb.length - 1, glyph: mark("◐") });
						if (!fits) th.push({ row: tb.length - 1, ...spanOf(row) });
					} else {
						// Expanded (round 25 shape, round 26 wording+light): the
						// label row stays as the head and the text opens under a
						// `⎿` like every other act's evidence —
						//   thought for N lines
						//    ⎿  <text>
						// — on the field. The label is a panel HEAD, so it lights
						// to the text tier like every open head (round 26); only
						// the thinking TEXT below stays muted italic.
						tb.push(
							thinkBg(
								` ${this.bold(this.fg("text", thinkStreaming ? "thinking" : "thought"))} ${this.fg("text", `for ${plural(n, "line")}`)}`,
							),
						);
						tm.push({ row: tb.length - 1, glyph: mark("◐") });
						let put = 0;
						// width-10, the tool branch's toolW rule: at width-6 a thinking
						// text opened inside a cluster MEMBER (+3) overflowed the
						// measure and the render loop sliced its last characters
						// (`Now the fina` — demonstrated 2026-08-22).
						for (const raw of String(gc.text ?? "").split("\n"))
							for (const wl of wrapPlain(sanitize(raw), Math.max(4, width - 10))) {
								const prefix = put ? "    " : ` ${this.fg("dim", "⎿")}  `;
								tb.push(thinkBg(`${prefix}${this.fg("thinkingText", `\x1b[3m${wl}\x1b[23m`)}`));
								put++;
							}
						if (typeof gc?.text === "string" && tb.length > s) tk.push({ s, e: tb.length, src: gc.text });
					}
					// PRE-routed thinking is ALWAYS expandable (round 24b): its
					// rest form is a summary label, so even a fitting one-liner
					// hides its text. The fits rule still holds for thinking
					// embedded in a prose beat, where the preview IS the text.
					// The toggle is LIVE in the working view again (round 31).
					// Collapse-return + flash for thinking too (round 26): the
					// toggle records the click row on expand and requests the
					// scroll-back on fold, exactly like the tool toggles. A
					// PRE-routed block keys on the pre key so the landing row
					// is the thinking beat's own, never the prose beat's.
					const scrollKey = prose ? sub : preKeyOf(sub);
					const toggle = () => {
						const before = thinkIsExpanded(sub, ti);
						thinkToggle(sub, ti);
						if (!before) this.collapseAnchor.set(scrollKey, this.lastClickScreenRow);
						else this.pendingScrollBeat = scrollKey;
						this.follow = false;
						this.liveDirty = true;
						this.tui.requestRender();
					};
					if ((thinkStreaming || snippet) && !expanded) {
						// PER-ROW text spans (round 31b, maintainer: "we already
						// light them 5"): the shared gate applied the LAST row's
						// width to every row — the short `… (N lines total)`
						// counter — so only near-column-start clicks landed. Every
						// lit row is now clickable over its own text — none when the
						// block fits its window whole (workingThinkFull).
						for (let ri2 = workingThinkFull ? tb.length : s; ri2 < tb.length; ri2++) {
							if (!stripAnsi(tb[ri2]).trim()) continue;
							tr.push({ s: ri2, e: ri2 + 1, ...spanOf(tb[ri2]), action: toggle });
						}
					} else if (!fits || expanded || !prose) {
						tr.push({
							s,
							e: tb.length,
							...(expanded ? undefined : { a: 1, b: Math.max(2, visibleWidth(tb[tb.length - 1] ?? "")) }),
							action: toggle,
						});
					}
				}
				// Prose carries the DOT again (maintainer's verdict, round 3):
				// `●` in the brightest white marks the model's voice — the
				// triangles stay the tools' shape. An errored/aborted turn
				// turns the dot red; state always lives in the glyph column.
				const failed = liveMsg?.stopReason === "error" || liveMsg?.stopReason === "aborted" || !!liveMsg?.errorMessage;
				// The PRE beat: leading thinking as MACHINERY (round 24) — it
				// clusters as `thought` in the summary. While the model is
				// still writing it stays out of clusters and on the surface,
				// like every running act; a click-expanded pre reads as "open"
				// so its member row keeps the field.
				let preBeat: RenderedBeat | undefined;
				if (preBody.length) {
					const pl: string[] = [];
					const pr: LocalRange[] = [];
					const pb: LocalBlock[] = [];
					const pf = this.flushBeat(pl, pr, pb, preBody, preRanges, preBlocks, undefined, preHandles, preMarks);
					if (pl.length)
						preBeat = {
							lines: pl,
							ranges: pr,
							blocks: pb,
							handles: pf.handles,
							marks: pf.marks,
							kind: preOpen ? "open" : "act",
							// Only a SETTLED open block breathes — the working view is
							// glyph-and-text with no field.
							pad: preOpen && !msgStreaming && !snippet ? thinkBg("") : undefined,
							act: { tool: "thinking", err: failed, running: msgStreaming, lines: preLines },
							groupHandles: preGroupHandles || undefined,
						};
				}
				const flushed = this.flushBeat(
					lines,
					ranges,
					blocks,
					body,
					bodyRanges,
					bodyBlocks,
					glyphAt,
					bodyHandles,
					bodyMarks,
				);
				// No prose at all: the message IS its thinking — the pre is the
				// whole beat (round 23's thinking-only act).
				if (!lines.length && preBeat) return preBeat;
				// A turn that is ONLY an error — pi's `Error: …` line for a
				// provider/transport failure (a 429, a connection error, a
				// retry that gave up) with no text of the model's own — is an
				// ACT of its own kind (2026-08-22, maintainer): `error` beats
				// cluster with each other (`errored N times`, a solo one shows
				// its line) and never with tools or thinking (emitPart breaks
				// the batch between the kinds). A turn with partial prose plus
				// an error stays a voice beat with the red dot.
				const hasProse = ((liveMsg as any)?.content ?? []).some(
					(b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim(),
				);
				if (failed && liveMsg?.errorMessage && !hasProse && !msgStreaming) {
					// Rows built HERE, at width-10 (the toolW rule), not taken from
					// pi's render at the full width: as a cluster member they shift
					// +3, and pi's rows were sliced at the edge (`please try aga` —
					// demonstrated 2026-08-22). Red, one-space lead, no controls —
					// an error has nothing to open.
					const errRows: string[] = [];
					for (const src of `Error: ${String(liveMsg.errorMessage)}`.split("\n"))
						for (const wl of wrapPlain(sanitize(src), Math.max(4, width - 10)))
							errRows.push(` ${this.fg("error", wl)}`);
					return {
						lines: errRows,
						ranges: [],
						blocks: [{ s: 0, e: errRows.length, src: `Error: ${String(liveMsg.errorMessage)}` }],
						kind: "act",
						act: { tool: "error", err: true, running: false },
						pre: preBeat,
					};
				}
				return {
					lines,
					ranges,
					blocks,
					head:
						flushed.head === undefined
							? undefined
							: { row: flushed.head, glyph: this.beatGlyph(failed ? "error" : "prose") },
					handles: flushed.handles,
					marks: flushed.marks,
					kind: "prose",
					pre: preBeat,
					groupHandles: bodyGroupHandles || undefined,
				};
			}
			// The ACT branch, gated on a NAME (foldName), never on the
			// setExpanded/expanded duck-type alone — see foldName's comment:
			// four of pi's own components answer that duck-type without being
			// tools, and everything below reads toolName/args/result. Anything
			// foldable we cannot name falls through to the generic branch,
			// which renders it flat instead of as an anonymous empty act.
			if (isFoldableAct(sub)) {
				// Pager-owned folding: the tool is ALWAYS rendered in its
				// EXPANDED form (full paths, full output — no "(ctrl+o …)"
				// hints exist there), flipped transiently so pi's live state
				// never changes. The pager then folds it against the tool's
				// own SOURCE text, never against the wrapped rows.
				// The DEEPEST seat evidence can occupy: an output chunk (⎿ at
				// depth 1 = 6 columns of staircase) inside an open cluster member
				// (+3 more). Rendering at width-4 meant deep rows overflowed the
				// content width and the render loop silently SLICED them — real
				// characters of the command line and its output shaved off
				// screen (maintainer-reported: `... || e` cut mid-token; 120
				// printed A's rendered as 118). One width that fits every depth
				// kills the loss and the double-wrap orphan rows at the root.
				const toolW = Math.max(4, width - 10);
				const actual: boolean = sub.expanded;
				// The call and the result render SEPARATELY when the component
				// exposes its renderer children (round 11: the old "first blank
				// row after content" split cut a multi-line bash command at the
				// blank line INSIDE its quoted string, and the command's tail
				// rendered as output). Everything happens inside the transient
				// setExpanded window — the flip rebuilds those children.
				let toolLines: string[] = [];
				let callRows: string[] | null = null;
				let outRows: string[] = [];
				// Did the grab produce a real call/RESULT split, or only a
				// call? A tool whose renderResult is missing or THROWS leaves
				// `resultRendererComponent` undefined while pi quietly drops a
				// plain-Text fallback into the render container instead
				// (tool-execution.js createResultFallback) — reading only the
				// field lost the whole result: `ev=grab … out=0` and a beat
				// with a sentence and no evidence (round 31 audit, reachable
				// with any MCP result that carries no `details`). Fall back to
				// the blank-row split of the FULL render in that case.
				let haveResult = false;
				const grab = () => {
					toolLines = (sub.render(toolW) ?? []) as string[];
					// pi's `!command` beat renders its own frame — a Spacer, two
					// DynamicBorders around the content — and none of that is
					// call-or-evidence. Read its contentContainer directly: the
					// `$ command` header is the call, everything else (minus the
					// live loader, whose spinner is a CLOCK we must never bake
					// into a cached render) is the output.
					if (sub instanceof BashExecutionComponent) {
						const kids = ((sub as any).contentContainer?.children ?? []) as any[];
						const loader = (sub as any).loader;
						callRows = (kids[0]?.render?.(toolW) ?? []) as string[];
						outRows = [];
						for (let ki = 1; ki < kids.length; ki++) {
							if (kids[ki] === loader) continue;
							pushAll(outRows, (kids[ki]?.render?.(toolW) ?? []) as string[]);
						}
						haveResult = true;
						trace({ ev: "grab", tool: "user-bash", rc: 1, call: callRows.length, out: outRows.length });
						return;
					}
					const cc = (sub as any).callRendererComponent;
					const rc = (sub as any).resultRendererComponent;
					if (!cc?.render) {
						// NO call renderer (a definition without `renderCall` — the
						// adapter's mcpScript): pi drops its createCallFallback Text
						// (the bold tool name alone) into the render container and
						// leaves `callRendererComponent` undefined, then the result
						// component right under it with NO blank row between — so
						// the blank-row split below read name + result as one call
						// block, and the args rebuild that splices in after row 0
						// replaced the result with the args: an mcpScript panel
						// showed its code and never its output (demonstrated
						// 2026-08-20). The container's children are the truth here
						// too: child 0 is the call, the rest is the result.
						try {
							const kids = [(sub as any).selfRenderContainer, (sub as any).contentBox]
								.map((sh) => (sh?.children ?? []) as any[])
								.find((k) => k.length > 0);
							if (kids && kids.length) {
								const lead = (rows: string[]) => rows.map((r) => (stripAnsi(r).trim() ? ` ${r}` : r));
								callRows = lead((kids[0]?.render?.(toolW) ?? []) as string[]);
								outRows = [];
								for (let ki = 1; ki < kids.length; ki++)
									pushAll(outRows, lead((kids[ki]?.render?.(toolW) ?? []) as string[]));
								haveResult = outRows.length > 0;
								trace({
									ev: "grab",
									tool: String((sub as any).toolName ?? "?"),
									rc: rc ? 1 : 0,
									call: callRows.length,
									out: outRows.length,
								});
							}
						} catch {
							callRows = null;
							haveResult = false;
						}
					} else if (cc?.render) {
						try {
							// The container adds a 1-space lead when rendering
							// children inline — restore it, or every separated
							// row sits one column left of the old geometry.
							const lead = (rows: string[]) => rows.map((r) => (stripAnsi(r).trim() ? ` ${r}` : r));
							callRows = lead((cc.render(toolW) ?? []) as string[]);
							outRows = [];
							haveResult = !!rc?.render;
							if (haveResult) {
								outRows = lead((rc.render(toolW) ?? []) as string[]);
							} else {
								// pi's plain-Text RESULT FALLBACK. When a tool's
								// renderResult is missing — or THROWS — pi drops a
								// Text carrying the result's whole output into the
								// render container and leaves `resultRendererComponent`
								// undefined (tool-execution.js createResultFallback).
								// Reading only that field lost the result ENTIRELY:
								// `ev=grab … out=0` and a beat with a sentence and no
								// evidence (round 31 audit; reachable with any MCP
								// result that carries no `details`). The container's
								// CHILDREN are the truth — the call is one of them and
								// the result is whatever follows it. The blank-row
								// split cannot serve here: pi's fallback Text sits
								// flush against the call with no blank between them.
								const kids = [(sub as any).contentBox, (sub as any).selfRenderContainer]
									.map((sh) => (sh?.children ?? []) as any[])
									.find((k) => k.includes(cc));
								const at = kids ? kids.indexOf(cc) : -1;
								if (at >= 0 && kids)
									for (let ki = at + 1; ki < kids.length; ki++)
										pushAll(outRows, lead((kids[ki]?.render?.(toolW) ?? []) as string[]));
								haveResult = outRows.length > 0;
							}
							trace({
								ev: "grab",
								tool: String((sub as any).toolName ?? "?"),
								rc: rc ? 1 : 0,
								call: callRows.length,
								out: outRows.length,
							});
						} catch {
							callRows = null;
							haveResult = false;
						}
					}
				};
				if (actual) {
					grab();
				} else {
					try {
						sub.setExpanded(true);
						grab();
					} finally {
						sub.setExpanded(false);
					}
				}
				// A SKILL invocation's evidence is the skill text as the model got
				// it — pi's `<skill name=… location=…>` block, "References are
				// relative to …", the SKILL.md body — RAW, highlighted as markdown
				// in the field palette (the rule for every tool body: colour the
				// characters, never re-render them), never pi's markdown render
				// with its `[skill]` label and `**name**` header (our sentence
				// says `used skill <name>`), and never pi's customMessageBg card,
				// which leaked as a blue box into the working window (maintainer,
				// 2026-08-18).
				if (foldName(sub) === "skill") {
					const src = String((sub as any).skillBlock?.content ?? "");
					const hi = highlightField(src, "markdown", this.theme) ?? src.split("\n");
					const ev = evidenceSeq(this.theme);
					const rows: string[] = [];
					for (const line of hi)
						for (const wl of wrapTextWithAnsi(ev ? baseTone(line, ev) : line, Math.max(4, toolW - 1)))
							rows.push(` ${wl}`);
					callRows = [];
					outRows = rows;
					haveResult = true;
				}
				// Figure-ground: pi's CARD tint dies here — state moves to the beat
				// glyph. Only pi's own card sequences go (the theme's tool*Bg as
				// theme.bg emits them, and the field the pager paints itself);
				// every other background a renderer set — edit's diff tints, a
				// code pill — is content and stays. (The old stripBg removed every
				// bg, which is why a tinted diff could not exist.) What pi and the
				// adapter paint in `toolOutput` — bash output, an MCP result — stays
				// in that resting tier: OUTPUT is plain and low on the field
				// (maintainer); the evidence tier belongs to what our renderers
				// paint themselves (read/write/edit bodies).
				const cardSeqs = ["toolPendingBg", "toolSuccessBg", "toolErrorBg", "customMessageBg"].map((k) => {
					try {
						return (this.theme as any).bg(k, "\0").split("\0")[0] as string;
					} catch {
						return "";
					}
				});
				// The card's `\x1b[49m` closers go with it: left in place they
				// would close the pager's own field mid-row (Theme.bg is a plain
				// open+text+close wrap). A content bg thereby runs to the end of
				// its row's text and the render loop's fill repaints the field.
				const field = (row: string) => stripBgSeqs(row, [...cardSeqs, "\x1b[49m"]);
				toolLines = toolLines.map(field);
				if (callRows) {
					callRows = callRows.map(field);
					outRows = outRows.map(field);
				}
				// The subagent's TREE is rendered by renderResult (it leads the
				// result container), but it belongs to the CALL block — move
				// the result's leading non-blank run over. Tree rows never
				// contain blanks, so this split is safe where the old
				// whole-render heuristic was not.
				if (callRows && labelFoldFor(String((sub as any).toolName ?? ""), (sub as any).args)) {
					let t = 0;
					while (t < outRows.length && stripAnsi(outRows[t]).trim()) t++;
					callRows = [...callRows, ...outRows.slice(0, t)];
					outRows = outRows.slice(t);
				}
				// FALLBACK split (components without renderer children): the
				// first blank row after visible content.
				let split = toolLines.length;
				let seen = false;
				for (let li = 0; li < toolLines.length; li++) {
					if (stripAnsi(toolLines[li]).trim()) seen = true;
					else if (seen) {
						split = li;
						break;
					}
				}
				// Tool ARGUMENTS (paths, urls, queries) come out of pi's
				// renderToolPath in `accent`, the same green as the tool name —
				// one green blob. Recoloured to DIM (see accentToDim): bright
				// name, quiet argument, and the hover light visibly pops.
				const call = PagerComponent.stripHints(callRows ?? toolLines.slice(0, split)).map((cl) => this.accentToDim(cl));
				// An MCP call's ARGS are JSON by protocol (a tool call's `arguments`
				// is a JSON object against the tool's schema; the adapter renders
				// `JSON.stringify(args, null, 2)` under the title for the gateway
				// and every direct tool alike), so the block under the title row is
				// highlighted as JSON in the field palette — raw text, colour only,
				// row count checked. Truncated JSON still highlights (ignoreIllegals).
				// From the SOURCE args, not from the rendered rows: pi's Text has
				// already wrapped the adapter's JSON at the tool width, and a
				// string that wraps is an unterminated string on its first row
				// and bare text on the next — highlighting display rows lost the
				// colour on every continuation (demonstrated). The block is
				// rebuilt with the adapter's own formatter (formatJsonish:
				// JSON.stringify(v, null, 2), truncated at 1500 chars with `…`;
				// a string arg re-parsed as JSON when it is one) — the same
				// characters it draws — highlighted per source line, then wrapped
				// ANSI-aware so continuations keep their colour.
				try {
					const tn0 = String((sub as any).toolName ?? "").toLowerCase();
					if (tn0 === "mcp" || !GRAMMAR_TOOLS.has(tn0)) {
						const a = ((sub as any).args ?? {}) as Record<string, unknown>;
						// mcpScript's evidence is its CODE, highlighted as JavaScript —
						// not `{"code": "…\n…"}` with the newlines escaped into one
						// unreadable string (2026-08-20).
						const isScript = tn0 === "mcpscript" && typeof a.code === "string" && a.code.trim();
						const src = isScript
							? String(a.code).replace(/\s+$/, "")
							: tn0 === "mcp"
								? typeof a.tool === "string" && a.tool && a.args !== undefined && a.args !== null
									? mcpJsonish(a.args)
									: ""
								: hasUsefulObjectContent(a)
									? mcpJsonish(a)
									: "";
						const ti0 = call.findIndex((l) => stripAnsi(l).trim());
						if (src && ti0 >= 0) {
							const hi = highlightField(src, isScript ? "javascript" : "json", this.theme);
							if (hi) {
								const ev = evidenceSeq(this.theme);
								const rows: string[] = [];
								for (const line of hi)
									for (const wl of wrapTextWithAnsi(ev ? baseTone(line, ev) : line, Math.max(4, toolW - 1)))
										rows.push(` ${wl}`);
								call.splice(ti0 + 1, call.length - ti0 - 1, ...rows);
							}
						}
					}
				} catch {}
				try {
					if (sub.toolName === "read") {
						const p = String(sub.args?.file_path ?? sub.args?.path ?? "");
						const home = os.homedir();
						const tildeP = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
						const ci = call.findIndex((l) => stripAnsi(l).trim());
						const shown = ci >= 0 ? stripAnsi(call[ci]) : "";
						if (p && ci >= 0 && !shown.includes(p) && !shown.includes(tildeP)) call[ci] += this.fg("dim", ` · ${p}`);
					}
				} catch {}
				// The evidence: the result renderer's rows when there IS one,
				// the blank-row split of the whole render when pi fell back to
				// its plain-Text result (see `haveResult`).
				let output = PagerComponent.stripHints(callRows && haveResult ? outRows : toolLines.slice(split));
				// The wire view's source and its gate: a result with TEXT. While
				// streaming there is no result yet, so a wire-flipped beat renders
				// pretty until it settles.
				// A SKILL invocation's wire is the `<skill …>…</skill>` block the
				// model received (its words and stamp live in the user box that
				// follows); it has no `result`, so it is read from the block.
				const skillWire = (b: any): string =>
					b && typeof b.content === "string"
						? `<skill name="${b.name}" location="${b.location}">\n${b.content}\n</skill>`
						: "";
				const wtxt =
					foldName(sub) === "skill" ? skillWire((sub as any).skillBlock) : resultWireText((sub as any).result);
				const wire = wireOn(sub) && !!wtxt;
				// PRETTY-view subtractions (the wire view shows them again): the
				// trailing [timestamp: …] row wherever a renderer printed the
				// result verbatim (bash, MCP, errors, pi's plain-Text fallback —
				// read/webfetch/websearch strip theirs at the renderer, so this
				// finds nothing there), and webfetch's `[webfetch: …]` head line,
				// which restates the sentence. Gated on `result`, so pi's own
				// beats — a `!command`'s output, a skill's text — are content and
				// never touched.
				if ((sub as any).result) {
					output = stripStampRows(output);
					if (String((sub as any).toolName ?? "").toLowerCase() === "webfetch") {
						const hi = output.findIndex((l) => stripAnsi(l).trim());
						if (hi >= 0 && /^\[webfetch: /.test(stripAnsi(output[hi]).trim())) output.splice(hi, 1);
					}
				}
				// A background bash's result is a RECEIPT ("Started … in the
				// background …"): it was italic 2026-08-18 → 2026-08-22 (a system
				// note); the maintainer retired the italic — it renders upright
				// like any output, and its run id is wire-only (stripMetaRows).
				// pi's own foldables carry their state in their own fields —
				// they have neither `isPartial` nor `result`, so without this a
				// `!command` never read as running (it clustered the instant it
				// appeared) and a failing one never went red.
				const bashStatus = sub instanceof BashExecutionComponent ? String((sub as any).status ?? "") : "";
				const partial = !!(sub as any).isPartial || bashStatus === "running";
				const isErr = !!(sub as any).result?.isError || bashStatus === "error";
				// The act NAME: pi's own foldables are named by foldName —
				// unnamed, every one of them clustered as "called 1 mcp".
				const toolName = foldName(sub) ?? "";
				// Lowercased for name checks: transcripts from before the
				// lowercase rename carry "WebFetch"/"Kimi-WebSearch".
				const toolNameLc = toolName.toLowerCase();
				// Both shells fold the same way — a `$ command` chunk with its
				// output nested under it, both sides raw text where blanks are
				// content.
				const bashLike = toolNameLc === "bash" || toolNameLc === "powershell" || toolNameLc === "user-bash";
				const labelFold = labelFoldFor(toolName, (sub as any).args);
				// The adapter's tools: the `mcp` gateway, `mcpScript`, and every
				// direct `<server>_<tool>` — one sentence family, args as evidence.
				const mcpFamily = toolNameLc === "mcp" || toolNameLc === "mcpscript" || !!mcpDirectParts(toolName);
				const details = ((sub as any).result?.details ?? {}) as Record<string, unknown>;
				// pi's loop marks isError only for THROWN errors; tools that
				// return typed failures (WebFetch's non-ok statuses, websearch's
				// no-results) come back "successful". Read the state from
				// details so those beats go red too — in every branch.
				// A scout run whose EVERY verdict failed is a failed fetch, even
				// though the evaluation itself succeeded (round 28).
				const scoutAllFailed =
					details.scout === true &&
					Array.isArray(details.results) &&
					(details.results as any[]).length > 0 &&
					(details.results as any[]).every((v) => v?.verdict === "error" || v?.verdict === "blocked");
				const softErr =
					!partial &&
					!isErr &&
					!!(sub as any).result &&
					((toolNameLc === "webfetch" &&
						((typeof details.status === "string" ? details.status !== "ok" : typeof details.error === "string") ||
							scoutAllFailed)) ||
						(toolNameLc === "kimi-websearch" && typeof details.returned !== "number") ||
						(!GRAMMAR_TOOLS.has(toolNameLc) && errorShapedResult((sub as any).result)));
				const errState = isErr || softErr;
				// Round 23: the subagent's run FAMILY state decides both its
				// clustering and its collapsed form. A LIVE family — this turn's
				// FOREGROUND run, or its descendants still working — keeps its
				// tree on the surface and never clusters: folding a working tree
				// into a summary line would undo the background-truthfulness
				// fix. A settled family joins the one-line doctrine like every
				// other act. A BACKGROUND launch is different since 2026-08-20
				// (maintainer): its tool call is a RECEIPT — the act is done the
				// moment the receipt lands, exactly like background bash — so it
				// clusters at settle while the run works on, its clock does not
				// tick on the surface, the footer strip is the live indicator,
				// and the delivered `subagent-result` is the act that carries the
				// duration.
				const runId0 = labelFold && typeof details.runId === "string" ? String(details.runId) : undefined;
				const rootRun = runId0 ? (registry.get(runId0)?.run ?? knownRuns.get(runId0)) : undefined;
				const bgLaunch = !!rootRun?.background || ((sub as any).args ?? {}).background === true;
				const familyLive = runId0 && !bgLaunch ? subFamilyLive(runId0) : false;
				// A STOP is not a failure (2026-08-29, the maintainer's screenshots:
				// a lead's `started agent` acts painted red, "3 failed", after the
				// user stopped it); red is for an error and a timeout.
				const rootFailed =
					rootRun?.status === "error" || (rootRun?.status === "stopped" && /timed out/.test(rootRun.error ?? ""));
				const liveAct = partial || familyLive;
				const actErr = errState || rootFailed;
				// An act's resting state is its summary, always — the fold
				// covers the whole act, not just its output. The subagent too
				// (round 3): collapsed it is call + run tree, expanded it adds
				// Prompt/Response on the field.
				const collapsed = !pagerToolExpanded(sub);

				// First row of output with content; leading blanks separate the call block.
				let head = 0;
				while (head < output.length && !stripAnsi(output[head]).trim()) head++;

				const pushRunMarks = (callBase: number) => {
					// Run-tree rows carry a zero-width \x1b_sa:<id>\x07 marker (MARK
					// in visual/tools/subagent.ts). Each marked row gets its own
					// click range, pushed BEFORE the whole-beat fold range so
					// handleClick's first-match resolves the row to its run. The
					// action goes through state.ts's hook, not `this` — these
					// ranges are cached in compCache, which outlives a pager
					// instance.
					for (let ci = 0; ci < call.length; ci++) {
						const rid = runMarkId(call[ci]);
						if (rid)
							bodyRanges.push({
								s: callBase + ci,
								e: callBase + ci + 1,
								action: () => requestOpenRun(rid),
								...spanOf(call[ci]),
							});
					}
				};

				// The act SENTENCE is shared by both fold states (maintainer's
				// verdict — the expanded call line was pi's green title, so a
				// beat changed colour when opened): collapsed shows it alone,
				// expanded keeps the SAME row and lays the evidence below it.
				// write/edit render their stats row in the CALL component (the
				// body lives there for streaming — see visual/tools/write.ts),
				// so the sentence's stats source scans BOTH sides.
				const notStats = (l: string) => !/^(Wrote \d|Added \d|Read \d|Read image)/.test(stripAnsi(l).trim());
				let stats = head < output.length ? stripAnsi(output[head]).trim() : "";
				if (!/^(Read |Wrote |Added )/.test(stats)) {
					for (const cl of call) {
						const v = stripAnsi(cl).trim();
						if (/^(Read \d|Wrote \d|Added \d|Read image)/.test(v)) {
							stats = v;
							break;
						}
					}
				}
				const plain = labelFold ? undefined : this.actSentence(toolNameLc, sub, partial, details, stats);
				// The rendered Took/Elapsed footer row (bash), folded into the
				// sentence tail — or into the error report when there is one.
				let took = "";
				for (let li = output.length - 1; li >= 0; li--) {
					const vis = stripAnsi(output[li]).trim();
					if (!vis) continue;
					const m = /^(?:Took|Elapsed)\s+(.*)$/.exec(vis);
					if (m) took = m[1];
					break;
				}
				// The CALL tier (`wdCall` — brighter than the output tier, below
				// prose; round 7's brightness hierarchy). Caught fallback for
				// stock themes without the extra key.
				const callFg = (t: string) => {
					try {
						return (this.theme as any).fg("wdCall", t) as string;
					} catch {
						return this.fg("toolOutput", t);
					}
				};
				let sentence: string | undefined;
				if (plain !== undefined) {
					const words = sanitize(plain).split(" ");
					const verb = words.shift() ?? "";
					const rest = words.join(" ");
					// With no glyphs left (round 8), an ERROR paints the whole
					// sentence red — that is the alarm now.
					// Open = LIT (round 22, the two-white pass): the expanded
					// panel's head wears the bright text tier — the same light
					// hover previews — and folding returns it to the low white.
					const tone = (t: string) => (errState ? this.fg("error", t) : collapsed ? callFg(t) : this.fg("text", t));
					// The leading space matches the 1-column lead every pi
					// renderer gives its first row. Open = LIT only: the verb keeps
					// its bold in both states, the rest never bolds (the earlier
					// full-bold open head was retracted by the maintainer).
					sentence = ` ${this.bold(tone(verb))}` + (rest ? ` ${tone(rest)}` : "");
					// edit's diff stat colours like a diff: +N green, −M red
					// (round 16) — unless the whole sentence is already red.
					if (!errState && toolNameLc === "edit") {
						const dm = /\(\+(\d+) −(\d+)\)/.exec(plain ?? "");
						if (dm)
							sentence = sentence.replace(
								`(+${dm[1]} −${dm[2]})`,
								`${tone("(")}${this.fg("success", `+${dm[1]}`)} ${this.fg("error", `−${dm[2]}`)}${tone(")")}`,
							);
					}
					// width-5, not width-2: a sentence is also a cluster MEMBER's
					// head, shifted +3 — at width-2 it overflowed by one column
					// there (the 80-column overflow audit, 2026-08-22).
					// A sub-tenth duration reports nothing — "0.0s" on every
					// quick command is pure noise; only real waits earn the tail.
					if (took && !/^0\.0s$/.test(took) && !partial) sentence += this.fg("dim", ` · ${took}`);
					if (visibleWidth(sentence) > width - 5) sentence = ansiTruncate(sentence, Math.max(4, width - 5));
				}

				// The whole EXPANDED beat is one raised panel: the head row on
				// the field, then the evidence in nested ⎿ CHUNKS — each chunk
				// opens with a dim marker and indents +3 under the previous
				// (round 7: bash's output carries its own ⎿ under the `$ cmd`
				// chunk, so command and output read apart). No synthetic blank
				// rows; the evidence's own internal blanks are content, runs
				// collapse to one.
				const fieldRow = (row: string) => {
					try {
						return (this.theme as any).bg(errState ? "toolErrorBg" : "toolPendingBg", row) as string;
					} catch {
						return row;
					}
				};
				const lastContent = (rows: string[]) => {
					let last = rows.length - 1;
					while (last >= 0 && !stripAnsi(rows[last]).trim()) last--;
					return last;
				};
				// A chunk marked VERBATIM keeps its interior blanks exactly —
				// the bash COMMAND is quoted source text, and hiding its empty
				// lines made the (correct) blank lines in the output look like
				// a rendering bug (round 12). Since 2026-08-22 every OUTPUT chunk
				// is verbatim as well — a document's blank under its title line
				// is content (the search panel lost it while the wire view kept
				// it; maintainer: reconcile). The tidy policy — gap-close after
				// the marker row and after headings, blank runs collapsed — is
				// now the subagent panel's alone (Prompt/Response hug their text).
				const pushEvidence = (chunksIn: { rows: string[]; verbatim?: boolean }[], marker = "⎿") => {
					const chunks = chunksIn.filter((c) => lastContent(c.rows) >= 0);
					// ⎿ keeps its two-column block (`⎿  text`); the subagent's └
					// sits bare (`└ Prompt` — round 18). Continuations align to
					// the first row's text either way.
					const markerBlock = marker === "⎿" ? "⎿ " : marker;
					const contPad = " ".repeat(1 + visibleWidth(markerBlock));
					for (let ci = 0; ci < chunks.length; ci++) {
						const rows = chunks[ci].rows;
						const verbatim = !!chunks[ci].verbatim;
						const last = lastContent(rows);
						const pad = contPad.repeat(ci);
						let put = 0;
						let blankRun = false;
						let afterHeading = false;
						for (let i = 0; i <= last; i++) {
							const vis = stripAnsi(rows[i]).trim();
							if (!vis) {
								// Leading blanks always drop. Verbatim chunks keep
								// every other blank as-is; tidy chunks also drop the
								// gap after the marker row and after a section
								// heading (Prompt/Response hug their text), and
								// collapse blank runs to one.
								if (!put) continue;
								if (!verbatim && (put <= 1 || blankRun || afterHeading)) continue;
								blankRun = true;
								body.push(fieldRow(""));
								continue;
							}
							blankRun = false;
							const prefix = put ? `${pad}${contPad}` : `${pad} ${this.fg("dim", markerBlock)}`;
							put++;
							// A row that OPENS with its own background — edit's tinted
							// diff line — is a bar: it owns the row from the left edge
							// (pad and ⎿ column included) to the fill, or the bar reads
							// cut where the field shows through under the marker column
							// (maintainer, on the catalogue). leadingBg is the render
							// loop's own rule for what fills a row.
							const bar = openingBg(rows[i]);
							body.push(bar ? `${bar}${prefix}${rows[i]}` : fieldRow(`${prefix}${rows[i]}`));
							afterHeading = /^(Prompt|Response|Progress)$/.test(vis);
						}
					}
				};
				/**
				 * Snippet renderer (round 23, the WORKING experience):
				 * pushEvidence's shape — ⎿-led chunks, continuations aligned —
				 * but WITHOUT the field bg (an open panel is lit and fielded; a
				 * snippet is a leak from a still-collapsed act), capped to the
				 * tool's row budget with an honest `+N rows` tail.
				 */
				// The working leak is QUIET (maintainer, 2026-08-18): the rows a
				// collapsed act shows while the model works wear the low white
				// relative to the prose — the field palette, the evidence tier and
				// a highlighted command belong to the OPEN panel, not to the
				// window. Every foreground goes to `muted`; the error red stays
				// (state), bold/italic and any background (a diff bar) stay.
				const mutedSeq = (() => {
					try {
						return (this.theme as any).fg("muted", "\0").split("\0")[0] as string;
					} catch {
						return "";
					}
				})();
				const errSeq0 = (() => {
					try {
						return (this.theme as any).fg("error", "\0").split("\0")[0] as string;
					} catch {
						return "";
					}
				})();
				const quiet = (row: string) =>
					mutedSeq
						? mutedSeq +
							row.replace(/\x1b\[(?:38;[0-9;:]*m|3[0-7]m|9[0-7]m)/g, (m) => (errSeq0 && m === errSeq0 ? m : mutedSeq)) +
							"\x1b[39m"
						: row;
				const pushSnippet = (chunksIn: { rows: string[]; verbatim?: boolean }[], cap: number): number => {
					const chunks = chunksIn.filter((c) => lastContent(c.rows) >= 0);
					const markerBlock = "⎿ ";
					const contPad = " ".repeat(1 + visibleWidth(markerBlock));
					let put = 0;
					let hidden = 0;
					for (let ci = 0; ci < chunks.length; ci++) {
						const rows = chunks[ci].rows;
						const verbatim = !!chunks[ci].verbatim;
						const last = lastContent(rows);
						const pad = contPad.repeat(ci);
						let chunkPut = 0;
						let blankRun = false;
						for (let i = 0; i <= last; i++) {
							const vis = stripAnsi(rows[i]).trim();
							if (!vis) {
								if (!chunkPut) continue;
								if (!verbatim && (chunkPut <= 1 || blankRun)) continue;
								blankRun = true;
								if (put >= cap) continue;
								body.push("");
								put++;
								continue;
							}
							blankRun = false;
							if (put >= cap) {
								hidden++;
								continue;
							}
							const prefix = chunkPut ? `${pad}${contPad}` : `${pad} ${this.fg("dim", markerBlock)}`;
							chunkPut++;
							put++;
							// Same bar rule as pushEvidence: a self-backgrounded row
							// owns its whole row.
							const bar = openingBg(rows[i]);
							body.push(`${bar}${prefix}${quiet(rows[i])}`);
						}
					}
					// LINES, never rows — one counting vocabulary with thinking
					// (round 30, maintainer).
					if (hidden > 0) body.push(` ${this.fg("dim", `… +${plural(hidden, "line")}`)}`);
					return hidden;
				};
				// Content-col span for the FOLD click while collapsed: expanding
				// needs the click ON the sentence text; collapsing an open panel
				// accepts the whole area (round 6).
				let foldSpan: { a: number; b: number } | undefined;
				/** Body rows of a working snippet — with the sentence, the control while the model works (see below). */
				const snippetRows: number[] = [];
				// The per-beat wire toggle (see wireView), the ctrl+click action:
				// on an EXPANDED panel it flips pretty ↔ wire; on a COLLAPSED act
				// it expands straight INTO wire — the gesture means "show me the
				// wire", so it never lands you on a pretty panel.
				const wireToggle = () => {
					if (collapsed) {
						wireView.set(sub, true);
						toolOverride.set(sub, { gen: toolGen, val: true });
					} else wireView.set(sub, !wireOn(sub));
					trace({ ev: "wire", tool: toolNameLc, on: wireOn(sub) ? 1 : 0 });
					this.follow = false;
					this.liveDirty = true;
					this.tui.requestRender();
				};
				/**
				 * The wire-state tell: a dim `· wire` on the head row. Sliced to
				 * the row's visible width first — renderer rows arrive
				 * WIDTH-PADDED with trailing spaces (the spanOf rule), so a bare
				 * append parked the tell past the right edge, where the render
				 * loop sliced it off (demonstrated when this was a button); the
				 * attribute reset keeps an open bold from bleeding into it.
				 */
				const withTell = (row: string): string => {
					const vw = visibleWidth(stripAnsi(row).replace(/\s+$/, ""));
					if (vw > width - 9) return row; // no room — the wire evidence itself is the tell
					return sliceByColumn(row, 0, vw, false) + "\x1b[22;23;24m" + this.fg("dim", " · wire");
				};
				/** WIRE evidence: the verbatim result text, wrapped, output tier. */
				const pushWireEvidence = () => {
					const rows: string[] = [];
					for (const src of wtxt.split("\n")) {
						if (!src.trim()) {
							rows.push("");
							continue;
						}
						for (const wl of wrapPlain(sanitize(src), Math.max(4, toolW - 1)))
							rows.push(` ${this.fg("toolOutput", wl)}`);
					}
					pushEvidence([{ rows, verbatim: true }]);
				};
				if (!collapsed && wire) {
					// WIRE, EXPANDED: the head row keeps its place and form (plus
					// the dim `· wire` tell); the evidence is EXACTLY what the
					// model read — for write/edit the confirmation sentence, never
					// the pretty body; stamps, run ids and notices included,
					// nothing else (the args came FROM the model; the run tree is
					// the pretty view's affordance).
					let headRow: string;
					if (sentence !== undefined) headRow = sentence;
					else {
						const ci = call.findIndex((l) => stripAnsi(l).trim());
						headRow = ci >= 0 ? this.liftToText(call[ci]) : this.fg("toolTitle", toolName || "tool");
					}
					headRow = withTell(headRow);
					body.push(fieldRow(headRow));
					pushWireEvidence();
				} else if (!collapsed && sentence !== undefined) {
					// Known act, EXPANDED: the sentence row, then the evidence.
					// bash's `$ command` chunk leads and its OUTPUT nests under
					// it; webfetch/websearch raw JSON args stay hidden (they
					// only restate the sentence). No hover handle on an OPEN head
					// (2026-08-22, maintainer): open is already lit, and the light
					// substitution brightened the head's dim tail (`· 1.0s`,
					// `· wire`) under the mouse; hover is a tell for what a click
					// would OPEN, and a click here folds.
					body.push(fieldRow(sentence));
					const out = output.slice(0, lastContent(output) + 1);
					if (bashLike) {
						// bash is RAW text on both sides — blanks are content.
						pushEvidence([
							{ rows: call, verbatim: true },
							{ rows: out, verbatim: true },
						]);
					} else if (toolNameLc === "write" || toolNameLc === "edit") {
						// Their stats + body live in the CALL render (streaming —
						// see visual/tools/write.ts); the evidence is the call
						// MINUS its title row plus any result rows — and MINUS
						// the stats row, which the sentence already states
						// (round 16: "wrote 3 lines" was said twice). A CANVAS
						// write instead KEEPS the stats row (its sentence names
						// the title, not the size) and opens with the full
						// path, dim (the contract: path, size, source).
						const ti = call.findIndex((l) => stripAnsi(l).trim());
						const cp = toolNameLc === "write" ? canvasPathOf((sub as any).args) : null;
						// The canvas panel is TIGHT (2026-08-26, maintainer): the
						// call render's structural blanks (the title/stats/body
						// separators) go. A blank SOURCE line is safe — the
						// gutter draws it as its numbered row, never empty.
						const evRows = [
							...(cp ? wrapTextWithAnsi(this.fg("dim", cp), Math.max(4, width - 10)) : []),
							...(cp ? call.slice(ti + 1).filter((r) => stripAnsi(r).trim() !== "") : call.slice(ti + 1)),
							...out,
						];
						pushEvidence([{ rows: cp ? evRows : evRows.filter(notStats) }]);
					} else if (toolNameLc === "read") {
						pushEvidence([{ rows: out.filter(notStats) }]);
					} else if (mcpFamily) {
						// The gateway's args JSON is real evidence (the query, the
						// path), unlike webfetch's url which only restates the
						// sentence: it opens as the first chunk, the result under it.
						// mcpScript's code and a direct tool's args the same way.
						// The RESULT is verbatim too (2026-08-22): the tidy policy's
						// gap-close after the first row ate the blank under a
						// document's title line — `Search results for …:` sat flush
						// on `1.` while the wire view kept its breath (maintainer:
						// reconcile). Tidy stays for the subagent's Prompt/Response.
						const ci = call.findIndex((l) => stripAnsi(l).trim());
						pushEvidence([
							{ rows: call.slice(ci + 1), verbatim: true },
							{ rows: out, verbatim: true },
						]);
					} else {
						pushEvidence([{ rows: out, verbatim: true }]);
					}
				} else if (!collapsed) {
					// The subagent (and unknown tools), EXPANDED: every call row
					// at its RESTING x-position (fieldRow, no indent shift — the
					// tree must not move when the beat opens). The tree becomes
					// one connected trunk (round 7): the root's `└─` turns `├─`,
					// a dim │ rail runs down the └ column, and the evidence
					// opens with `└─` closing the trunk. sliceByColumn keeps the
					// APC run-markers, so tree rows stay clickable (probed).
					let callFrom = 0;
					while (callFrom < call.length && !stripAnsi(call[callFrom]).trim()) callFrom++;
					for (let ci = callFrom; ci < call.length; ci++) {
						let row = call[ci];
						// Open = LIT: the head row arrives pre-painted by its
						// renderer (wdCall for the subagent, dimmed fallback paint
						// for MCP), so LIFT its foreground to the text tier and keep
						// whatever bold/italic the renderer set — never bold the
						// whole row (retracted by the maintainer).
						if (ci === callFrom) row = this.liftToText(row);
						body.push(fieldRow(row));
						// A run-tree row is a control in BOTH fold states — its click
						// opens the run — so it hovers like the working form's tree
						// rows do (the head is already lit; an open panel's head does
						// not light further). The expanded panel registered the click
						// but never the hover tell (demonstrated: `✔ runner • …` under
						// the mouse stayed low).
						if (ci !== callFrom && runMarkId(row)) bodyHandles.push({ row: body.length - 1, ...spanOf(row) });
					}
					pushRunMarks(-callFrom);
					// The evidence, from SOURCE (2026-08-22, maintainer's sketch):
					//   ⎿  <the prompt>                       evidence tier
					//      ⎿  <the response, or the receipt>  muted, run id last
					// — no Prompt/Response headings (they were the renderer's;
					// the pager builds this itself like the MCP args). A
					// background receipt stays italic; the run id closes the
					// nested chunk in the same muted tier. Unknown tools (no
					// task) keep the renderer's rows.
					// The task is `message` since the 2026-08-24 rename (`question`
					// for ask; `task` for transcripts recorded before). Reading
					// `task` alone left this branch dead and every expanded run act
					// fell back to the renderer's rows, headings and all — the
					// "Prompt"/"Response" box the maintainer saw (2026-08-29).
					const sargs0 = ((sub as any).args ?? {}) as Record<string, unknown>;
					const task =
						typeof sargs0.message === "string"
							? sargs0.message
							: typeof sargs0.question === "string"
								? sargs0.question
								: typeof sargs0.task === "string"
									? sargs0.task
									: "";
					if (labelFold && task) {
						const inner = Math.max(4, toolW - 1);
						const ev = evidenceSeq(this.theme);
						const promptRows: string[] = [];
						for (const src of task.split("\n")) {
							if (!src.trim()) {
								promptRows.push("");
								continue;
							}
							for (const wl of wrapPlain(sanitize(src), inner)) promptRows.push(` ${ev ? `${ev}${wl}\x1b[39m` : wl}`);
						}
						// The run id is WIRE-ONLY (2026-08-22, maintainer) — the
						// station lists it; so is the receipt's italic (retired).
						const rtxt = resultWireText((sub as any).result).trim();
						const { head: rbody } = splitTrailer(rtxt);
						const responseRows: string[] = [];
						for (const src of rbody.split("\n")) {
							if (!src.trim()) {
								responseRows.push("");
								continue;
							}
							for (const wl of wrapPlain(sanitize(src), Math.max(4, inner - 3)))
								responseRows.push(` ${this.fg("muted", wl)}`);
						}
						pushEvidence([
							{ rows: promptRows, verbatim: true },
							{ rows: responseRows, verbatim: true },
						]);
					} else pushEvidence([{ rows: output }]);
				} else if (labelFold && (familyLive || snippet || partial)) {
					// The subagent's WORKING form is its CALL alone — the verb
					// line plus the run tree, which is part of the call's
					// identity (Prompt and Response live behind the fold). The
					// verb row is the hover tell, like every other act sentence.
					// Shown while the family is live (foreground or background),
					// or inside the working window — the tree IS this tool's
					// snippet (round 23).
					pushAll(body, call);
					pushRunMarks(0);
					// Every call row hovers: the verb row as the fold tell, the
					// tree rows as run-open tells (round 6).
					let vi = -1;
					for (let bi = 0; bi < body.length; bi++) {
						if (!stripAnsi(body[bi]).trim()) continue;
						if (vi < 0) vi = bi;
						bodyHandles.push({ row: bi, ...spanOf(body[bi]) });
					}
					if (vi >= 0) foldSpan = spanOf(body[vi]);
				} else if (labelFold) {
					// ONE line at rest (round 23, maintainer verdict): a SETTLED
					// subagent joins the one-line doctrine — who ran, what it was
					// asked, how long — with the tree, Prompt and Response all
					// behind the fold. A live family never takes this form (the
					// branch above wins), so a working tree is never hidden.
					const sargs = ((sub as any).args ?? {}) as Record<string, unknown>;
					const agent = rootRun?.agent ?? (typeof sargs.agent === "string" && sargs.agent ? sargs.agent : "adhoc");
					const title =
						rootRun?.title ??
						(typeof sargs.title === "string" && sargs.title.trim()
							? sargs.title.trim()
							: typeof sargs.task === "string"
								? sargs.task.split("\n")[0].slice(0, 60)
								: "…");
					const tone2 = (t: string) => (actErr ? this.fg("error", t) : callFg(t));
					// `started`, the cluster's own verb (2026-08-29: the member said
					// "launched" under a header saying "started 1 agent"), and no
					// `background` tail — every run is one now, there is no other.
					let row = ` ${this.bold(tone2("started"))} ${tone2(`${agent} • ${title}`)}`;
					const kidsN = runId0 ? descendantCount(runId0) : 0;
					// A background launch shows no clock while its run is still
					// working (the strip ticks; the delivery will say how long).
					const el =
						rootRun && !(bgLaunch && (rootRun.status === "working" || rootRun.status === "queued"))
							? elapsedOf(rootRun)
							: "";
					const tail2 = [kidsN ? `+${plural(kidsN, "run")}` : "", el].filter(Boolean).join(" · ");
					if (tail2) row += this.fg("dim", ` · ${tail2}`);
					if (visibleWidth(row) > width - 5) row = ansiTruncate(row, Math.max(4, width - 5));
					body.push(row);
					bodyHandles.push({ row: body.length - 1, ...spanOf(row) });
					foldSpan = spanOf(row);
				} else {
					// A collapsed act rests as its SENTENCE ALONE (round 4: the
					// ⎿ report lives behind the fold; the red triangle already
					// says something went wrong). Unknown tools rest as their
					// call line.
					let row = sentence;
					if (row === undefined) {
						const ci2 = call.findIndex((l) => stripAnsi(l).trim());
						row = ci2 >= 0 ? call[ci2] : this.fg("toolTitle", toolName || "tool");
					}
					body.push(row);
					// The resting row HOVERS whatever produced it — a sentence or, for
					// a tool outside the grammar (an MCP direct tool), its own call
					// line. The handle used to be gated on `sentence`, so those rows
					// were clickable (foldSpan below) but never lit under the mouse
					// (demonstrated in the working window, where nothing clusters).
					bodyHandles.push({ row: body.length - 1, ...spanOf(row) });
					foldSpan = spanOf(row);
					// WORKING transparency (round 23): inside the working window
					// a collapsed act leaks a snippet. Budgets are the
					// maintainer's: default 5 rows FROM THE CALL (bash: command
					// first, then output — never the output tail), write 15,
					// edit the full diff; read/webfetch/kimi-websearch stay
					// sentence-only; unknown tools (MCP included) show only
					// their call's args, never output.
					if (snippet) {
						// The Took/Elapsed footer is noise in a snippet — the
						// settled sentence carries real durations already.
						const outAll = output
							.slice(0, lastContent(output) + 1)
							.filter((l) => !/^(Took|Elapsed)\b/.test(stripAnsi(l).trim()));
						const out2 = outAll.slice(0, lastContent(outAll) + 1);
						let chunks: { rows: string[]; verbatim?: boolean }[] | null = null;
						let cap = 5;
						if (toolNameLc === "read" || toolNameLc === "webfetch" || toolNameLc === "kimi-websearch") {
							chunks = null;
						} else if (bashLike) {
							chunks = [
								{ rows: call, verbatim: true },
								{ rows: out2, verbatim: true },
							];
						} else if (toolNameLc === "write" || toolNameLc === "edit") {
							const ti = call.findIndex((l) => stripAnsi(l).trim());
							const cp2 = toolNameLc === "write" ? canvasPathOf((sub as any).args) : null;
							const rows2 = [
								...(cp2 ? wrapTextWithAnsi(this.fg("dim", cp2), Math.max(4, width - 10)) : []),
								...(cp2 ? call.slice(ti + 1).filter((r) => stripAnsi(r).trim() !== "") : call.slice(ti + 1)),
								...out2,
							];
							chunks = [{ rows: cp2 ? rows2 : rows2.filter(notStats) }];
							cap = toolNameLc === "edit" ? Number.MAX_SAFE_INTEGER : 15;
						} else if (plain === undefined || mcpFamily) {
							// Unknown/MCP: the call already leads the beat (or, for the
							// MCP family, the sentence does), so the snippet is the call's
							// REMAINING rows (the args, or the script's code), no output.
							const ci3 = call.findIndex((l) => stripAnsi(l).trim());
							const rest = call.slice(ci3 + 1);
							chunks = rest.some((l) => stripAnsi(l).trim()) ? [{ rows: rest, verbatim: true }] : null;
						} else {
							chunks = [{ rows: call, verbatim: true }, { rows: out2 }];
						}
						if (chunks) pushSnippet(chunks, cap);
						// In the WORKING window the sentence AND its leaked rows are
						// ONE control (2026-08-20, maintainer): they light together
						// under the mouse and each row is clickable over its own
						// text, like the working thinking view. A snippet that hides
						// nothing used to be "complete: no light, no click" (the
						// 2026-08-20 rule); OVERTURNED 2026-08-28 by the maintainer:
						// opening is for readability — the panel's field and syntax —
						// not only for hidden rows, so every lit row is a handle.
						if (body.length > 1) {
							for (let bi = 1; bi < body.length; bi++) if (stripAnsi(body[bi]).trim()) snippetRows.push(bi);
							for (const bi of snippetRows) bodyHandles.push({ row: bi, ...spanOf(body[bi]) });
						}
					}
				}
				const foldAction = () => {
					const before = pagerToolExpanded(sub);
					toolOverride.set(sub, { gen: toolGen, val: !before });
					if (!before) this.collapseAnchor.set(sub, this.lastClickScreenRow);
					else this.pendingScrollBeat = sub;
					// Did the flip actually stick to the component the next
					// render will read? If `after` disagrees with !before the
					// override is landing on a different object than the one
					// being rendered.
					trace({
						ev: "toggle",
						tool: String((sub as any).toolName ?? "?"),
						partial: (sub as any).isPartial ? 1 : 0,
						before: before ? 1 : 0,
						after: pagerToolExpanded(sub) ? 1 : 0,
					});
					this.follow = false;
					this.liveDirty = true;
					this.tui.requestRender();
				};
				if (snippetRows.length) {
					// Per-row text spans (the thinking window's rule): the sentence
					// and every lit row, each clickable over its own text — a
					// complete snippet too (2026-08-28; `snippetFull` now only
					// says whether the `… +N lines` tail exists).
					bodyRanges.push({ s: 0, e: 1, ...foldSpan, action: foldAction });
					for (const bi of snippetRows) bodyRanges.push({ s: bi, e: bi + 1, ...spanOf(body[bi]), action: foldAction });
				} else {
					bodyRanges.push({
						s: 0,
						e: body.length,
						...(collapsed ? foldSpan : undefined),
						action: foldAction,
					});
				}
				// A canvas act's TITLE is the link (2026-08-26, maintainer): the
				// resting surface never carries the raw path, so CTRL+CLICK on
				// the title opens the file — a text-gated ctrl range, resolved
				// before the token probe (the [^image N] precedent). BOTH fold
				// states: the head row is FOUND by its sentence lead — a fixed
				// s:0 sat on the open panel's breathing pad, and the wire
				// fallback swallowed the expanded click (maintainer, same day).
				if (toolNameLc === "write" && plain) {
					const cvp = canvasPathOf((sub as any).args);
					const ti9 = plain.indexOf("• ");
					if (cvp && ti9 >= 0) {
						const mark = ` ${plain.slice(0, ti9 + 2)}`;
						const hr = body.findIndex((r) => stripAnsi(r).startsWith(mark));
						if (hr >= 0) {
							const drawn = spanOf(body[hr]);
							const a9 = visibleWidth(mark);
							const b9 = Math.min(1 + visibleWidth(plain), drawn.b);
							if (b9 > a9)
								bodyRanges.push({ s: hr, e: hr + 1, ctrl: true, a: a9, b: b9, action: () => this.openFile(cvp) });
						}
					}
				}
				// The wire toggle rides CTRL+CLICK, row-wide over the whole beat
				// in both fold states (token-open wins on a path or URL —
				// handleCtrlClick resolves the token first). Gated on wire text:
				// a still-streaming act has no result yet.
				if (wtxt) bodyRanges.push({ s: 0, e: body.length, ctrl: true, action: wireToggle });
				const flushed = this.flushBeat(lines, ranges, blocks, body, bodyRanges, bodyBlocks, 0, bodyHandles);
				return {
					lines,
					ranges,
					blocks,
					head:
						flushed.head === undefined
							? undefined
							: {
									row: flushed.head,
									glyph: liveAct ? this.beatGlyph("running") : this.fg(actErr ? "error" : "success", "●"),
								},
					handles: flushed.handles,
					// The working sentence + snippet hover as ONE control.
					groupHandles: snippetRows.length ? true : undefined,
					kind: collapsed ? "act" : "open",
					pad: collapsed ? undefined : fieldRow(""),
					// Present for EVERY tool beat, expanded or not — clustering
					// keeps expanded members inside the cluster (round 3: an
					// expanded member used to split the batch and "eat" the
					// cluster header). The subagent clusters too since round 23,
					// but only once its whole run family has settled — a live
					// family reads as running here, which keeps it out.
					// The agent tool's non-run actions cluster in their own words
					// (agent-message, agent-ask, …), never as `started N agents`.
					act: {
						tool:
							toolNameLc === "agent" &&
							typeof ((sub as any).args ?? {}).action === "string" &&
							((sub as any).args as any).action !== "run"
								? `agent-${((sub as any).args as any).action}`
								: toolNameLc === "write" && canvasPathOf((sub as any).args)
									? "canvas"
									: toolNameLc,
						err: actErr,
						running: liveAct,
					},
				};
			}
			const ask = askEntryOf(sub);
			const own = ownResultKind(sub) ?? (ask ? ("ask-entry" as const) : undefined);
			if (own) {
				// A BATCH (`background-results`, tools/delivery.ts) is N sections,
				// each parsed as if it had arrived alone; the beat's sentence
				// counts them and the evidence lists each under its own sentence.
				const parts: ParsedResultMessage[] =
					own === "ask-entry"
						? [
								{
									head: `asked ${String(ask?.target ?? "this session")} · ${String(ask?.q ?? "").split("\n")[0]}`,
									state: "",
									stateWord: "",
									failed: !!ask?.err,
									// The fold carries the WHOLE exchange — the sentence
									// truncates a long question, so Q comes back here in
									// full, then A (maintainer: "I only get the A").
									body: `Q: ${String(ask?.q ?? "")}\n\nA: ${String(ask?.err ?? ask?.a ?? "…")}`,
									trailer: "",
									raw: `Q: ${String(ask?.q ?? "")}\nA: ${String(ask?.a ?? ask?.err ?? "")}`,
								} as ParsedResultMessage,
							]
						: own === "background-results"
							? parseBatchResultMessage(ownMessageOf(sub))
							: own === "agent-result" || own === "subagent-result"
								? [parseSubagentResultMessage(ownMessageOf(sub))]
								: own === "peer-message"
									? [parsePeerMessage(ownMessageOf(sub))]
									: own === "session-brief"
										? [parseBriefMessage(ownMessageOf(sub))]
										: own === "inject"
											? [parseInjectMessage(ownMessageOf(sub))]
											: [parseBashResultMessage(ownMessageOf(sub))];
				const isBatch = own === "background-results";
				const parsed: ParsedResultMessage = parts[0];
				const collapsed = !pagerToolExpanded(sub);
				const failedN = parts.filter((p) => p.failed).length;
				const errState = isBatch ? failedN === parts.length : parsed.failed;
				const callFg = (t: string) => {
					try {
						return (this.theme as any).fg("wdCall", t) as string;
					} catch {
						return this.fg("toolOutput", t);
					}
				};
				// Same tone rule as every act sentence: red when failed, the low
				// white at rest, the text tier when open (open = LIT). The STATE
				// word bolds — it is this sentence's verb (finished / timed out /
				// was stopped / failed); the head names what it was.
				const tone = (t: string) => (errState ? this.fg("error", t) : collapsed ? callFg(t) : this.fg("text", t));
				const sentenceOf = (p: ParsedResultMessage, paint: (t: string) => string) => {
					let row = ` ${paint(p.head)}`;
					if (p.state)
						row += p.stateWord
							? ` ${this.bold(paint(p.stateWord))}${paint(p.state.slice(p.stateWord.length))}`
							: ` ${paint(p.state)}`;
					return row;
				};
				let sentence =
					own === "ask-entry"
						? ` ${this.bold(tone("asked"))} ${tone(`${String(ask?.target ?? "this session")} · ${String(ask?.q ?? "").split("\n")[0]}`)}${
								ask?.shared ? this.fg("dim", " · shared") : ""
							}`
						: isBatch
							? ` ${tone(`${parts.length} background results`)} ${this.bold(
									tone(
										// A batch of stops (a session end's notice) did not
										// "finish" (2026-08-29, the real-model drive: four
										// jobs killed by /reload read `finished`).
										parts.every((p) => /^(was stopped|was interrupted)/.test(p.stateWord)) ? "stopped" : "finished",
									),
								)}` + (failedN && !errState ? ` ${this.fg("error", `· ${failedN} failed`)}` : "")
							: sentenceOf(parsed, tone);
				if (visibleWidth(sentence) > width - 5) sentence = ansiTruncate(sentence, Math.max(4, width - 5));
				// The evidence: the delivered text, wrapped to the evidence column
				// (⎿ plus two spaces), source blanks kept as paragraph breaks, the
				// run-id trailer dim on the last row.
				// The DEEPEST seat these rows can occupy: the ⎿ block (4 columns)
				// inside an open cluster member (+3), same rule as the tool branch's
				// toolW — at width-6 a member's rows overflowed and the render loop
				// sliced their last characters (`little sho`, demonstrated).
				const inner = Math.max(4, width - 10);
				const evidence: string[] = [];
				for (const p of parts) {
					// In a batch every section opens with its own sentence — the LOW
					// white like a cluster member (the head above is the lit one;
					// maintainer, 2026-08-22: "it's not dim??"), red when that job
					// failed, state word bold — its body under it.
					if (isBatch) {
						if (evidence.length) evidence.push("");
						// Wrapped at the evidence width like the body — an unbounded
						// sentence overflowed as a member (the 80-column audit).
						const sect = sentenceOf(p, (t) => (p.failed ? this.fg("error", t) : this.fg("muted", t))).trimStart();
						for (const wl of wrapTextWithAnsi(sect, inner)) evidence.push(wl);
					}
					for (const raw of p.body.split("\n")) {
						if (!raw.trim()) {
							evidence.push("");
							continue;
						}
						for (const wl of wrapPlain(sanitize(raw), inner)) evidence.push(this.fg("toolOutput", wl));
					}
				}
				// The run id is WIRE-ONLY since 2026-08-22 (maintainer; it was dim
				// on the last row) — the station carries it, ctrl+click shows it.
				const fieldRow = (row: string) => {
					try {
						return (this.theme as any).bg(errState ? "toolErrorBg" : "toolPendingBg", row) as string;
					} catch {
						return row;
					}
				};
				// The wire view of a delivery is the custom message VERBATIM —
				// provenance first line, run id, stamp — everything the parsers
				// subtract for the pretty form. The toggle rides ctrl+click like
				// every beat (a collapsed one expands straight into wire); the
				// dim `· wire` tell rides the head (the sentence is built clean,
				// so a bare append is safe here).
				const mtxt = own === "ask-entry" ? "" : resultWireText(ownMessageOf(sub));
				const mwire = wireOn(sub) && !!mtxt;
				const wireToggle = () => {
					if (!pagerToolExpanded(sub)) {
						wireView.set(sub, true);
						toolOverride.set(sub, { gen: toolGen, val: true });
					} else wireView.set(sub, !wireOn(sub));
					trace({ ev: "wire", tool: own, on: wireOn(sub) ? 1 : 0 });
					this.follow = false;
					this.liveDirty = true;
					this.tui.requestRender();
				};
				let foldSpan: { a: number; b: number } | undefined;
				/** Body rows of a working snippet: handles and per-row fold ranges. */
				const ownSnippetRows: number[] = [];
				if (!collapsed && mwire) {
					// WIRE, open: verbatim message under the ⎿, blanks kept.
					const head = visibleWidth(sentence) > width - 9 ? sentence : sentence + this.fg("dim", " · wire");
					body.push(fieldRow(head));
					let put = 0;
					for (const src of mtxt.split("\n")) {
						if (!src.trim()) {
							if (put) body.push(fieldRow(""));
							continue;
						}
						for (const wl of wrapPlain(sanitize(src), inner)) {
							body.push(
								fieldRow(
									put ? `    ${this.fg("toolOutput", wl)}` : ` ${this.fg("dim", "⎿ ")} ${this.fg("toolOutput", wl)}`,
								),
							);
							put++;
						}
					}
					while (body.length > 1 && !stripAnsi(body[body.length - 1]).trim()) body.pop();
				} else if (!collapsed) {
					// Open: the head on the field, the evidence under one dim ⎿ —
					// pushEvidence's shape, inlined for this one-chunk beat.
					body.push(fieldRow(sentence));
					let put = 0;
					let blankRun = false;
					for (const row of evidence) {
						if (!stripAnsi(row).trim()) {
							if (!put || blankRun) continue;
							blankRun = true;
							body.push(fieldRow(""));
							continue;
						}
						blankRun = false;
						body.push(fieldRow(put ? `    ${row}` : ` ${this.fg("dim", "⎿ ")} ${row}`));
						put++;
					}
					while (body.length > 1 && !stripAnsi(body[body.length - 1]).trim()) body.pop();
				} else {
					body.push(sentence);
					bodyHandles.push({ row: body.length - 1, ...spanOf(sentence) });
					foldSpan = spanOf(sentence);
					if (snippet) {
						// The working snippet's rows are handles and per-row fold
						// ranges like a tool's (2026-08-28, maintainer: the brief's
						// body neither lit nor opened while the model worked).
						// The working leak: default budget, 5 rows, `… +N lines`
						// tail — the bash rule for its output.
						let put = 0;
						let hidden = 0;
						let blankRun = false;
						for (const row of evidence) {
							if (!stripAnsi(row).trim()) {
								if (!put || blankRun) continue;
								blankRun = true;
								if (put >= 5) continue;
								body.push("");
								put++;
								continue;
							}
							blankRun = false;
							if (put >= 5) {
								hidden++;
								continue;
							}
							body.push(put ? `    ${row}` : ` ${this.fg("dim", "⎿ ")} ${row}`);
							put++;
						}
						while (body.length > 1 && !stripAnsi(body[body.length - 1]).trim()) body.pop();
						if (hidden > 0) body.push(` ${this.fg("dim", `… +${plural(hidden, "line")}`)}`);
						for (let bi = 1; bi < body.length; bi++) {
							if (!stripAnsi(body[bi]).trim()) continue;
							ownSnippetRows.push(bi);
							bodyHandles.push({ row: bi, ...spanOf(body[bi]) });
						}
					}
				}
				bodyBlocks.push({ s: 0, e: body.length, src: parsed.raw });
				if (mtxt) bodyRanges.push({ s: 0, e: body.length, ctrl: true, action: wireToggle });
				const ownFold = () => {
					const before = pagerToolExpanded(sub);
					toolOverride.set(sub, { gen: toolGen, val: !before });
					if (!before) this.collapseAnchor.set(sub, this.lastClickScreenRow);
					else this.pendingScrollBeat = sub;
					trace({
						ev: "toggle",
						tool: own,
						partial: 0,
						before: before ? 1 : 0,
						after: pagerToolExpanded(sub) ? 1 : 0,
					});
					this.follow = false;
					this.liveDirty = true;
					this.tui.requestRender();
				};
				for (const bi of ownSnippetRows) bodyRanges.push({ s: bi, e: bi + 1, ...spanOf(body[bi]), action: ownFold });
				bodyRanges.push({
					s: 0,
					e: body.length,
					...(collapsed ? foldSpan : undefined),
					action: () => {
						const before = pagerToolExpanded(sub);
						toolOverride.set(sub, { gen: toolGen, val: !before });
						if (!before) this.collapseAnchor.set(sub, this.lastClickScreenRow);
						else this.pendingScrollBeat = sub;
						trace({
							ev: "toggle",
							tool: own,
							partial: 0,
							before: before ? 1 : 0,
							after: pagerToolExpanded(sub) ? 1 : 0,
						});
						this.follow = false;
						this.liveDirty = true;
						this.tui.requestRender();
					},
				});
				const flushed = this.flushBeat(lines, ranges, blocks, body, bodyRanges, bodyBlocks, 0, bodyHandles);
				return {
					lines,
					ranges,
					blocks,
					// A settled act's glyph: green, red when failed — shown inside
					// the working window (emitBeat), muted once static like every
					// other act.
					// The ask entry's `?` is the USER's mark, like the prompt's ❯ —
					// the prompt colour, both fold states, never muted.
					head:
						flushed.head === undefined
							? undefined
							: {
									row: flushed.head,
									glyph:
										own === "ask-entry"
											? this.bold(this.promptMark("?"))
											: this.fg(errState ? "error" : "success", "●"),
								},
					handles: flushed.handles,
					// The working sentence + snippet hover as ONE control (the tool rule).
					groupHandles: ownSnippetRows.length ? true : undefined,
					kind: collapsed ? "act" : "open",
					pad: collapsed ? undefined : fieldRow(""),
					act: { tool: own, err: errState, running: false, lines: isBatch ? parts.length : undefined },
				};
			}
			let rendered: string[] = sub?.render?.(width) ?? [];
			// pi's loaded-resources sections ([Extensions], [Themes], …) wrap
			// their one-line item list at the render width with NO hanging
			// indent, so a long list's continuation rows land at column 0
			// (round 3: "the banner is not aligned" — nine themes made the
			// list wrap). Re-flow: header row kept, items re-wrapped with a
			// 2-space hanging indent. Only the compact LIST sections — the
			// warning sections carry meaningful line structure.
			{
				const fi0 = rendered.findIndex((l) => stripAnsi(l).trim());
				const hm =
					fi0 >= 0 ? /^(\s*)(\[(?:Extensions|Themes|Skills|Prompts)\])\s*$/.exec(stripAnsi(rendered[fi0])) : null;
				if (hm && rendered.length > fi0 + 1) {
					const items = rendered
						.slice(fi0 + 1)
						.map((l) => stripAnsi(l).trim())
						.filter(Boolean)
						.join(" ");
					const rebuilt = rendered.slice(0, fi0 + 1);
					// The `[Name]` header wears the identity blue (maintainer,
					// 2026-08-20: "make it blue") — pi paints it `mdHeading`, the
					// white that belongs to the model's markdown headings.
					rebuilt[fi0] = `${hm[1]}${this.fg("customMessageLabel", hm[2])}`;
					for (const wl of wrapPlain(items, Math.max(8, width - 2))) rebuilt.push(`  ${this.fg("dim", wl)}`);
					rendered = rebuilt;
				}
			}
			// The ✸ turn footer: re-seat the star into the glyph column so it
			// aligns with beat heads (its renderer pads it into the content).
			const fi = rendered.findIndex((l) => stripAnsi(l).trim());
			const fiTxt = fi >= 0 ? stripAnsi(rendered[fi]).trimStart() : "";
			if (fiTxt.startsWith("✸") || fiTxt.startsWith("💥")) {
				// The end-blast marker (💥︎ — ✸ in old transcripts), re-seated
				// into the gutter. The blast measures TWO columns in pi-tui, so
				// the render loop drops the pad's lead space for it (padW math
				// holds at 2 either way).
				const plain = fiTxt.replace(/^(?:✸|💥\ufe0e?)\s*/, "");
				body.push(` ${this.fg("dim", plain)}`);
				const flushed = this.flushBeat(lines, ranges, blocks, body, bodyRanges, bodyBlocks, 0);
				return {
					lines,
					ranges,
					blocks,
					head: flushed.head === undefined ? undefined : { row: flushed.head, glyph: this.fg("dim", "✸") },
					kind: "info",
				};
			}
			// The USER PROMPT sheds its background box (maintainer's verdict):
			// it renders as `❯` in the gutter plus the prompt text in the
			// theme's prompt colour (`wdPrompt`, caught fallback to accent) —
			// a voice of its own, distinct from the model's white prose.
			// Detected by the box's own paint: the row's leading bg matches
			// the theme's userMessageBg sequence.
			// Detection keys on the BASE theme: pi rendered these rows with
			// ITS theme, whatever view the pager shows (round 9: the child
			// view's prompt box lost its ❯ because the visor bg never
			// matched). The REPAINT below follows the effective theme.
			const userBgSeq = (() => {
				try {
					return (this.baseTheme as any).bg("userMessageBg", "\0").split("\0")[0] as string;
				} catch {
					return "";
				}
			})();
			const isUserBox =
				!!userBgSeq && typeof sub?.text === "string" && rendered.some((l) => leadingBg(l) === userBgSeq);
			if (isUserBox) {
				// Round 7: the box RETURNS — prompt rows on userMessageBg with
				// WHITE text (the brightest tier, tied with the model's prose),
				// the ❯ keeping its own colour (`wdPrompt`) in the gutter.
				const mark = (s: string) => this.promptMark(s);
				const boxRow = (s: string) => this.promptBoxRow(s);
				const s0 = body.length;
				// The box BREATHES again (maintainer, 2026-08-18: "padding for my
				// prompt too"): one bg-painted empty row above the text and one
				// below, inside the box — the round-20 hug is retracted. These
				// rows are box interior (leadingBg sees the bg), so flushBeat's
				// blank-trim keeps them; the ❯ still lands on the first TEXT row.
				// CTRL+CLICK anywhere on the box flips this one prompt between
				// the pretty form and the VERBATIM submitted text — stamp and
				// attachment footer included (2026-08-22; wire view). The stamp
				// row showing is the state tell.
				const wireU = wireOn(sub);
				body.push(boxRow(""));
				// The zero-width-space guard row (present only in transcripts
				// from before round 15) is compacted out of the display; new
				// wire text has no guard, so display == wire byte-for-byte.
				// The [timestamp: …] line is for the MODEL's clock; under the user's
				// own words it reads as noise, so the display drops it (the wire
				// text keeps it — evidence panels elsewhere show stamps as-is).
				// A worded skill invocation's box opens with what the user typed
				// before the words — `/skill:name ` — the way the `[^image N]`
				// refs stay in them (maintainer, 2026-08-23: the box is the
				// typed line). Pretty only: the wire is pi's verbatim user text,
				// which has the block split off. A PROVENANCE first line — the
				// `[from your user]` / `[from the agent that started you]` a
				// child's messages open with — is the model's, like the stamp:
				// wire-only (maintainer, 2026-08-29).
				const shown = wireU
					? String(sub.text)
					: (lead ?? "") +
						String(sub.text)
							.replace(/^\[from [^\]\n]+\]\n+/, "")
							.replace(/\n\n---\n\u200b\n(?=\[\^image )/, "\n\n---\n")
							.replace(/\n?\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]\s*$/, "");
				// The trailing attachment footer (--- + defs) paints MUTED so
				// it reads as machinery, never as the user's own words.
				let srcRows = shown.split("\n");
				let footFrom = srcRows.length;
				{
					// Wire view: a trailing stamp row (and blanks) sit after the
					// defs — skipped so the footer still reads as footer.
					let i = srcRows.length - 1;
					while (i >= 0 && (!srcRows[i].trim() || STAMP_ROW_RE.test(srcRows[i].trim()))) i--;
					while (i >= 0 && /^\[\^image \d+\]: /.test(srcRows[i])) i--;
					if (i >= 0 && i < srcRows.length - 1 && srcRows[i].trim() === "---") footFrom = i;
				}
				// PRETTY hides the footer outright (2026-08-22, maintainer: wire,
				// not user-facing) — the `[^image N]` refs in the words stay; the
				// wire view shows the `---` and the defs.
				if (!wireU && footFrom < srcRows.length) {
					srcRows = srcRows.slice(0, footFrom);
					while (srcRows.length && !srcRows[srcRows.length - 1].trim()) srcRows.pop();
					footFrom = srcRows.length;
				}
				const boxDim = (t: string) => {
					try {
						return (this.theme as any).bg("userMessageBg", ` ${this.fg("muted", t)}`) as string;
					} catch {
						return ` ${t}`;
					}
				};
				for (let li = 0; li < srcRows.length; li++) {
					const raw = srcRows[li];
					// Machinery rows paint MUTED in the wire view: the stamp, and the
					// provenance first line (2026-08-29, maintainer: consistent
					// with every other wire line).
					const paint =
						li >= footFrom ||
						(wireU && (STAMP_ROW_RE.test(raw.trim()) || (li === 0 && /^\[from [^\]]+\]$/.test(raw.trim()))))
							? boxDim
							: boxRow;
					const wls = wrapPlain(sanitize(raw), Math.max(4, width - 2));
					if (!wls.length || !raw.trim()) {
						body.push(boxRow(""));
						continue;
					}
					for (const wl of wls) body.push(paint(wl));
				}
				// Leading/trailing blank SOURCE lines trim away (interior blanks
				// stay — paragraph breaks are content); the pad rows are box
				// interior, kept outside the trim, so the box is pad + text + pad.
				while (body.length > s0 + 1 && !stripAnsi(body[body.length - 1]).trim()) body.pop();
				while (body.length > s0 + 1 && !stripAnsi(body[s0 + 1]).trim()) body.splice(s0 + 1, 1);
				// No words at all (a no-args `/skill:name`: pi's userMessage is
				// the stamp alone) → no box; the skill act stands on its own.
				if (body.length === s0 + 1 && !wireU) return { lines, ranges, blocks, kind: "box" };
				if (body.length > s0 + 1) bodyBlocks.push({ s: s0 + 1, e: body.length, src: (lead ?? "") + sub.text });
				body.push(boxRow(""));
				// ATTACHMENT rows hang right under the box (2026-08-22, maintainer):
				// one per `[^image N]: path` def in the wire footer, a dim `⎿`
				// row naming the ref and the file; a plain CLICK opens the file
				// in the system viewer (the same xdg-open ctrl+click uses for a
				// path) — an in-terminal block-art preview was tried and dropped
				// the same day: a screenshot's text is unreadable at cell
				// resolution. Ranges are text-gated; hover lights the row.
				{
					const defs: { n: string; file: string }[] = [];
					for (const line of String(sub.text).split("\n")) {
						const m = /^\[\^image (\d+)\]: (.+)$/.exec(line);
						if (m) defs.push({ n: m[1], file: m[2].trim() });
					}
					// Concise (maintainer): the ref alone, in the identity blue the
					// `[Skills]` header wears; CTRL+click opens the file (its ctrl
					// range precedes the box's wire range, so it wins first-match).
					for (const d of defs) {
						const row = ` ${this.fg("dim", "⎿ ")} ${this.fg("customMessageLabel", `[^image ${d.n}]`)}`;
						body.push(row);
						const at = body.length - 1;
						// The span covers the REF, not the ⎿ — which ends at column 3,
						// so the ref (and its `[`) starts at 4 (a=5 missed the `[`).
						const span = { a: 4, b: spanOf(row).b };
						bodyHandles.push({ row: at, ...span });
						bodyRanges.push({ s: at, e: at + 1, ctrl: true, ...span, action: () => this.openFile(d.file) });
					}
				}
				// The wire toggle rides ctrl+click, box-wide (paths in the prompt
				// still open — token-open wins in handleCtrlClick).
				bodyRanges.push({
					s: s0,
					e: body.length,
					ctrl: true,
					action: () => {
						wireView.set(sub, !wireOn(sub));
						trace({ ev: "wire", tool: "prompt", on: wireOn(sub) ? 1 : 0 });
						this.follow = false;
						this.liveDirty = true;
						this.tui.requestRender();
					},
				});
				// The ❯ sits on the first TEXT row — row 1 of the beat, under
				// the top pad.
				const flushed = this.flushBeat(lines, ranges, blocks, body, bodyRanges, bodyBlocks, 1, bodyHandles);
				return {
					lines,
					ranges,
					blocks,
					head: flushed.head === undefined ? undefined : { row: flushed.head, glyph: this.bold(mark("❯")) },
					handles: flushed.handles,
					kind: "box",
				};
			}
			const isBox = rendered.some((l) => leadingBg(l));
			const s0 = body.length;
			// A background box (a custom card) is a beat at content column,
			// its interior padding preserved by the bg-aware trim. Everything
			// else generic is pi INFORMATION — status lines, warnings, the
			// banner blocks — rendered FLUSH, and flush means the terminal
			// edge (round 20, maintainer: "still indented"): pi gives these
			// rows their own 1-space outputPad lead, which parked the text one
			// column right of the beat glyphs, so that column is sliced off.
			//
			// ALL-OR-NOTHING per beat (round 20a, paid for): slicing only the
			// rows that happen to lead with a space breaks vertical alignment
			// between rows. The mascot banner is a PICTURE with mixed leads —
			// its dome/face rows lead with pixel-position spaces while the
			// brim rows start at column 0 — and the per-row slice shifted
			// them one cell apart, shredding the quadrant word art
			// (byte-demonstrated against the raw ART). Only when EVERY
			// non-blank row leads with a space is the shift uniform and safe;
			// otherwise the beat keeps its geometry.
			const nonBlank = rendered.filter((r) => stripAnsi(r).trim());
			const dedent = !isBox && nonBlank.length > 0 && nonBlank.every((r) => stripAnsi(r).startsWith(" "));
			pushAll(
				body,
				// The lead is a LITERAL space after the row's leading escapes, so
				// a splice removes it in O(lead) — the old sliceByColumn walked
				// and re-emitted EVERY character of every row to drop one
				// column: measured 674ms per flatten on /changelog's 8683 rows
				// (round 30 audit). Falls back to the slice if the shape ever
				// differs.
				dedent
					? rendered.map((r) => {
							if (!stripAnsi(r).startsWith(" ")) return r;
							const out = r.replace(
								/^((?:\x1b\[[0-9;:<=>?]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))*) /,
								"$1",
							);
							return out !== r ? out : sliceByColumn(r, 1, 100000, true);
						})
					: rendered,
			);
			// Generic components with raw text are copyable as source too.
			if (typeof sub?.text === "string" && body.length > s0) bodyBlocks.push({ s: s0, e: body.length, src: sub.text });
			this.flushBeat(lines, ranges, blocks, body, bodyRanges, bodyBlocks, undefined);
			return { lines, ranges, blocks, flushLeft: !isBox && lines.length > 0, kind: isBox ? "box" : "info" };
		} catch {
			lines.push("[render error]");
		}
		return { lines, ranges, blocks };
	}

	private renderSubCached(sub: any, width: number, snippet: boolean, lead?: string): RenderedBeat {
		// The snippet flag is part of the SIGNATURE, not the component: the
		// same beat renders differently inside and outside the working
		// window, and a cached transparent render must not survive settle.
		//
		// The cache is honoured by SIGNATURE for every component — the tail
		// included (round 30). The old `fresh` bypass re-rendered the last
		// two components EVERY FRAME, which meant a huge tail component
		// (/changelog's whole markdown, a long final answer) was rebuilt per
		// keystroke and per token: the user-felt lag. Everything live is in
		// the signature — streaming length, partial tick buckets, run-family
		// clocks — so a stale tail is a sigFor bug, not a bypass to restore.
		// `lead` (the `/skill:name ` a worded invocation's box opens with) is
		// neighbour-derived, so it rides the signature, not the component.
		const sig = `${this.sigFor(sub)}|sn${snippet ? 1 : 0}${lead ? `|L${lead}` : ""}`;
		const c = compCache.get(sub);
		if (c && c.w === width && c.sig === sig && c.gen === getCacheGen()) {
			this.lastCacheN++;
			return c;
		}
		this.lastLiveN++;
		const r = this.renderSubFresh(sub, width, snippet, lead);
		compCache.set(sub, {
			w: width,
			gen: getCacheGen(),
			sig,
			lines: r.lines,
			ranges: r.ranges,
			blocks: r.blocks,
			head: r.head,
			handles: r.handles,
			flushLeft: r.flushLeft,
			kind: r.kind,
			marks: r.marks,
			act: r.act,
			pre: r.pre,
			groupHandles: r.groupHandles,
			pad: r.pad,
		});
		return r;
	}

	// Flatten with a PREFIX CACHE: on big sessions the transcript is
	// tens of thousands of lines, and rebuilding the whole array per
	// streaming event was the lag. Everything except the last two chat
	// components (the streaming tail) is cached as a line-prefix keyed
	// by the per-component signatures; steady-state cost is O(tail).
	private flatKey = "";
	private flatPrefix = { lines: 0, ranges: 0, blocks: 0 };
	/**
	 * The COMPONENT index the prefix covers (round 28). When a cluster is
	 * still open at the fresh boundary the prefix ends BEFORE it — the old
	 * forced drain split the last turn's cluster permanently, because the
	 * boundary always sits two components from the end ("subagent still not
	 * clustered", maintainer). Beats between here and the boundary re-emit
	 * each pass from their per-component caches.
	 */
	private flatPrefixComps = 0;

	/** Last flatten's cost in ms — a trace field, so lag is read, not felt. */
	private lastFlatMs = 0;

	/**
	 * pi's live thinking-visibility state, OBSERVED off main's own components.
	 *
	 * `hideThinkingBlock` and `hiddenThinkingLabel` are private on pi's
	 * interactive mode and there is no getter on the extension API — but every
	 * AssistantMessageComponent pi builds carries the current pair, and pi
	 * REBUILDS the whole chat on the shift+tab toggle. Sampled from the newest
	 * assistant message on every main flatten (O(1) in practice: the scan runs
	 * backwards and stops at the first one) and handed to the child transcript
	 * builders, which used to hard-code `false`.
	 */
	private thinkingView: ThinkingView = { hide: false, label: "Thinking..." };
	private noteThinkingView(subs: any[]) {
		for (let i = subs.length - 1; i >= 0; i--) {
			const s = subs[i];
			if (typeof s?.hideThinkingBlock !== "boolean") continue;
			this.thinkingView = {
				hide: s.hideThinkingBlock,
				label: typeof s.hiddenThinkingLabel === "string" ? s.hiddenThinkingLabel : this.thinkingView.label,
			};
			return;
		}
	}

	private flattenLive(contentW: number, kidsOverride?: any[], source = "main") {
		if (
			!this.liveDirty &&
			this.liveWidth === contentW &&
			this.liveSource === source &&
			Date.now() - this.liveAt < LIVE_CACHE_MS
		)
			return;
		const t0 = Date.now();
		// Trace counters for THIS flatten: cache hits vs components rendered
		// fresh (they were declared and traced but never assigned — the
		// dev/internals/README.md documented an instrument that always read 0).
		this.lastCacheN = 0;
		this.lastLiveN = 0;
		const kids = unwrapContainers(kidsOverride ?? this.headKids);
		const subsFlat: any[] = [];
		for (const child of kids) {
			// pushAll, not spread-push: chatContainer holds one child per
			// message/tool, and `push(...arr)` blows the call stack once a
			// transcript gets big enough.
			if (Array.isArray(child?.children)) pushAll(subsFlat, child.children);
		}
		const freshFrom = Math.max(0, subsFlat.length - 2);
		if (source === "main") this.noteThinkingView(subsFlat);
		// WORKING vs STATIC (round 23): while the loop is live, the machinery
		// AFTER the last user prompt stays unclustered and leaks snippets;
		// everything before it — and everything once settled — clusters.
		// Main reads the mirrored agent flag; a child view reads its run.
		const working = source === "main" ? agentWorking : knownRuns.get(source)?.status === "working";
		// The window opens at the last message that STARTED a turn: the user's
		// prompt, or a delivered background result (`subagent-result` /
		// `bash-result` arrive with triggerTurn and wake an idle parent). Keyed
		// on the prompt alone, a delivery's turn reached back to the previous
		// prompt and un-clustered machinery that had already settled — the
		// old turn's acts popped back into the working view with their glyphs
		// (demonstrated by the maintainer).
		let lastUserIdx = -1;
		for (let i = subsFlat.length - 1; i >= 0; i--) {
			if (subsFlat[i] instanceof UserMessageComponent || ownResultKind(subsFlat[i])) {
				lastUserIdx = i;
				break;
			}
		}
		// A prompt sits OUTSIDE the window it opens; a delivery sits INSIDE it —
		// it is machinery of the turn it starts (its act, snippet and glyph show
		// while the model works on it).
		const boundaryIsDelivery = lastUserIdx >= 0 && !!ownResultKind(subsFlat[lastUserIdx]);
		const turnFrom = boundaryIsDelivery ? lastUserIdx : lastUserIdx + 1;
		const transparentFrom = working ? turnFrom : Number.MAX_SAFE_INTEGER;
		const shape = kids.map((k) => (Array.isArray(k?.children) ? `c${k.children.length}` : "x")).join(",");
		// clusterGen is part of the key: an un-merge click changes no
		// component signature, so without it the fast path would serve the
		// merged prefix forever. transparentFrom too: the working window is
		// invisible to component signatures, and a prefix built mid-turn
		// must not survive settle.
		let key = `${source}|${contentW}|g${clusterGen}|c${getCacheGen()}|w${working ? transparentFrom : "x"}|${shape}|`;
		for (let i = 0; i < freshFrom; i++) key += `${this.sigFor(subsFlat[i])};`;

		const lines = this.liveLines;
		const ranges = this.liveRanges;
		const blocks = this.liveBlocks;

		// The cut-off instrument (2026-08-22, maintainer: "I don't want to face
		// this cutoff problem anymore"): every row a beat contributes must fit
		// the content width AFTER its seat shift (+3 as a cluster member). Any
		// row that does not is logged as `ev=overflow` in the layout trace —
		// the class of bug the thinking text, the error turn and the wire
		// control each had once. Trace-only; zero cost otherwise.
		const overflowCheck = (r: RenderedBeat, shift: number) => {
			for (let i = 0; i < r.lines.length; i++) {
				const w = visibleWidth(stripAnsi(r.lines[i]).replace(/\s+$/, "")) + shift;
				if (w > contentW) trace({ ev: "overflow", tool: r.act?.tool ?? r.kind ?? "?", row: i, w, max: contentW });
			}
		};
		const emitBeat = (sub: any, r: RenderedBeat, muteGlyphs = false) => {
			// Spacing is flatten-owned: one blank line before every beat.
			// (Cluster members never come through here — emitMember renders
			// both fold states tight in the list.) muteGlyphs: a SETTLED solo
			// panel in the static view carries no gutter glyphs (round 24) —
			// dots and ◐ are working-only signals.
			lines.push("");
			// An OPEN panel breathes: one field-painted empty row above the
			// head and one below the evidence (maintainer). Outside the beat's
			// own rows, so every relative index below is untouched.
			if (r.pad) lines.push(r.pad);
			const base = lines.length;
			this.beatRows.set(sub, base);
			this.beatLens.set(sub, r.lines.length);
			pushAll(lines, r.lines);
			if (TRACE_PATH) overflowCheck(r, 0);
			if (r.pad) lines.push(r.pad);
			// A range that spans the whole beat row-wide (an open panel's fold)
			// grows to its pad rows: clicking the breathing room folds too.
			const whole = (lr: LocalRange) => r.pad && lr.s === 0 && lr.e === r.lines.length && lr.a === undefined;
			if (r.head && !muteGlyphs) this.liveHeads.set(base + r.head.row, r.head.glyph);
			if (!muteGlyphs) for (const m of r.marks ?? []) this.liveHeads.set(base + m.row, m.glyph);
			if (r.flushLeft) for (let i = 0; i < r.lines.length; i++) this.liveFlush.add(base + i);
			for (const h of r.handles ?? []) this.liveHandles.set(base + h.row, { a: h.a, b: h.b });
			// The working thinking view hovers as ONE control (round 30).
			if (r.groupHandles && (r.handles?.length ?? 0) > 1) {
				const hr = (r.handles ?? []).map((h) => base + h.row);
				const gFrom = Math.min(...hr);
				const gTo = Math.max(...hr) + 1;
				for (const row of hr) this.liveHandleGroup.set(row, { from: gFrom, to: gTo });
			}
			for (const lr of r.ranges)
				ranges.push({
					start: base + lr.s - (whole(lr) ? 1 : 0),
					end: base + lr.e + (whole(lr) ? 1 : 0),
					action: lr.action,
					a: lr.a,
					b: lr.b,
					ctrl: lr.ctrl,
				});
			for (const lb of r.blocks) blocks.push({ s: base + lb.s, e: base + lb.e, src: lb.src });
		};

		// CLUSTERING, first-class since round 23: consecutive MACHINERY beats
		// — errors, expanded members, thinking-only messages and SETTLED
		// subagents included — merge into one summary beat; only the model's
		// prose, the user's prompt, an info/box beat, a still-running act or
		// the working window separates clusters. The summary reads
		// `thought, ran 2 commands, launched 1 subagent · 1 failed`; open
		// keeps the row as a header with the members below — collapsed
		// members restyled as quiet list items (thinking keeps its italics),
		// expanded members as their full panel. Member caches are untouched;
		// clusterOpen + clusterGen carry the toggle, and clusterGen is part
		// of the flatten key below because no component signature changes on
		// this click.
		let pending: { sub: any; r: RenderedBeat; comp: number }[] = [];
		// Where the CURRENT pending batch began — lengths and component index
		// — so the prefix can end before an open cluster (round 28).
		let pendingMark: { lines: number; ranges: number; blocks: number; comp: number } | null = null;
		// Each pending item remembers WHICH component produced it (the prefix
		// rollback below must never cut inside a component's own rows).
		let curComp = 0;
		// Armed once per settle: the header rows of the clusters this flatten
		// forms after the last prompt, flashed when the flatten is done.
		const settleFlashRows: number[] | null = this.settleFlash && !working ? [] : null;
		const emitClusterRow = (
			batch: { sub: any; r: RenderedBeat }[],
			open: boolean,
			soloAction?: () => void,
			soloCtrl?: () => void,
		) => {
			const counts = new Map<string, number>();
			let failed = 0;
			for (const b of batch) {
				const t = b.r.act?.tool ?? "?";
				counts.set(t, (counts.get(t) ?? 0) + 1);
				if (b.r.act?.err) failed++;
			}
			// Open = LIT (round 22): the open cluster's header wears the bright
			// text tier like every opened panel head; closed rests low.
			const callFg = (t: string) => {
				if (open) return this.fg("text", t);
				try {
					return (this.theme as any).fg("wdCall", t) as string;
				} catch {
					return this.fg("toolOutput", t);
				}
			};
			// EVERY verb bolds (round 8 — one bolded verb among plain ones
			// read as an accident): `**ran** 1 command, **read** 1 file`.
			const styled: string[] = [];
			for (const [t, n] of counts) {
				const part = (verb: string, rest: string) => styled.push(`${this.bold(callFg(verb))} ${callFg(rest)}`);
				// Final wording (round 26): a SOLO thinking beat reads
				// `thought for N lines`; inside a multi-item summary it reads
				// `thought N times`. The verb bolds like every other verb.
				if (t === "thinking") {
					const solo = batch.length === 1;
					const tl = solo ? (batch[0].r.act?.lines ?? 0) : 0;
					const rest = solo ? (tl ? `for ${plural(tl, "line")}` : "") : plural(n, "time");
					styled.push(rest ? `${this.bold(callFg("thought"))} ${callFg(rest)}` : this.bold(callFg("thought")));
				} else if (t === "subagent" || t === "agent") part("started", `${n} agent${n === 1 ? "" : "s"}`);
				else if (t === "agent-message") part("messaged", `${n} agent${n === 1 ? "" : "s"}`);
				else if (t === "agent-ask") part("asked", `${n} agent${n === 1 ? "" : "s"}`);
				else if (t === "agent-wait") {
					// Count the REPLIES held for, not the wait acts: one wait on
					// two agents read "held for 1 reply" (2026-08-29).
					const ids = batch
						.filter((b) => b.r.act?.tool === "agent-wait")
						.reduce((sum, b) => {
							const to = ((b.sub as { args?: { to?: unknown } } | undefined)?.args ?? {}).to;
							return sum + (Array.isArray(to) ? to.length : typeof to === "string" ? 1 : 0);
						}, 0);
					part("held", `for ${plural(Math.max(n, ids), "reply")}`);
				} else if (t === "agent-status") part("checked", `${n} agent${n === 1 ? "" : "s"}`);
				else if (t === "agent-stop") part("stopped", `${n} agent${n === 1 ? "" : "s"}`);
				else if (t === "agent-list") part("listed", "agents");
				else if (t === "bash") part("executed", `${n} bash${n === 1 ? "" : "es"}`);
				else if (t === "powershell") part("executed", `${n} powershell command${n === 1 ? "" : "s"}`);
				else if (t === "user-bash") part("ran", `${n} command${n === 1 ? "" : "s"}`);
				else if (t === "read") part("read", plural(n, "file"));
				else if (t === "write") part("wrote", plural(n, "file"));
				// A solo canvas names itself (the skill precedent): the beat's own
				// sentence carries the title AND the created/revised truth —
				// `created 1 canvas` on a revision would lie. n > 1 counts the
				// revised beats (canvasFlags) so an all-revision batch says so.
				else if (t === "canvas") {
					if (batch.length === 1) {
						const row = stripAnsi(batch[0].r.lines[0] ?? "").trim();
						const sp = row.indexOf(" ");
						styled.push(sp > 0 ? `${this.bold(callFg(row.slice(0, sp)))} ${callFg(row.slice(sp + 1))}` : callFg(row));
					} else {
						// `batch` is the WHOLE cluster (a brief can sit beside a
						// canvas beat) — count revised among the CANVAS beats
						// only; conflating batch with kind read `created 1
						// canvases` in a mixed header (demonstrated).
						const rev = batch.filter(
							(b) => b.r.act?.tool === "canvas" && canvasFlags.get(b.sub as object) === true,
						).length;
						part(rev === n && n > 0 ? "revised" : "created", n === 1 ? "1 canvas" : `${n} canvases`);
					}
				} else if (t === "edit") part("edited", plural(n, "file"));
				else if (t === "webfetch") part("fetched", plural(n, "page"));
				else if (t === "kimi-websearch") part("ran", `${n} search${n === 1 ? "" : "es"}`);
				// pi's own machinery beats (foldName): named, they cluster in
				// their own words instead of joining the MCP bucket.
				else if (t === "compaction") {
					// A solo compaction keeps its own sentence (`compacted 120k
					// tokens of context`, the /compact act): the counted form read
					// `compacted 1 context` (2026-08-29, the real-model audit).
					if (batch.length === 1) {
						const row = stripAnsi(batch[0].r.lines[0] ?? "").trim();
						const sp = row.indexOf(" ");
						styled.push(sp > 0 ? `${this.bold(callFg(row.slice(0, sp)))} ${callFg(row.slice(sp + 1))}` : callFg(row));
					} else part("compacted", `${n} context${n === 1 ? "" : "s"}`);
				} else if (t === "branch")
					styled.push(
						n === 1 ? this.bold(callFg("branched")) : `${this.bold(callFg("branched"))} ${callFg(`${n} times`)}`,
					);
				// A solo skill names itself — `used 1 skill` said nothing.
				else if (t === "skill") {
					const name = batch.length === 1 ? String((batch[0].sub as any)?.skillBlock?.name ?? "") : "";
					part("used", name ? `skill ${name}` : plural(n, "skill"));
				}
				// pi's error turns: a solo one IS its line (red), several read
				// `errored N times`; the `· N failed` tail is theirs already.
				else if (t === "error") {
					if (batch.length === 1) styled.push(this.fg("error", stripAnsi(batch[0].r.lines[0] ?? "Error").trim()));
					else styled.push(`${this.bold(this.fg("error", "errored"))} ${this.fg("error", plural(n, "time"))}`);
				}
				// The delivered results of background work (ownResultKind).
				else if (t === "agent-result" || t === "subagent-result")
					part("received", `${n} agent repl${n === 1 ? "y" : "ies"}`);
				else if (t === "peer-message") {
					// The sender decides the noun: a peer session, an agent of this
					// session (its head reads `message from agent_…`), or both.
					const fromAgents = batch.filter(
						(b) => b.r.act?.tool === "peer-message" && /message from agent_/.test(stripAnsi(b.r.lines[0] ?? "")),
					).length;
					const noun = fromAgents === n ? "agent message" : fromAgents === 0 ? "peer message" : "message";
					part("received", `${n} ${noun}${n === 1 ? "" : "s"}`);
				} else if (t === "session-brief") part("received", n === 1 ? "the session brief" : `${n} session briefs`);
				// The user's own injected messages (prompt/inject.ts).
				else if (t === "inject") part("received", `${n} injected message${n === 1 ? "" : "s"}`);
				else if (t === "ask-entry") part("asked", plural(n, "question"));
				else if (t === "bash-result" || t === "background-results") {
					// The verb follows the beats' own sentences: a killed job or a
					// batch of stops read "stopped", never "finished" (2026-08-29).
					const mine = batch.filter((b) => b.r.act?.tool === t);
					const verb = mine.every((b) => /\bstopped\b/.test(stripAnsi(b.r.lines[0] ?? ""))) ? "stopped" : "finished";
					if (t === "bash-result") part(verb, `${n} background bash${n === 1 ? "" : "es"}`);
					else {
						// Only THIS kind's beats: `lines` is also thinking's line count,
						// and summing the whole cluster read `finished 35 background
						// jobs` for 3 jobs beside a 32-line thought (demonstrated).
						const jobs = mine.reduce((a, b) => a + (b.r.act?.lines ?? 0), 0);
						part(verb, `${jobs} background result${jobs === 1 ? "" : "s"}`);
					}
				}
				// The adapter's script tool has its own verb (2026-08-20).
				else if (t === "mcpscript") part("ran", `${n} mcp script${n === 1 ? "" : "s"}`);
				// Unknown tools are MCP in this setup (round 24, maintainer).
				else part("called", `${n} mcp${n === 1 ? "" : "s"}`);
			}
			if (failed && !counts.has("error")) styled.push(this.fg("error", `· ${failed} failed`));
			// The header WRAPS at WORD level (round 25 — part-boundary breaks
			// left a ragged gap the next words could have filled, and the row
			// read as disconnected). wrapTextWithAnsi is pi's own ANSI-aware
			// wrap, so the styling survives the break; continuations keep the
			// 1-column lead. The failed tail joins with a space, not a comma.
			// The limit is the NATURAL content edge minus only that lead
			// (round 25b: a leftover 2-column truncate margin shaved words —
			// `file,` — that still fit the row).
			const limit = Math.max(8, contentW - 1);
			const joined: string[] = [];
			for (let i = 0; i < styled.length; i++) {
				const isFail = failed > 0 && i === styled.length - 1;
				joined.push(i === 0 ? styled[i] : `${isFail ? " " : callFg(", ")}${styled[i]}`);
			}
			const rows = wrapTextWithAnsi(joined.join(""), limit).map((r2) => ` ${r2}`);
			lines.push("");
			const base = lines.length;
			this.beatRows.set(batch[0].sub, base);
			this.beatLens.set(batch[0].sub, rows.length);
			// Settle flash: a cluster formed from the just-finished turn's
			// machinery (after the last prompt) — every row of its header.
			if (settleFlashRows && pendingMark && pendingMark.comp >= turnFrom)
				for (let i = 0; i < rows.length; i++) settleFlashRows.push(base + i);
			// NO gutter glyph (round 24, maintainer): in the static view the
			// machinery carries no dots — state lives in the summary text
			// (`· N failed` red); glyphs are a WORKING-only signal now.
			let maxB = 2;
			rows.forEach((r2, i) => {
				lines.push(r2);
				const b = visibleWidth(stripAnsi(r2).replace(/\s+$/, ""));
				maxB = Math.max(maxB, b);
				this.liveHandles.set(base + i, { a: 1, b });
			});
			// A wrapped header is ONE control: hovering any row lights all.
			if (rows.length > 1)
				for (let i = 0; i < rows.length; i++)
					this.liveHandleGroup.set(base + i, { from: base, to: base + rows.length });
			const first = batch[0].sub;
			const n = batch.length;
			const memberSubs = batch.map((b) => b.sub);
			// A SOLO canvas header names itself, so its TITLE is the link too:
			// CTRL+CLICK opens the file (text-gated, before the token probe).
			// Single-row headers only — a wrapped title's span would need the
			// chain logic, and the open panel's path row covers that case.
			if (n === 1 && batch[0].r.act?.tool === "canvas" && rows.length === 1) {
				const cvp = canvasPathOf(((first as { args?: unknown }) ?? {}).args);
				const plainRow = stripAnsi(rows[0]).replace(/\s+$/, "");
				const ti8 = plainRow.indexOf("• ");
				if (cvp && ti8 >= 0 && plainRow.length > ti8 + 2) {
					ranges.push({
						start: base,
						end: base + 1,
						ctrl: true,
						a: ti8 + 2,
						b: plainRow.length,
						action: () => this.openFile(cvp),
					});
				}
			}
			ranges.push({
				start: base,
				end: base + rows.length,
				...(open ? undefined : { a: 1, b: maxB }),
				// A SOLO summary expands the act itself (round 24b): with one
				// member there is nothing to list, so the click goes straight
				// to the panel instead of a header membering itself.
				action:
					soloAction ??
					(() => {
						const next = !clusterOpenState(first);
						clusterOpen.set(first, { gen: clusterAllGen, val: next });
						if (next) this.collapseAnchor.set(first, this.lastClickScreenRow);
						else this.pendingScrollBeat = first;
						// Folding the cluster folds its members with it (round 18):
						// reopening starts from a clean list.
						if (!next) for (const ms of memberSubs) toolOverride.set(ms, { gen: toolGen, val: false });
						clusterGen++;
						trace({ ev: next ? "uncluster" : "recluster", n });
						this.follow = false;
						this.liveDirty = true;
						this.tui.requestRender();
					}),
			});
			// A SOLO summary is the act's collapsed form, so ctrl+click on it
			// opens the act straight into WIRE view, like the sentence would.
			// A multi-member header has no single wire target — no ctrl range.
			if (soloCtrl) ranges.push({ start: base, end: base + rows.length, ctrl: true, action: soloCtrl });
		};
		// An OPEN cluster's member list: TIGHT under the `▼` header — no
		// blank rows — a dim `⎿` on the FIRST member only, every member's
		// text aligned two columns in, one tier below the header, no
		// per-member glyphs.
		const emitMember = (sub: any, r: RenderedBeat, prevPad: string, headOverride?: string): string => {
			// An expanded member breathes like a standalone panel — a field
			// row above its head (the first member too, under the header:
			// maintainer, on the catalogue) and below its evidence — with one
			// exception: two expanded members in a row SHARE the row between
			// them — the previous member's bottom pad serves as this one's top
			// pad, so two empties never lie together.
			// Shared only when the two pads are the SAME field: a red (error)
			// panel above a green one keeps both rows, each in its own colour
			// (maintainer, 2026-08-18: "I want the green renders the spacing").
			const topPad = !!r.pad && prevPad !== r.pad;
			if (topPad) lines.push(`   ${r.pad}`);
			this.beatRows.set(sub, lines.length);
			this.beatLens.set(sub, r.lines.length);
			// A member's SENTENCE row keeps its list position in BOTH fold
			// states (round 7: "the positioning is stable"): `⎿`/indent + dim
			// sentence, NO triangle — triangles belong to standalone beats and
			// the cluster summary. Expanding just nests the evidence chunks
			// below it, shifted +2 under the member.
			const base = lines.length;
			if (TRACE_PATH) overflowCheck(r, 3);
			for (let i = 0; i < r.lines.length; i++) {
				if (i === 0) {
					const plainRow = stripAnsi(r.lines[0]).trimStart();
					const isThink = r.act?.tool === "thinking";
					// The field bg marks the EXPANDED member only (round 17):
					// collapsed members stay bare; the open one reads as one
					// panel with its evidence.
					const expandedMember = r.kind !== "act";
					// An errored member reads RED in the list, so an open
					// cluster shows at a glance which one failed (round 8).
					// MUTED, not dim (the one review color the maintainer approved
					// on screen): an open cluster is the user asking to READ the
					// members; dim is the decoration tier. Open = LIT (round 22):
					// the expanded member's HEAD brightens to the text tier like
					// every opened panel head — thinking's label too (round 26);
					// only the thinking TEXT under the ⎿ stays muted italic.
					const tone = (t: string) =>
						r.act?.err ? this.fg("error", t) : expandedMember ? this.fg("text", t) : this.fg("muted", t);
					const memberBg = (t: string) => {
						if (!expandedMember) return t;
						try {
							return (this.theme as any).bg(r.act?.err ? "toolErrorBg" : "toolPendingBg", t) as string;
						} catch {
							return t;
						}
					};
					let styled: string;
					if (isThink) {
						// A collapsed thinking member is the LABEL (round 24), not
						// a text preview — the text is one click away. Expanded,
						// row 0 of the beat IS the label already. Round 26 wording
						// `thought for N lines`, verb bold (maintainer).
						const tl = r.act?.lines ?? 0;
						const src = expandedMember ? plainRow : tl ? `thought for ${plural(tl, "line")}` : "thought";
						// Members are UNBOLD in both states — open = lit only.
						styled = tone(src);
					} else {
						// NO verb bolding on members (round 25 retraction — round
						// 24 bolded them, the maintainer pulled it back); edit's
						// diff stat keeps its colours (+N green, −M red) unless
						// the member is all-red.
						styled = tone(plainRow);
						if (!r.act?.err) {
							const dm = /\(\+(\d+) −(\d+)\)/.exec(plainRow);
							if (dm)
								styled = styled.replace(
									`(+${dm[1]} −${dm[2]})`,
									`${tone("(")}${this.fg("success", `+${dm[1]}`)} ${this.fg("error", `−${dm[2]}`)}${tone(")")}`,
								);
						}
					}
					// Every member carries the `⎿` (maintainer, 2026-08-18) — the
					// first-only form is retired.
					const row = ` ${this.fg("dim", "⎿")}  ${headOverride ?? styled}`;
					lines.push(memberBg(row));
					// Hover span recomputed for the shifted text — collapsed members
					// only: an EXPANDED member's head is lit already (2026-08-22),
					// and an ERROR member has nothing to open, so no tell either.
					if (!expandedMember && r.act?.tool !== "error")
						this.liveHandles.set(base, { a: 4, b: visibleWidth(stripAnsi(row).replace(/\s+$/, "")) });
				} else {
					// Nested evidence steps +3 under the member text — the
					// staircase: header text, member ⎿, evidence ⎿, output ⎿
					// each three columns deeper (round 13, the user's sketch).
					lines.push(`   ${r.lines[i]}`);
					const h = (r.handles ?? []).find((x) => x.row === i);
					if (h) this.liveHandles.set(base + i, { a: h.a + 3, b: h.b + 3 });
				}
			}
			// Row 0 is RESTYLED here (a collapsed thinking member shows its
			// label, not its text), so a text-gated range on row 0 is clamped
			// to the width of the row actually drawn — the beat's own span was
			// the truncated text's, wider than the label, and a click to the
			// right of `thought for N lines` expanded it (demonstrated).
			const w0 = visibleWidth(stripAnsi(lines[base] ?? "").replace(/\s+$/, ""));
			const whole = (lr: LocalRange) => r.pad && lr.s === 0 && lr.e === r.lines.length && lr.a === undefined;
			for (const lr of r.ranges)
				ranges.push({
					start: base + lr.s - (whole(lr) && topPad ? 1 : 0),
					end: base + lr.e + (whole(lr) ? 1 : 0),
					action: lr.action,
					a: lr.a === undefined ? undefined : lr.s === 0 ? Math.min(lr.a + 3, w0) : lr.a + 3,
					b: lr.b === undefined ? undefined : lr.s === 0 ? Math.min(lr.b + 3, w0) : lr.b + 3,
					ctrl: lr.ctrl,
				});
			for (const lb of r.blocks) blocks.push({ s: base + lb.s, e: base + lb.e, src: lb.src });
			if (r.pad) lines.push(`   ${r.pad}`);
			return r.pad ?? "";
		};
		const drainPending = (keepComp?: number) => {
			if (!pending.length) return;
			const remarkKept = () => {
				if (pending.length)
					pendingMark = { lines: lines.length, ranges: ranges.length, blocks: blocks.length, comp: pending[0].comp };
			};
			let batch = pending;
			pending = [];
			// keepComp: flush everything EXCEPT the tail belonging to that
			// component; the kept tail stays pending under a fresh mark whose
			// rows are all ahead of lines.length (see emitPart).
			if (keepComp !== undefined) {
				let cut = batch.length;
				while (cut > 0 && batch[cut - 1].comp === keepComp) cut--;
				const kept = batch.slice(cut);
				batch = batch.slice(0, cut);
				if (kept.length) {
					pending = kept;
				}
				if (!batch.length) {
					remarkKept();
					return;
				}
			}
			// EVERY machinery batch clusters — a single act too (round 24,
			// maintainer): the static view reads as summaries, details on
			// demand, with no one-off exceptions to learn.
			if (batch.length === 1) {
				// SOLO (round 24b): the summary phrase IS the act's collapsed
				// form — clicking expands the act itself (its own toggle, its
				// own full panel), never a header membering itself. A settled
				// solo panel renders glyphless like everything static.
				const b = batch[0];
				// A solo ERROR is its own line and nothing to open: the beat as
				// is, no summary row, no control (2026-08-22). A solo ASK is its
				// own line too — already one sentence with its own fold — and
				// keeps its `?` (the user's mark is not a working-only signal).
				if (b.r.kind !== "act" || b.r.act?.tool === "error" || b.r.act?.tool === "ask-entry") {
					emitBeat(b.sub, b.r, b.r.act?.tool !== "ask-entry");
					remarkKept();
					return;
				}
				// The summary's click is the beat's FOLD action — never its ctrl
				// (wire) range, which would silently make every solo summary a
				// wire toggle now that ctrl ranges exist on collapsed beats.
				const act = (b.r.ranges.find((x) => x.s === 0 && !x.ctrl) ?? b.r.ranges.find((x) => !x.ctrl))?.action;
				emitClusterRow(batch, false, act, b.r.ranges.find((x) => x.ctrl)?.action);
				remarkKept();
				return;
			}
			const open = clusterOpenState(batch[0].sub);
			emitClusterRow(batch, open);
			if (open) {
				let padded = "";
				for (const b of batch) padded = emitMember(b.sub, b.r, padded);
			}
			remarkKept();
		};
		const emitPart = (sub: any, beat: RenderedBeat, transparent: boolean) => {
			if (!beat.lines.length) return; // spacer components render nothing
			// The working window never clusters (round 23): the current
			// request's machinery stays on the surface until settle.
			if (beat.act && !beat.act.running && !transparent) {
				// Error acts and ask entries each keep their OWN cluster: a
				// class change closes the batch in progress (errors since
				// 2026-08-22; asks 2026-08-24 — the user's questions never
				// merge into a tool summary).
				const clsOf = (t?: string) => (t === "error" ? "e" : t === "ask-entry" ? "q" : "t");
				// A class change closes the batch — but KEEP any tail items of
				// the CURRENT component (its pre/thinking): draining them into
				// the frozen prefix while flatPrefixComps stayed at this
				// component made every fast-path frame re-emit them — the
				// maintainer's thinking-rendered-twice (stress audit #3). The
				// kept tail re-marks the batch at rows not yet emitted, so the
				// prefix can never cut inside this component's own rows.
				if (pending.length && clsOf(pending[pending.length - 1].r.act?.tool) !== clsOf(beat.act.tool))
					drainPending(curComp);
				if (!pending.length)
					pendingMark = { lines: lines.length, ranges: ranges.length, blocks: blocks.length, comp: curComp };
				pending.push({ sub, r: beat, comp: curComp });
				return;
			}
			drainPending();
			emitBeat(sub, beat);
		};
		// A SKILL invocation pairs with the prompt that follows it (pi emits the
		// skill component, then a UserMessageComponent with the user's words):
		// the box is drawn first and the skill hangs under it as an attached
		// row — `⎿  used skill name` — rendered through emitMember (the +3
		// seat, click opens the block). Stateless on both sides so the prefix
		// cache can cut between the two: the skill at i skips itself when a
		// worded box follows; the box at i draws the skill at i-1 after itself.
		const skillOf = (c: any): boolean => foldName(c) === "skill";
		// pi puts a Spacer between the two (it renders nothing): neighbours are
		// the nearest NON-spacer components.
		const isSpacer = (c: any): boolean => c instanceof Spacer;
		const nextReal = (i: number): number => {
			let j = i + 1;
			while (j < subsFlat.length && isSpacer(subsFlat[j])) j++;
			return j;
		};
		const prevReal = (i: number): number => {
			let j = i - 1;
			while (j >= 0 && isSpacer(subsFlat[j])) j--;
			return j;
		};
		const boxWords = (c: any): boolean =>
			c instanceof UserMessageComponent &&
			typeof (c as any).text === "string" &&
			!!String((c as any).text)
				.replace(/\n?\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]\s*$/, "")
				.trim();
		// The skill's attached row under its box: `[skill]` collapsed,
		// concise and in the identity blue like the image rows (maintainer,
		// 2026-08-22). EXPANDED: a normal lit head — `user used skill <name>`,
		// the "user" saying who invoked it (maintainer, 2026-08-22b: the blue
		// tag as an open head read wrong).
		const emitSkillMember = (sk: any, transparent: boolean) => {
			const skName = String((sk as any)?.skillBlock?.name ?? "");
			emitMember(
				sk,
				this.renderSubCached(sk, contentW, transparent),
				"",
				pagerToolExpanded(sk)
					? this.fg("text", `user used skill ${skName}`.trimEnd() + (wireOn(sk) ? " · wire" : ""))
					: this.fg("customMessageLabel", "[skill]"),
			);
		};
		// pi's user component for a skill with NO words — war-dogs' stamp is
		// "words" to pi, so one exists carrying the stamp alone.
		const stampOnlyUser = (c: any): boolean =>
			c instanceof UserMessageComponent && typeof (c as any).text === "string" && !boxWords(c);
		const emitSub = (sub: any, transparent: boolean, idx = -1) => {
			if (idx >= 0 && skillOf(sub)) {
				// A worded box follows: it draws the box and hangs us under it.
				if (boxWords(subsFlat[nextReal(idx)])) return;
				// STANDALONE (2026-08-23, maintainer: every skill invocation is
				// a prompt): the box is synthesised from the skill — `/skill:name`,
				// what the user typed — and the skill hangs under it, the same
				// shape as the worded case. Keyed on its own object in beatRows:
				// the skill component itself keys the attached member.
				drainPending();
				let key = skillBoxKeys.get(sub);
				if (!key) skillBoxKeys.set(sub, (key = {}));
				emitBeat(key, this.skillBox(sub, contentW));
				emitSkillMember(sub, transparent);
				return;
			}
			// The stamp-only user component after a skill: its box came from
			// the skill above; nothing of its own to draw.
			if (idx > 0 && stampOnlyUser(sub) && skillOf(subsFlat[prevReal(idx)])) return;
			// A worded box after a skill opens with `/skill:name ` (see the box
			// branch); the lead rides the render signature.
			const skBefore = idx > 0 && boxWords(sub) && skillOf(subsFlat[prevReal(idx)]) ? subsFlat[prevReal(idx)] : null;
			const lead = skBefore ? `/skill:${String((skBefore as any)?.skillBlock?.name ?? "").trim()} ` : undefined;
			// The canvas act's created/revised flag: fixed at the component's
			// FIRST walk (document order — a component always enters as the
			// tail once), so the cached render stays coherent under the fast
			// path (the flag rides sigFor via canvasSig).
			// …and only once the ARGS are complete: the flag is fixed for good at
			// this walk, and a write whose args were still streaming was keyed on
			// a truncated path (`…/canvas/quar`, traced 2026-08-29), so a second
			// write to the same file never read `revised`.
			if (
				!canvasFlags.has(sub) &&
				(sub as any).argsComplete === true &&
				String((sub as any).toolName ?? "").toLowerCase() === "write"
			) {
				const cp = canvasPathOf((sub as any).args);
				if (cp) {
					const ck = `${source}|${cp}`;
					const first = this.canvasFirst.get(ck);
					canvasFlags.set(sub, first !== undefined && first !== sub);
					if (first === undefined) this.canvasFirst.set(ck, sub);
					trace({
						ev: "canvas",
						ck,
						first: first === undefined ? "none" : first === sub ? "self" : "other",
						revised: canvasFlags.get(sub),
					});
				}
			}
			const r = this.renderSubCached(sub, contentW, transparent, lead);
			// A voice message may carry a machinery PRELUDE — its leading
			// thinking (round 24) — emitted first as its own beat so it
			// clusters with the acts around it. Thinking beats key on the
			// PRE key (round 26) so their rows never collide with the prose
			// beat's in beatRows — the thinkToggle closures use the same key.
			if (r.pre) emitPart(preKeyOf(sub), r.pre, transparent);
			emitPart(r.act?.tool === "thinking" ? preKeyOf(sub) : sub, r, transparent);
			if (skBefore) {
				drainPending();
				emitSkillMember(skBefore, transparent);
			}
		};

		if (key === this.flatKey && this.liveWidth === contentW && this.liveSource === source) {
			// Fast path: prefix unchanged — re-render only the streaming tail.
			lines.length = this.flatPrefix.lines;
			ranges.length = this.flatPrefix.ranges;
			blocks.length = this.flatPrefix.blocks;
			for (const [k, v] of this.beatRows)
				if (v >= this.flatPrefix.lines) {
					this.beatRows.delete(k);
					this.beatLens.delete(k);
				}
			for (const k of [...this.liveHeads.keys()]) if (k >= this.flatPrefix.lines) this.liveHeads.delete(k);
			for (const k of [...this.liveFlush]) if (k >= this.flatPrefix.lines) this.liveFlush.delete(k);
			for (const k of [...this.liveHandles.keys()]) if (k >= this.flatPrefix.lines) this.liveHandles.delete(k);
			for (const k of [...this.liveHandleGroup.keys()]) if (k >= this.flatPrefix.lines) this.liveHandleGroup.delete(k);
			// Replay from where the PREFIX ends (round 28) — that may be before
			// freshFrom when a cluster straddles the boundary; those beats come
			// from their per-component caches, only i >= freshFrom re-renders.
			for (let i = this.flatPrefixComps; i < subsFlat.length; i++) {
				curComp = i;
				emitSub(subsFlat[i], i >= transparentFrom, i);
			}
			drainPending();
		} else {
			lines.length = 0;
			ranges.length = 0;
			blocks.length = 0;
			this.beatRows.clear();
			this.beatLens.clear();
			this.liveHeads.clear();
			this.liveFlush.clear();
			this.liveHandles.clear();
			this.liveHandleGroup.clear();
			let subIdx = 0;
			let prefixMarked = false;
			for (const child of kids) {
				try {
					const subs = Array.isArray(child?.children) ? child.children : null;
					if (subs) {
						for (const sub of subs) {
							if (subIdx === freshFrom && !prefixMarked) {
								// The prefix must not swallow an OPEN cluster: its
								// lines are frozen, so a merged row inside it could
								// never grow its count. Round 23 force-drained here,
								// which SPLIT the last turn's cluster permanently
								// (the boundary always sits two components from the
								// end). Round 28: the prefix ends BEFORE the batch
								// still forming instead — nothing splits, and the
								// straddling beats re-emit from their caches.
								if (pending.length && pendingMark) {
									this.flatPrefix = {
										lines: pendingMark.lines,
										ranges: pendingMark.ranges,
										blocks: pendingMark.blocks,
									};
									this.flatPrefixComps = pendingMark.comp;
								} else {
									this.flatPrefix = { lines: lines.length, ranges: ranges.length, blocks: blocks.length };
									this.flatPrefixComps = freshFrom;
								}
								prefixMarked = true;
							}
							curComp = subIdx;
							emitSub(sub, subIdx >= transparentFrom, subIdx);
							subIdx++;
						}
					} else {
						pushAll(lines, child?.render?.(contentW) ?? []);
					}
				} catch {
					drainPending();
					lines.push("[render error]");
				}
			}
			drainPending();
			if (!prefixMarked) {
				this.flatPrefix = { lines: lines.length, ranges: ranges.length, blocks: blocks.length };
				this.flatPrefixComps = subsFlat.length;
			}
			this.flatKey = key;
		}
		if (settleFlashRows) {
			this.settleFlash = false;
			if (settleFlashRows.length) {
				this.flash(settleFlashRows);
				trace({ ev: "settleflash", n: settleFlashRows.length });
			}
		}
		this.liveAt = Date.now();
		this.liveWidth = contentW;
		this.liveSource = source;
		this.liveDirty = false;
		this.lastFlatMs = Date.now() - t0;
	}

	/* ----- raw view: wrap cache ----- */

	private childRun(): SubagentRunInfo | undefined {
		if (!this.childView) return undefined;
		// stationRuns(), not subagentRuns(): both read the in-memory index
		// now (status flips are visible through either — the run objects are
		// shared by reference), but subagentRuns() caches MEMBERSHIP for
		// 250ms, and a just-spawned run must be addressable here immediately.
		return stationRuns().find((r) => r.id === this.childView);
	}

	// Keep the child transcript fresh while it runs: re-parse its session
	// file at most every 600ms and keep a repaint timer alive.
	private maybeRefreshChild() {
		const run = this.childRun();
		if (!run) {
			// The watched run vanished (aborted, or its session switched).
			// Return to main rather than sitting on a dead view.
			this.exitChildView();
			return;
		}
		const anyRunning = run?.status === "working" || run?.status === "queued";
		// Drive renders for as long as a run view is OPEN, not only while it
		// is running. Previously the timer could only start from inside
		// render(), and render() only happened if something else asked for
		// one — so a chat turn that began between frames had nothing left to
		// wake it, and the view sat frozen until the turn finished.
		const wantMs = anyRunning ? 100 : 400;
		if (this.childTimerMs !== wantMs) {
			this.stopChildTimer();
			this.childTimerMs = wantMs;
			this.childTimer = setInterval(() => {
				try {
					this.tui.requestRender();
				} catch {}
			}, wantMs);
			(this.childTimer as { unref?: () => void }).unref?.();
		}
	}

	private stopChildTimer() {
		if (this.childTimer) {
			clearInterval(this.childTimer);
			this.childTimer = null;
		}
		this.childTimerMs = 0;
	}

	exitChildView() {
		this.resetFollowHold();
		this.stationRoot = null;
		this.childView = null;
		this.hoverFold = null;
		this.publishView(null);
		this.stopChildTimer();
		this.rawWrappedWidth = -1;
		this.follow = true;
		this.tui.requestRender();
	}

	/** Release every cross-extension handle this pager owns. */
	dispose() {
		this.stopChildTimer();
		this.childView = null;
		this.station = false;
		this.selAnchor = null;
		this.selHead = null;
		this.dragged = false;
		this.stationPendingClick = null;
		clearFocusedRun();
		setOpenRunHook(undefined);
	}

	// Open one run's transcript (from a station row or a transcript tree
	// row). Leaves the station: the run view is a destination, not a
	// layer on top of it.
	/** A run view opened before its component tree exists: the FIRST frame is the bare view, the build follows (see render). */
	private coldOpen: string | null = null;

	/**
	 * A view switch replaces the content wholesale: the follow-hold must not
	 * read the new view's first frame as a dip against the old view's window
	 * (2026-08-29: a cold open's empty frame was held — `drop=27 held=1` —
	 * and main's rows sat under the child's header for up to 1.5 s, or
	 * flickered when the hold declined; the maintainer's "not as smooth").
	 * The same reset contentReplaced() makes for /tree and compaction.
	 */
	private resetFollowHold() {
		this.followHoldAt = 0;
		this.holdTotal = 0;
	}

	openRun(id: string) {
		this.resetFollowHold();
		// A run view is a destination, not a layer on the station: the scoped
		// station's root must not outlive it, or main inherits the visor
		// palette after ctrl+s (2026-08-29, the maintainer's blue chrome:
		// station from a lead's view → a worker → ctrl+s → the lead → ctrl+s
		// → main, with stationRoot still set and themeFor() choosing visor).
		this.stationRoot = null;
		if (!this.childCompCache.has(id)) this.coldOpen = id;
		this.station = false;
		this.selAnchor = null;
		this.selHead = null;
		this.dragged = false;
		this.stationPendingClick = null;
		this.hoverFold = null;
		this.hOffset = 0;
		this.stationHover = null;
		this.stationSel = null;
		this.childView = id;
		this.rawWrappedWidth = -1;
		this.follow = true;
		this.tui.requestRender();
	}

	private childKids(run: SubagentRunInfo): any[] | null {
		try {
			let cache = this.childCompCache.get(run.id);
			if (!cache) {
				cache = { count: 0, comps: [], tools: new Map() };
				// Bound it: each entry holds a full child component tree.
				// Map iterates in insertion order, so drop oldest first.
				for (const k of this.childCompCache.keys()) {
					if (this.childCompCache.size < 8) break;
					if (k !== run.id) this.childCompCache.delete(k);
				}
				this.childCompCache.set(run.id, cache);
			}
			// ONE component per message, reconciled in place — the same model
			// pi uses for main. The previous design kept a cache built from
			// PERSISTED entries plus a live tail rebuilt each frame, and a
			// message moved between the two when it hit disk. That handoff both
			// stopped tool calls from streaming (a ToolExecutionComponent only
			// existed once its message was persisted) and produced the flicker
			// (the gap is a height change that scales with the message: a
			// five-paragraph reply measured a 96-row drop into a 33-row view).
			//
			// While the session is live, session.messages plus the streaming
			// partial IS the whole transcript, so there is nothing to merge.
			const live = sessionFor(run.id);
			if (live) {
				const msgs = [...((live.messages ?? []) as any[])];
				// The in-flight assistant message reaches us only as
				// message_update events; it is not in session.messages yet.
				const partial = liveMessageFor(run.id) as any;
				if (partial) {
					// Match against the last ASSISTANT message, not the last
					// message. Once the turn appends a toolResult the partial
					// stops matching msgs[len-1] and would be pushed a SECOND
					// time — the duplicated thinking-and-tool-call block. This
					// is the same trap the old superseded check fell into.
					let at = -1;
					for (let i = msgs.length - 1; i >= 0; i--) {
						if (msgs[i]?.role !== "assistant") continue;
						const m = msgs[i];
						const same =
							(m.responseId && m.responseId === partial.responseId) ||
							(!m.responseId && m.timestamp && m.timestamp === partial.timestamp);
						if (same) at = i;
						break;
					}
					if (at >= 0) msgs[at] = partial;
					else msgs.push(partial);
				}
				// Tool results the state does not carry yet (agents/stream.ts):
				// appended, so a finished call in a running batch renders done
				// while its neighbours run — like main. Pruned once the state
				// has them.
				const liveResults = registry.get(run.id)?.liveToolResults;
				if (liveResults?.size) {
					const have = new Set<string>();
					for (const m of msgs) if (m?.role === "toolResult" && m.toolCallId) have.add(String(m.toolCallId));
					for (const [id, m] of liveResults) {
						if (have.has(id)) liveResults.delete(id);
						else msgs.push(m);
					}
				}
				if (cache.source !== "live") {
					cache.count = 0;
					cache.comps = [];
					cache.tools.clear();
					cache.keyed?.clear();
				}
				cache.source = "live";
				if (reconcileChildComps(this.tui, cache, msgs, this.theme, this.thinkingView)) this.liveDirty = true;
				return [{ children: cache.comps }];
			}
			// Finished run from an earlier process: static, built from the file.
			// Per RUN, not per pager: one shared timestamp meant opening a
			// second finished run within 600ms of the first skipped its parse
			// and showed an empty or stale transcript.
			if (Date.now() - (cache.parsedAt ?? 0) > 600 || cache.count === 0) {
				cache.parsedAt = Date.now();
				const { entries, source } = runEntries(run);
				if (cache.source && cache.source !== source) {
					cache.count = 0;
					cache.comps = [];
					cache.tools.clear();
				}
				cache.source = source;
				if (buildChildComps(this.tui, cache, entries as any[], this.theme, this.thinkingView)) this.liveDirty = true;
			}
			return [{ children: cache.comps }];
		} catch {
			return null; // theme unavailable -> raw pipeline fallback
		}
	}

	/**
	 * Messages the child session holds in memory but has not persisted —
	 * i.e. the turn currently streaming. Rebuilt on every poll, so it is
	 * deliberately limited to the unwritten tail.
	 */
	private ensureRawWrapped(inner: number) {
		if (this.rawWrappedWidth === inner) return;
		const run = this.childRun();
		this.rawLines = run ? childEntriesToRawLines(readChildEntries(run.sessionDir), run.id, inner) : this.supplyRaw();
		const out: RawLine[] = [];
		for (const l of this.rawLines) {
			if (!l.text || l.kind === "pre") {
				out.push(l);
				continue;
			}
			for (const w of wrapPlain(l.text, inner)) out.push({ text: w, kind: l.kind, blockId: l.blockId });
		}
		this.rawWrapped = out;
		this.rawWrappedWidth = inner;
	}

	/* ----- styling ----- */

	private fg(color: string, s: string): string {
		try {
			return (this.theme as any).fg(color, s);
		} catch {
			return s;
		}
	}

	/**
	 * Baked SGR sequences, cached per PALETTE.
	 *
	 * Two rules, both paid for by the round-31 audit:
	 *
	 * 1. The key is a VALUE, never a theme identity. `this.theme` resolves
	 *    through pi's permanent Proxy (README: "pi's `theme` is a LIVE
	 *    PROXY"), so `seqTheme === this.theme` was true forever — after a
	 *    live theme change `tintTail`/`accentToDim` went on searching the
	 *    OLD palette's sequences and matched nothing, leaving the editor
	 *    frame in pi's accent.
	 * 2. Each consumer owns its fields. tintTail SEARCHES the BASE theme
	 *    (pi renders the editor with its own theme whatever view we show)
	 *    while accentToDim searches the EFFECTIVE one (visor in a run view);
	 *    sharing `accentSeq` meant whichever ran first that frame decided
	 *    which palette both of them used.
	 */
	private seqKey = "";
	/** tintTail's search seqs — from the BASE theme. */
	private baseAccentSeq = "";
	private baseTextSeq = "";
	/** accentToDim's search/replace seqs — from the EFFECTIVE (view) theme. */
	private viewAccentSeq = "";
	private dimSeq = "";
	private ensureSeqCache() {
		let key: string;
		try {
			const base = this.baseTheme as any;
			const th = this.theme as any;
			key = `${base.fg("accent", "\0")}|${base.fg("text", "\0")}|${th.fg("accent", "\0")}|${th.fg("dim", "\0")}`;
		} catch {
			key = "?";
		}
		if (key === this.seqKey) return;
		this.seqKey = key;
		this.baseAccentSeq = "";
		this.baseTextSeq = "";
		this.viewAccentSeq = "";
		this.dimSeq = "";
		this.levelSeqs = null;
	}
	/**
	 * Repaint the bottom UI in the current view's accent.
	 *
	 * The editor draws its own frame in the theme's accent, so in a subagent
	 * view the input bar looked identical to main's — which is exactly how
	 * you end up typing at a subagent believing you are talking to main. The
	 * scrollbar and title already carry the cue; this puts it on the thing
	 * your eyes are actually on while typing.
	 *
	 * A substitution rather than a re-render: the editor belongs to pi and is
	 * rendered by pi. We only swap the colour it chose.
	 */
	private levelSeqs: string[] | null = null;

	/**
	 * Repaint the bottom UI in ONE colour: green in main, blue in a run view.
	 *
	 * pi tints the editor frame by THINKING LEVEL — thinkingLow, thinkingHigh
	 * and so on — so the input bar changed colour whenever the level changed,
	 * and in a subagent view that level colour simply overwrote the view cue.
	 * A colour that means two things at once means neither, so the level
	 * colouring is dropped here and the frame states which VIEW you are
	 * typing into, which is the thing that actually costs you when it is
	 * wrong.
	 *
	 * A substitution, not a re-render: the editor is pi's and stays pi's; we
	 * only replace the colour it picked.
	 */
	/**
	 * pi's RETRY indicator repainted in war-dogs' language (maintainer,
	 * 2026-08-20): the working spinner's grenade frames in the ERROR red
	 * instead of pi's amber braille — a stalled turn should look like the
	 * working pulse gone red, not a different animal. pi builds the
	 * RetryStatusIndicator internally with no frame/colour API, so this is a
	 * display substitution on the composited tail row, the same instrument as
	 * tintTail; matched on the exact message shape pi renders. Time-varying is
	 * safe here: the tail is composed per frame, never cached, and pi rerenders
	 * every countdown second.
	 */
	private static readonly RETRY_ROW =
		/^(\s*)(\x1b\[[0-9;]*m)?(\S+)(\x1b\[[0-9;]*m)?(\s+)(?=\x1b\[[0-9;]*m?Retrying \(|Retrying \()/;
	private retryTint(line: string): string {
		if (!line.includes("Retrying (")) return line;
		try {
			const th = this.theme as any;
			const frames = ["●", "◉", "●", "◉", "✺", "✹", "✸", "✶"];
			const g = frames[Math.floor(Date.now() / 220) % frames.length];
			return line.replace(
				PagerComponent.RETRY_ROW,
				(_m, lead: string, _o, _g, _c, gap: string) => `${lead}${th.fg("error", `\x1b[1m${g}\x1b[22m`)}${gap}`,
			);
		} catch {
			return line;
		}
	}

	private tintTail(line: string): string {
		try {
			// SCOPE: only the editor's FRAME rows (its box-drawing border)
			// are re-tinted. The substitution used to cover the whole tail —
			// and because the palettes map the thinking-level tokens onto the
			// SAME hexes as dim/muted/warning/error, replacing "level colours"
			// replaced those too, painting the entire footer in the accent
			// (the maintainer's "footer is all one green"; byte-demonstrated).
			// The frame alone carries the which-view-am-I-typing-into cue.
			// pi's editor border is BARE ─ rows in this layout (the ╭│╰
			// box only appears with padding) — the round-3 predicate missed
			// them entirely, so the frame tint was a silent no-op and the
			// line stayed pi's accent (round 9, user-reported).
			const first = stripAnsi(line).trimStart()[0] ?? "";
			if (first !== "╭" && first !== "│" && first !== "╰" && first !== "─") return line;
			// SEARCH seqs come from the BASE theme — pi renders the editor
			// with ITS theme regardless of which view the pager shows; the
			// TARGET comes from the view (round 9): in MAIN the frame takes
			// the PROMPT BOX's blue (userMessageBg re-expressed as a
			// foreground), in a run/station view the visor accent.
			this.ensureSeqCache();
			const base = this.baseTheme as any;
			if (!this.baseAccentSeq) {
				this.baseAccentSeq = base.fg("accent", "\0").split("\0")[0];
				this.baseTextSeq = base.fg("text", "\0").split("\0")[0];
			}
			if (!this.levelSeqs) {
				this.levelSeqs = [
					"thinkingOff",
					"thinkingMinimal",
					"thinkingLow",
					"thinkingMedium",
					"thinkingHigh",
					"thinkingXhigh",
					"thinkingMax",
				]
					.map((t) => {
						try {
							return base.fg(t, "\0").split("\0")[0] as string;
						} catch {
							return "";
						}
					})
					.filter((seq) => seq && seq !== this.baseTextSeq);
			}
			// Round 9 retraction: the prompt-navy frame read as "no colour" —
			// the frame took the view accent (green in main under canopy, visor
			// blue in a run view). 2026-08-20: main's frame is GREY (chromeTone)
			// — the maintainer wanted the input bar and the scroll thumb quiet;
			// the run view keeps the blue cue.
			const th = this.theme as any;
			const target = th.fg(this.chromeTone(), "\0").split("\0")[0];
			if (!target) return line;
			let out = line;
			for (const seq of [this.baseAccentSeq, ...this.levelSeqs]) {
				if (seq && seq !== target && out.includes(seq)) out = out.split(seq).join(target);
			}
			return out;
		} catch {
			return line;
		}
	}

	/**
	 * Call ARGUMENTS (paths, urls, queries) come out of pi's renderers in
	 * `accent` — the same green as the tool name. Recoloured to DIM so the
	 * beat reads name-bright/argument-quiet, and so the hover's bright text
	 * tier visibly lights against it.
	 */
	private accentToDim(line: string): string {
		try {
			this.ensureSeqCache();
			if (!this.viewAccentSeq) {
				this.viewAccentSeq = (this.theme as any).fg("accent", "\0").split("\0")[0];
				this.dimSeq = (this.theme as any).fg("dim", "\0").split("\0")[0];
			}
			return this.viewAccentSeq && line.includes(this.viewAccentSeq)
				? line.split(this.viewAccentSeq).join(this.dimSeq)
				: line;
		} catch {
			return line;
		}
	}

	private bold(s: string): string {
		try {
			return this.theme.bold(s);
		} catch {
			return s;
		}
	}

	private styleRaw(l: RawLine): string {
		if (l.kind === "pre") return l.text; // already styled + wrapped
		if (l.kind === "user") return this.bold(this.fg("accent", l.text));
		if (l.kind === "assistant") return this.bold(l.text);
		if (l.kind === "tool" || l.kind === "dim") return this.fg("dim", l.text);
		return l.text;
	}

	/**
	 * Which accent identifies the CURRENT view.
	 *
	 * Main and a subagent view were the same green, so it was easy to be in a
	 * run and think you were in main — and then talk to the subagent by
	 * mistake. The title and the scrollbar thumb both carry this, so the cue
	 * is present at the top of the screen and down the whole right edge.
	 */
	private viewAccent(): string {
		// stationRoot too: toggleStation() clears childView, so a station
		// opened from inside a run would otherwise forget where it came from
		// and paint itself as main.
		return this.childRun() || this.stationRoot ? "customMessageLabel" : "accent";
	}

	/**
	 * The colour of the chrome that frames the view — the scrollbar thumb and
	 * the editor's frame rows: the view ACCENT (green in main under canopy —
	 * grey was tried 2026-08-20 and recalled the same day by the maintainer),
	 * the visor blue in a run view or the station, where the frame IS the cue
	 * for which conversation you are typing into.
	 */
	private chromeTone(): string {
		return this.viewAccent();
	}

	private titleBar(width: number, pct: number): string {
		const pre = "── ";
		const run = this.childRun();
		// The pager is the default surface now, so "pager mode" said nothing.
		// Name the VIEW instead.
		const label = run ? "subagent view" : "main view";
		// ...and the label already says "subagent", so the run part is just
		// its name.
		const viewPart = run
			? ` · ${run.agent} (${run.status}${run.status === "working" ? ` ${elapsedOf(run)}` : ""})`
			: "";
		const viewsHint = subagentRuns().length ? " · alt+s station" : "";
		// No close key: the pager is the permanent surface while war-dogs is on
		// (Option 1). `/war-dogs off` returns to stock pi.
		const post = `${viewPart} · scrollback ${pct}%${!run && !liveMode ? " · raw" : ""}${viewsHint} · ctrl+r ${run ? "main" : liveMode ? "raw" : "live"} `;
		const used = visibleWidth(pre + label + post);
		if (used > width) return this.fg("dim", ansiTruncate(pre + label + post, width));
		const fill = "─".repeat(Math.max(0, width - used));
		return this.fg("dim", pre) + this.bold(this.fg(this.viewAccent(), label)) + this.fg("dim", post + fill);
	}

	// Selection span for a content line, in content columns [a, b) — or
	// null when the line is outside the selection. Only shown once the
	// mouse actually dragged (a bare click paints nothing).
	private selSpan(idx: number, inner: number): [number, number] | null {
		if (!this.selAnchor || !this.selHead || !this.dragged) return null;
		let a = this.selAnchor;
		let b = this.selHead;
		if (a.idx > b.idx || (a.idx === b.idx && a.col > b.col)) [a, b] = [b, a];
		if (idx < a.idx || idx > b.idx) return null;
		const from = idx === a.idx ? Math.min(a.col, inner) : 0;
		const to = idx === b.idx ? Math.min(Math.max(b.col + 1, from + 1), inner) : inner;
		return [from, to];
	}

	/* ----- station ----- */

	// Publishing the focused run is how subagent.ts knows typed input
	// belongs to that agent rather than to main.
	private publishView(id: string | null) {
		if (this.viewPublished === id) return;
		this.viewPublished = id;
		try {
			setFocusedRun(id ?? undefined);
			// Let the stream capture repaint us directly, per token batch,
			// the way pi drives main. The timer stays as a fallback for the
			// clock and for runs with no active stream.
		} catch {}
	}

	/** Keyboard selection in the station (round 28): alt+s, then ↑/↓ + Enter. */
	private stationSel: number | null = null;

	inStation(): boolean {
		return this.station;
	}

	/** Move the keyboard selection by `d` runs; mirrors into the hover light. */
	stationNav(d: number) {
		if (!this.station) return;
		const n = this.stationRows.length;
		if (!n) return;
		this.stationSel =
			this.stationSel === null ? (d > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, this.stationSel + d));
		this.stationHover = this.stationSel;
		// Keep the WHOLE selection on screen — the run row AND the detail
		// block the selection just opened. stationDisplayRows is the PREVIOUS
		// frame's layout (without this run's config), so the block is
		// recomputed fresh; the end is clamped first, the head wins when the
		// block is taller than the view (2026-08-22c: the config opened
		// off-screen and the selection showed only the prompt).
		const row = this.stationRows[this.stationSel];
		const contentW = Math.max(4, this.lastWidth - 2 * PAD_X - 2);
		const disp = this.stationDisplay(contentW).map((d) => d.row);
		const first = disp.indexOf(row);
		const last = disp.lastIndexOf(row);
		if (first >= 0) {
			if (last >= this.offset + this.lastBody) this.offset = last - this.lastBody + 1;
			if (first < this.offset) this.offset = first;
		}
		this.tui.requestRender();
	}

	stationHasSel(): boolean {
		return this.station && this.stationSel !== null;
	}

	/** Enter: open the selected run's chat view. */
	stationEnter(): boolean {
		if (!this.station || this.stationSel === null) return false;
		const row = this.stationRows[this.stationSel];
		if (!row) return false;
		this.openRun(row.run.id);
		return true;
	}

	/** alt+s: the station is always relative to the session you are in. */
	toggleStation() {
		if (this.station) {
			// Closing a SCOPED station returns to the run it belongs to,
			// not to main — you came from there.
			const back = this.stationRoot;
			this.station = false;
			this.selAnchor = null;
			this.selHead = null;
			this.dragged = false;
			this.stationPendingClick = null;
			this.stationRoot = null;
			this.stationHover = null;
			this.stationSel = null;
			this.hOffset = 0;
			if (back) {
				this.openRun(back);
				return;
			}
			this.offset = 0;
			this.follow = true;
			this.tui.requestRender();
			return;
		}
		// From a subagent's chat view, alt+s shows what THAT agent spawned.
		this.stationRoot = this.childRun()?.id ?? null;
		if (this.childView) {
			this.childView = null;
			this.stopChildTimer();
			this.publishView(null);
		}
		this.station = true;
		this.selAnchor = null;
		this.selHead = null;
		this.dragged = false;
		this.stationPendingClick = null;
		this.offset = 0;
		this.hOffset = 0;
		this.follow = false;
		this.selAnchor = null;
		this.selHead = null;
		this.stationHover = null;
		this.stationSel = null;
		this.tui.requestRender();
	}

	/**
	 * ctrl+s — one step BACK, never forward. From a scoped station
	 * to its owner, from a run to its parent run, from a top-level run or
	 * main's station to main. At main it does nothing.
	 */
	back(): boolean {
		if (this.station) {
			const owner = this.stationRoot;
			this.station = false;
			this.selAnchor = null;
			this.selHead = null;
			this.dragged = false;
			this.stationPendingClick = null;
			this.stationRoot = null;
			this.stationHover = null;
			this.stationSel = null;
			this.hOffset = 0;
			if (owner) {
				this.openRun(owner);
				return true;
			}
			this.offset = 0;
			this.follow = true;
			this.tui.requestRender();
			return true;
		}
		const run = this.childRun();
		if (!run) return false; // already at main
		const parent = run.parentId ? stationRuns().find((r) => r.id === run.parentId) : undefined;
		if (parent) this.openRun(parent.id);
		else this.exitChildView();
		return true;
	}

	private buildStationRows(): StationRow[] {
		const runs = stationRuns();
		const ids = new Set(runs.map((r) => r.id));
		const byParent = new Map<string | null, SubagentRunInfo[]>();
		for (const r of runs) {
			const p = r.parentId && ids.has(r.parentId) ? r.parentId : null;
			if (!byParent.has(p)) byParent.set(p, []);
			(byParent.get(p) as SubagentRunInfo[]).push(r);
		}
		for (const list of byParent.values()) list.sort((a, b) => a.startedAt - b.startedAt);
		const rows: StationRow[] = [];
		const walk = (run: SubagentRunInfo, depth: number, stem: string, last: boolean) => {
			const kids = byParent.get(run.id) ?? [];
			const collapsed = stationCollapsed.has(run.id);
			const branch = depth === 0 ? "" : `${stem}${last ? "└──" : "├──"} `;
			rows.push({
				run,
				depth,
				stem: branch,
				hasKids: kids.length > 0,
				collapsed,
				toggleAt: visibleWidth(branch),
				abortAt: -1, // filled in by stationDisplay once the row is laid out
			});
			if (collapsed || !kids.length) return;
			const childStem = depth === 0 ? "" : `${stem}${last ? "    " : "│   "}`;
			kids.forEach((k, i) => walk(k, depth + 1, childStem, i === kids.length - 1));
		};
		// Scoped station: a subagent's station lists what IT spawned, not
		// itself. An agent that never delegated therefore shows nothing,
		// which is the honest answer rather than a one-row list of itself.
		if (this.stationRoot) {
			const kids = byParent.get(this.stationRoot) ?? [];
			kids.forEach((k, i) => walk(k, 0, "", i === kids.length - 1));
			return rows;
		}
		const roots = (byParent.get(null) ?? []).sort((a, b) => b.startedAt - a.startedAt);
		roots.forEach((r) => walk(r, 0, "", true));
		return rows;
	}

	/**
	 * Display lines for the station. Each run gets a status line plus a
	 * dim one-line task preview, and root groups are separated by a blank
	 * row — the airier shape the original tree view had, rather than a
	 * dense notepad list. Decoration rows map to a null StationRow so hit
	 * testing ignores them.
	 */
	private stationDisplay(contentW: number): { text: string; row: StationRow | null }[] {
		// Breathing room under the title bar.
		const out: { text: string; row: StationRow | null }[] = [{ text: "", row: null }];
		this.stationRows.forEach((r, i) => {
			// Air before EVERY run after the first (2026-08-22, maintainer) —
			// roots separate their trees, and a nested child no longer sits
			// flush on its parent's config line; the rail runs through the
			// blank so the tree stays connected.
			if (i > 0)
				out.push({
					text: r.depth === 0 ? "" : this.fg("dim", r.stem.replace(/[├└]── $/, "│   ")),
					row: null,
				});
			const glyph = r.hasKids ? (r.collapsed ? "▸" : "▾") : "·";
			const st = r.run.status;
			const mark = st === "working" ? "✳" : st === "queued" ? "◌" : st === "idle" ? "✔" : st === "stopped" ? "⊘" : "✘";
			// Failed stays red — that is a real signal, not chrome. Running and
			// done both take the view colour so the station reads as one surface.
			const col = st === "error" || st === "stopped" ? "error" : this.viewAccent();
			const hovered = this.stationHover === i;
			// Accent green, matching the run tree in the transcript block —
			// the same agent should look the same everywhere.
			const agent = hovered
				? invert(this.bold(this.fg(this.viewAccent(), r.run.agent)))
				: this.bold(this.fg(this.viewAccent(), r.run.agent));
			const title = r.run.title || r.run.task.split("\n")[0].slice(0, 60);
			const kidNote = r.hasKids && r.collapsed ? this.fg("dim", " ⋯") : "";
			const body =
				this.fg("dim", r.stem) +
				this.fg("dim", `${glyph} `) +
				this.fg(col, `${mark} `) +
				agent +
				this.fg("text", ` • ${title}`) +
				this.fg(
					"dim",
					` • ${st} ${elapsedOf(r.run)}${sessionEndOf(r.run.error) ? ` · ${sessionEndOf(r.run.error)}` : ""}`,
				) +
				kidNote;
			// Running rows get a click target to stop them. Abort tears down
			// the whole subtree through the run's linked controller.
			// …or whose team still works: the ✕ stops the run and everything
			// under it, an idle lead with running workers included (2026-08-29).
			if (st === "working" || st === "queued" || teamWorking(r.run.id)) {
				r.abortAt = visibleWidth(body) + 1;
				out.push({ text: `${body} ${this.bold(this.fg("error", "✕"))}`, row: r });
			} else {
				r.abortAt = -1;
				out.push({ text: body, row: r });
			}
			// Task preview (one row: ~72 characters, cut on a word) and the run's
			// configuration — ONE line at rest, the full block (every tool
			// name, exclusions, cwd, extensions, run id) only for the run under
			// the selection or the mouse (2026-08-22; three lines per run read
			// as a wall).
			// The tree's RAIL runs through them (2026-08-22, maintainer: "make
			// the └─ connect"): the next run row's stem, its elbow turned into
			// a rail, padded to this row's detail column — so a child's `└─`
			// meets a `│` above it instead of hanging under blank lines.
			const next = this.stationRows[i + 1];
			// Padded to the detail column (stem + 4) and used WHOLE: the rail's
			// column lies inside that gutter (a root's child elbow sits at
			// column 0), so slicing the last four columns off — the first cut —
			// deleted exactly the rail it was meant to draw (demonstrated).
			const stem = this.fg("dim", (next ? next.stem.replace(/[├└]── $/, "│   ") : "").padEnd(visibleWidth(r.stem) + 4));
			const task = (r.run.task ?? "").split("\n").find((l) => l.trim()) ?? "";
			// Skip when the task line just restates the title — no value in
			// printing the same words twice.
			const indentW = visibleWidth(r.stem) + 4;
			if (task && sanitize(task).trim() !== title.trim()) {
				const plain = sanitize(task).trim();
				// Relative to the SCREEN, never past it (2026-08-22c: a smaller
				// terminal cut the fixed 72 off at the edge).
				const cutAt = Math.max(16, Math.min(72, contentW - indentW - 1));
				const cut =
					plain.length <= cutAt
						? plain
						: `${
								plain
									.slice(0, cutAt)
									.replace(/\s+\S*$/, "")
									.replace(/[\s,;:—-]+$/, "") || plain.slice(0, cutAt)
							}…`;
				// The ❯ in the same dim as the task, not the prompt blue
				// (maintainer, 2026-08-22c) — here it is punctuation, not a voice.
				out.push({ text: `${stem}${this.fg("dim", `❯ ${cut}`)}`, row: r });
			}
			// The run's CONFIGURATION (2026-08-22, maintainer: "model, effort,
			// tools, etc, all of it — in the station, not in the call"). What
			// the child was actually built with where the record has it
			// (snapshotSession: model, thinking, active tool names — live runs
			// included), the resolved config for the rest.
			const cfg = (r.run.config ?? {}) as Partial<RunConfig>;
			// VALUES ONLY, muted (2026-08-22c, maintainer): a self-representing
			// value stands alone (`kimi-for-coding`, `background`, `9 tools`,
			// the run id); one that is not carries its type (`depth 1`,
			// `low effort`, `no timeout`, `inherited cwd`, `no extensions`).
			const v = (t: string) => this.fg("muted", t);
			const dot = this.fg("dim", " · ");
			const model = r.run.model ?? cfg.model ?? "inherited model";
			const effort = r.run.thinking ?? cfg.effort;
			const budget = cfg.depth !== undefined && cfg.depth !== r.run.depth ? ` (budget ${cfg.depth})` : "";
			const toolList = r.run.tools?.length ? r.run.tools : cfg.tools?.length ? cfg.tools : null;
			// One line at rest; CTRL+hover (or the arrow selection) opens the
			// FULL line — list contents in dim parentheses — as one flowing
			// text WRAPPED to the screen, continuations at the first word's
			// column (2026-08-22c; fixed-width rows clipped on a small
			// terminal).
			const dimP = (t: string) => this.fg("dim", t);
			const detail = this.stationDetail === i || this.stationSel === i;
			const parts = [
				v(model),
				v(effort ? `${effort} effort` : "inherited effort"),
				v(`depth ${r.run.depth}${budget}`),
				// Every agent replies by delivery since 2026-08-24; the old
				// background/foreground word is only meaningful on pre-rename
				// manifests, where foreground was a real mode.
				...(r.run.background ? [] : [v("foreground")]),
				v(toolList ? `${toolList.length} tools` : "default tools") +
					(detail && toolList ? ` ${dimP(`(${toolList.join(", ")})`)}` : "") +
					(detail && cfg.excludeTools?.length ? ` ${v("minus")} ${dimP(`(${cfg.excludeTools.join(", ")})`)}` : ""),
				v(cfg.timeout_s ? `${cfg.timeout_s}s timeout` : "no timeout"),
				...(detail
					? [
							v(cfg.cwd ?? "inherited cwd"),
							cfg.extensions?.length
								? `${v("extensions")} ${dimP(`(${cfg.extensions.join(", ")})`)}`
								: v("no extensions"),
							v(r.run.id),
						]
					: []),
			].join(dot);
			for (const wl of wrapTextWithAnsi(parts, Math.max(20, contentW - indentW)))
				out.push({ text: `${stem}${wl}`, row: r });
		});
		return out;
	}

	private renderStation(width: number): string[] {
		const termRows = this.tui?.terminal?.rows || 24;
		this.stationRows = this.buildStationRows();
		const contentW = Math.max(4, width - 2 * PAD_X - 2);

		// Rows are built at their NATURAL width; horizontal scrolling then
		// slices a window from them, so deep nesting is never truncated.
		const display = this.stationDisplay(contentW);
		this.stationDisplayRows = display.map((d) => d.row);
		const built = display.map((d) => d.text);
		this.stationBuilt = built;
		this.stationMaxW = built.reduce((m, s) => Math.max(m, visibleWidth(s)), 0);
		const needsH = this.stationMaxW > contentW;
		// The live bottom UI is composited here too: pi's editor keeps focus
		// in every view, and a station that returned header + body only had an
		// INVISIBLE, LIVE input bar — typing went into an editor nobody could
		// see and Enter submitted it; a confirm dialog opened there could not
		// be seen or navigated (demonstrated: an unseen confirm answered Yes).
		let bottom = this.tailLines(width, false, false).map((l) =>
			this.retryTint(this.tintTail(this.deindentWorkingRow(l))),
		);
		const maxTail = Math.max(0, termRows - 4);
		if (bottom.length > maxTail) bottom = bottom.slice(bottom.length - maxTail);
		const body = Math.max(3, termRows - 1 - (needsH ? 1 : 0) - bottom.length);
		this.lastBody = body;
		this.lastWidth = width;

		const total = built.length;
		this.lastTotal = total;
		// Header counts RUNS, not display rows: stationDisplay emits a
		// status line plus a task preview plus group spacers per run, so
		// built.length would report "1 run" for an empty station.
		const runCount = this.stationRows.length;
		const maxOffset = Math.max(0, total - body);
		this.offset = Math.max(0, Math.min(this.offset, maxOffset));
		const maxH = Math.max(0, this.stationMaxW - contentW);
		this.hOffset = Math.max(0, Math.min(this.hOffset, maxH));

		const live = this.stationRows.filter((r) => r.run.status === "working" || r.run.status === "queued").length;
		const head = `── ${this.bold(this.fg(this.viewAccent(), "agent station"))}`;
		const tail = ` · ${runCount} ${runCount === 1 ? "run" : "runs"}${live ? ` · ${live} running` : ""} · alt+s close · ctrl+s back `;
		const used = visibleWidth(`── agent station${tail}`);
		const out: string[] = [
			used > width
				? this.fg("dim", ansiTruncate(`── agent station${tail}`, width))
				: head + this.fg("dim", tail + "─".repeat(Math.max(0, width - used))),
		];

		const thumbLen = maxOffset === 0 ? 0 : Math.min(body, Math.max(2, Math.round((body * body) / Math.max(1, total))));
		const thumbPos = maxOffset === 0 ? 0 : Math.round((this.offset / maxOffset) * (body - thumbLen));
		const pad = " ".repeat(PAD_X);
		for (let i = 0; i < body; i++) {
			const idx = this.offset + i;
			const bar =
				thumbLen === 0
					? " "
					: i >= thumbPos && i < thumbPos + thumbLen
						? this.bold(this.fg(this.chromeTone(), "█"))
						: this.fg("dim", "░");
			let content = built[idx] ?? "";
			if (content) content = sliceByColumn(content, this.hOffset, contentW, true);
			const w = visibleWidth(content);
			const fill = " ".repeat(Math.max(0, width - 1 - PAD_X - w));
			let cell = `${pad}${content}${fill}`;
			// The drag selection, inverted like the main view's.
			const span = this.selSpan(idx, contentW);
			if (span) {
				const { pre, mid, suf } = this.sliceSpan(cell, span[0] + PAD_X - this.hOffset, span[1] + PAD_X - this.hOffset);
				cell = pre + invert(mid) + suf;
			}
			out.push(`${cell}${bar}`);
		}

		if (needsH) {
			// Horizontal bar: green thumb on a dim track, draggable. Plain
			// wheel always scrolls vertically; shift+wheel scrolls here, so
			// there is no "which region am I over" ambiguity even when deep
			// content fills the screen.
			const track = Math.max(4, width - 2 * PAD_X - 2);
			const tLen = Math.max(2, Math.round((track * contentW) / Math.max(1, this.stationMaxW)));
			const tPos = maxH === 0 ? 0 : Math.round((this.hOffset / maxH) * (track - tLen));
			let barLine = "";
			for (let i = 0; i < track; i++) {
				barLine += i >= tPos && i < tPos + tLen ? this.bold(this.fg(this.chromeTone(), "━")) : this.fg("dim", "─");
			}
			out.push(`${pad}${barLine}${this.fg("dim", " ⇄")}`);
		}
		out.push(...bottom);
		return out;
	}

	/** Number of display rows the station currently has (0 = nothing to navigate). */
	stationRowCount(): number {
		return this.stationDisplayRows.length;
	}

	/** Station hit test: which run row is under this screen row, if any. */
	private stationRowAt(row: number): StationRow | null {
		const i = this.offset + row - 2;
		if (row - 2 < 0 || row - 2 >= this.lastBody) return null;
		if (i < 0 || i >= this.stationDisplayRows.length) return null;
		return this.stationDisplayRows[i] ?? null;
	}

	private stationIndexAt(row: number): number | null {
		const r = this.stationRowAt(row);
		if (!r) return null;
		const i = this.stationRows.indexOf(r);
		return i < 0 ? null : i;
	}

	private stationClick(row: number, col: number) {
		const r = this.stationRowAt(row);
		if (!r) return;
		const c = col - PAD_X - 1 + this.hOffset;
		// ✕ aborts, ▸/▾ toggles collapse, anywhere else opens the run.
		if (r.abortAt >= 0 && c >= r.abortAt && c <= r.abortAt + 1) {
			try {
				// abortRun is imported from agents/run.ts — the old globalThis
				// control surface no longer exists.
				if (abortRun(r.run.id, abortCause("stopped", "stopped by the user")))
					this.notify(`stopped ${r.run.agent} · ${r.run.title}`);
			} catch {}
			this.tui.requestRender();
			return;
		}
		if (r.hasKids && c >= r.toggleAt && c <= r.toggleAt + 1) {
			if (stationCollapsed.has(r.run.id)) stationCollapsed.delete(r.run.id);
			else stationCollapsed.add(r.run.id);
			this.tui.requestRender();
			return;
		}
		this.openRun(r.run.id);
	}

	hScroll(n: number) {
		const contentW = Math.max(4, this.lastWidth - 2 * PAD_X - 2);
		const maxH = Math.max(0, this.stationMaxW - contentW);
		const next = Math.max(0, Math.min(this.hOffset + n, maxH));
		if (next === this.hOffset) return;
		this.hOffset = next;
		this.tui.requestRender();
	}

	private hJumpToCol(col: number) {
		const track = Math.max(4, this.lastWidth - 2 * PAD_X - 2);
		const contentW = track;
		const maxH = Math.max(0, this.stationMaxW - contentW);
		const rel = Math.max(0, Math.min(track, col - PAD_X - 1));
		this.hOffset = Math.round((rel / Math.max(1, track)) * maxH);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		this.syncTheme();
		if (this.station) {
			try {
				return this.renderStation(width);
			} catch (e) {
				return [ansiTruncate(`station error: ${String(e)}`, Math.max(4, width))];
			}
		}
		try {
			this.lastWidth = width;
			const rows = this.tui?.terminal?.rows || 24;
			// A run view swaps pi's footer for the subagent's own.
			const viewRun = this.childRun();
			this.publishView(viewRun?.id ?? null);
			let tail = this.tailLines(width, !!viewRun, !!viewRun);
			// One colour for the whole bottom UI, every view: green in main,
			// blue in a run. Not conditional on viewRun — main needs the
			// thinking-level tint stripped too.
			// Order matches main: queued "Steering:/Follow-up:" lines, then the
			// working spinner, then the editor, then the run-scoped footer.
			if (viewRun)
				tail = [
					...this.runPendingLines(viewRun),
					...this.runWorkingLine(viewRun),
					...tail,
					this.runFooter(width, viewRun),
					...this.noticeLine(width),
				];
			tail = tail.map((l) => this.retryTint(this.tintTail(this.deindentWorkingRow(l))));
			const maxTail = Math.max(0, rows - 4);
			if (tail.length > maxTail) tail = tail.slice(tail.length - maxTail);
			const body = Math.max(3, rows - 1 - tail.length);
			this.lastBody = body;
			// Content is laid out at a narrower measure: PAD_X each side,
			// the scrollbar column, and one extra right column to balance
			// pi's own outputPad space on the left.
			const contentW = Math.max(4, width - 2 * PAD_X - 2);
			this.lastContentW = contentW;
			if (this.childView) this.maybeRefreshChild();
			const run = this.childRun();
			viewWorking = !!run && (run.status === "working" || run.status === "queued");
			let childLive = false;
			if (run && this.coldOpen === run.id) {
				// A COLD open (2026-08-28): building a large run's component
				// tree is one synchronous frame of seconds (measured: 1.9 s for a
				// 400k-character transcript), and it used to run BEFORE the view
				// switched — the screen sat in main. Paint the bare view now,
				// build on the next tick.
				this.coldOpen = null;
				this.flattenLive(contentW, [], run.id);
				childLive = true;
				const t = setTimeout(() => {
					try {
						this.tui.requestRender();
					} catch {}
				}, 0);
				(t as { unref?: () => void }).unref?.();
			} else if (run) {
				const kids = this.childKids(run);
				if (kids) {
					this.flattenLive(contentW, kids, run.id);
					childLive = true;
				}
			}
			const showingChild = !!this.childView;
			const usingLive = childLive || (liveMode && !showingChild);
			this.surfaceIsLive = usingLive;
			let total: number;
			if (usingLive) {
				if (!childLive) this.flattenLive(contentW);
				total = this.liveLines.length;
			} else {
				this.ensureRawWrapped(contentW);
				total = this.rawWrapped.length;
			}
			// Hold the PREVIOUS frame's content through a handoff dip rather
			// than pinning to a shorter one.
			//
			// At the frame where a streaming component hands off to its
			// persisted copy the content is briefly shorter — measured on a
			// real turn: total 535 -> 530 -> 537. Re-pinning to 530 scrolled
			// the view up 8 rows and the next frame put it back. Letting the
			// pin overshoot instead traded that jump for blank rows, which is
			// the blank flash. Neither is right: the fix is to keep showing
			// the content we already had until the dip resolves, so the
			// surface simply does not change for that frame.
			//
			// Guarded twice, so this only smooths a blip: a drop larger than a
			// third of the viewport is a real change (switching main <-> a
			// run, or a compaction) and is applied at once, and the hold
			// expires on its own regardless. Growth is never held — that IS
			// streaming.
			// Hold the PREVIOUS frame's visible window through a handoff dip.
			//
			// At the frame where a streaming component hands off to its
			// persisted copy the child transcript is briefly shorter. Traced on
			// a real turn: raw 86 -> 75 -> 88, which drags the followed offset
			// down 11 rows and back. Main never does this because it reads pi's
			// single component tree; the child view rebuilds from two lists
			// (cached persisted entries + the live tail) and a message moving
			// between them changes height.
			//
			// Only the VISIBLE WINDOW is snapshotted, never the whole flatten:
			// flattenLive mutates this.liveLines in place, so keeping a
			// reference compared the array against itself and drop was always 0
			// — the reason the previous attempt silently never fired. Copying
			// the whole array instead would be O(transcript) every token.
			let drop = 0;
			let held = 0;
			const raw = total;
			// `>= body`, not `=== body`: the bottom UI changes height whenever
			// the working row or the subagent strip appears, so body moves
			// constantly. Requiring an exact match meant any dip landing on
			// such a frame skipped the hold without saying so — one of the two
			// reasons this fired only sometimes.
			if (usingLive && this.follow && this.holdTotal > 0 && this.holdWindow.length >= body) {
				drop = this.holdTotal - raw;
				// Up to a full viewport. The other reason for intermittency:
				// a traced drop of 19 rows was rejected by a body/2 guard of
				// 14. Beyond a full screen it is a genuine change of content,
				// not a handoff blip.
				const blip = drop > 0 && drop <= body;
				const fresh = !this.followHoldAt || Date.now() - this.followHoldAt < FOLLOW_HOLD_MS;
				if (blip && fresh) {
					if (!this.followHoldAt) this.followHoldAt = Date.now();
					held = 1;
					total = this.holdTotal;
				}
			}
			if (!held) this.followHoldAt = 0;

			this.lastTotal = total;
			const maxOffset = Math.max(0, total - body);
			if (!held) {
				if (this.follow) this.offset = maxOffset;
				this.offset = Math.max(0, Math.min(this.offset, maxOffset));
				// Collapse returns to the beat: put the folded beat's head row
				// back at the screen row where it was expanded from.
				if (this.pendingScrollBeat) {
					const at = this.beatRows.get(this.pendingScrollBeat);
					// Only when the head row is OFF-SCREEN (round 27, maintainer):
					// a short panel folds with its head already in view — jumping
					// then would move a view that needs no moving. The rows above
					// the beat are untouched by the fold, so the post-fold index
					// compared against the post-clamp window answers "can I see
					// the head right now" exactly.
					if (at !== undefined && !(at >= this.offset && at < this.offset + body)) {
						const anchor = Math.max(0, Math.min(body - 1, this.collapseAnchor.get(this.pendingScrollBeat) ?? 2));
						this.offset = Math.max(0, Math.min(maxOffset, at - anchor));
						this.follow = this.offset >= maxOffset;
						// Collapse-return flash (round 26): invert the landing BEAT
						// for a moment so the eye finds where the view snapped to —
						// every row it now occupies (2026-08-20, maintainer: a
						// working act folds to sentence + snippet, a cluster header
						// wraps; the head row alone under-marked both). Fires only
						// WITH a jump — an unmoved view needs no beacon.
						const len = Math.max(1, this.beatLens.get(this.pendingScrollBeat) ?? 1);
						this.flash(Array.from({ length: len }, (_, i) => at + i));
						trace({ ev: "flash", at, len, offset: this.offset });
					}
					this.pendingScrollBeat = null;
				}
				// Snapshot what we are about to draw, for the next frame to fall
				// back on. O(body), and a copy rather than a reference.
				this.holdTotal = raw;
				this.holdWindow = [];
				this.holdHeads = [];
				this.holdFlush = [];
				if (usingLive)
					for (let i = 0; i < body + HOLD_MARGIN; i++) {
						this.holdWindow.push(this.liveLines[this.offset + i] ?? "");
						this.holdHeads.push(this.liveHeads.get(this.offset + i));
						this.holdFlush.push(this.liveFlush.has(this.offset + i));
					}
			}
			trace({
				src: usingLive ? (childLive ? "child" : "main") : "raw",
				rows,
				tail: tail.length,
				// raw is the flatten's own height; total is what we render
				// after a hold. drop>0 with held=0 means the guard rejected it
				// and the surface moved — that is a flicker frame.
				raw,
				total,
				drop,
				held,
				hw: this.holdWindow.length,
				cacheN: this.lastCacheN,
				liveN: this.lastLiveN,
				body,
				offset: this.offset,
				follow: this.follow ? 1 : 0,
				ms: this.lastFlatMs,
			});
			// The follow pin may sit past maxOffset for a frame (see above), so
			// both readouts are clamped rather than allowed to overshoot.
			const pct = maxOffset === 0 ? 100 : Math.min(100, Math.round(((this.offset + body) / total) * 100));
			const thumbLen = maxOffset === 0 ? 0 : Math.min(body, Math.max(2, Math.round((body * body) / total)));
			const thumbPos =
				maxOffset === 0
					? 0
					: Math.max(0, Math.min(body - thumbLen, Math.round((this.offset / maxOffset) * (body - thumbLen))));
			const pad = " ".repeat(PAD_X);
			const out: string[] = [this.titleBar(width, pct)];
			for (let i = 0; i < body; i++) {
				const idx = this.offset + i;
				// Accent-green thumb (bold) on a subtle dim track.
				const bar =
					thumbLen === 0
						? " "
						: i >= thumbPos && i < thumbPos + thumbLen
							? this.bold(this.fg(this.chromeTone(), "█"))
							: this.fg("dim", "░");
				let content: string;
				if (usingLive) {
					let ln = held ? (this.holdWindow[i] ?? "") : (this.liveLines[idx] ?? "");
					if (ln.includes("\x1b_G")) ln = "[image]";
					content = ln;
				} else {
					const l = this.rawWrapped[idx];
					content = l ? this.styleRaw(l) : "";
				}
				let w = visibleWidth(content);
				if (w > contentW) {
					content = sliceByColumn(content, 0, contentW, true);
					w = Math.min(contentW, visibleWidth(content));
				}
				// Terminate any open OSC-8 hyperlink: otherwise our padding
				// spaces join the link and the terminal underlines them on
				// hover (the "trailing dots").
				if (content.includes("\x1b]8;")) content += "\x1b]8;;\x07";
				// Fill from remaining cell space: right margin equals the
				// left pad and the scrollbar sits flush at the edge, at
				// every terminal width.
				// MUST be pi-tui's visibleWidth, not the terminal's true width.
				// This terminal draws `base + U+FE0F` in one column while
				// pi-tui counts two, so a row with such an emoji renders one
				// column short and the scrollbar sits one column in. Measuring
				// it correctly and padding to match makes the line width+1 by
				// pi-tui's reckoning, and tui.js compositeOverlays truncates
				// overlay lines with ITS OWN measure — taking the last column,
				// which is the scrollbar. An extension cannot win this: the
				// bar one column in is strictly better than no bar at all.
				// The beat glyph is painted INTO the side pad (` ●` — one space,
				// one cell), so content keeps its x-position and the glyph column
				// lines up with the working row's spinner (Loader pads one).
				// Informational beats render flush (no pad): their own 1-space
				// lead lands the text exactly in the glyph column.
				let glyph = usingLive ? (held ? this.holdHeads[i] : this.liveHeads.get(idx)) : undefined;
				// Blink at COMPOSITION time (round 31): the cached marker is
				// phase-free; the frame decides glyph-or-blank right here, so
				// the phase is always current and nothing bakes into a cache.
				if (glyph && glyph.startsWith(BLINK))
					glyph = Math.floor(Date.now() / 500) % 2 ? glyph.slice(BLINK.length) : " ";
				const flush = usingLive ? (held ? (this.holdFlush[i] ?? false) : this.liveFlush.has(idx)) : false;
				// The gutter touches the terminal edge (round 7): glyphs sit at
				// column 1 with no lead, flush (info/banner) rows at column 1.
				const rowPad = glyph ? glyph : flush ? "" : pad;
				const padW = glyph ? 1 : flush ? 0 : PAD_X;
				const fill = " ".repeat(Math.max(0, width - 1 - padW - w));
				// Bg boxes go full-bleed: side padding painted in the
				// line's own background.
				const bg = usingLive ? leadingBg(content) : "";
				let cell = bg ? `${bg}${rowPad}${content}${bg}${fill}\x1b[49m` : `${rowPad}${content}${fill}`;
				const flashing = this.flashRow && this.flashRow.rows.has(idx) && Date.now() < this.flashRow.until;
				const span = idx < total ? this.selSpan(idx, contentW) : null;
				if (flashing) {
					// Collapse-return flash: the WHOLE line inverts (round 27 —
					// inverting only the text span read as three different
					// highlights depending on row length: short rows "to the
					// left", long rows "full line". One rule, unmistakable).
					cell = invert(cell);
				} else if (span) {
					const [a, b] = span;
					const { pre, mid, suf } = this.sliceSpan(cell, a + padW, b + padW);
					cell = pre + invert(mid) + suf;
				} else if (
					usingLive &&
					this.hoverFold &&
					idx >= this.hoverFold.from &&
					idx < this.hoverFold.to &&
					this.liveHandles.has(idx)
				) {
					// Hovering a fold handle LIGHTS its characters — same glyphs,
					// bright text tier, no inverse block. Every row of a grouped
					// handle lights, each over its own text span.
					//
					// A FOREGROUND SUBSTITUTION, not a re-synthesis (round 31
					// audit): the old `stripAnsi(mid)` + one repaint threw away
					// every attribute the span carried — the act sentence's BOLD
					// verb went plain and an ERRORED act's red went white, so
					// hovering a failure made it look like a success. Bold,
					// italic, underline and the evidence field's background are
					// structure and survive untouched; the error red is STATE and
					// is left out of the substitution.
					const { a, b } = this.liveHandles.get(idx) as { a: number; b: number };
					const { pre, mid, suf } = this.sliceSpan(cell, a + padW, b + padW);
					const seq = (tok: string) => {
						try {
							return ((this.theme as any).fg(tok, "\0") as string).split("\0")[0];
						} catch {
							return "";
						}
					};
					const textSeq = seq("text");
					const errSeq = seq("error");
					// The error red is STATE and must not turn white — but a red
					// row still needs a hover tell (maintainer: "it doesn't
					// light"): its red is LIFTED, each channel a third of the way
					// to white, so a failure lights as a brighter failure.
					const litErr = errSeq.replace(
						/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/,
						(_m, r, g, b) =>
							`\x1b[38;2;${Math.round(+r + (255 - +r) / 3)};${Math.round(+g + (255 - +g) / 3)};${Math.round(+b + (255 - +b) / 3)}m`,
					);
					const lit = mid.replace(/\x1b\[(?:38;[0-9;:]*m|39m|3[0-7]m|9[0-7]m)/g, (s) =>
						errSeq && s === errSeq ? litErr : textSeq,
					);
					// A row painted red from its first character carries the red
					// in `pre`, not in `mid`; open with the lifted red then.
					const startsRed = errSeq && pre.endsWith(errSeq);
					cell = pre + (startsRed ? litErr : textSeq) + lit + "\x1b[39m" + suf;
				}
				// The link underline COMPOSES with the fold light (a canvas
				// title sits inside a lit fold handle): underline whatever the
				// row became — the two cues answer two different clicks.
				if (this.hoverLink) {
					const seg = this.hoverLink.segs.find((g) => g.idx === idx);
					if (seg) {
						const { pre, mid, suf } = this.sliceSpan(cell, seg.a + padW, seg.b + padW);
						cell = pre + underline(mid) + suf;
					}
				}
				out.push(`${cell}${bar}`);
			}
			// Floating jump-to-bottom pill, centered on the last body row,
			// whenever we are scrolled away from the live tail.
			this.jumpBtn = null;
			if (maxOffset > 0 && this.offset < maxOffset) {
				const label = " Jump to bottom ↓ ";
				const bw = visibleWidth(label);
				if (bw + 4 < width) {
					const c0 = Math.floor((width - bw) / 2);
					const rowStr = out[body];
					const pill = this.pillHover ? invert(this.bold(this.fg(this.viewAccent(), label))) : invert(label);
					out[body] = sliceByColumn(rowStr, 0, c0, false) + pill + sliceByColumn(rowStr, c0 + bw, width, false);
					this.jumpBtn = { row: body + 1, c0, c1: c0 + bw };
				}
			}
			// Live bottom UI drawn inside the overlay, bottom-anchored.
			// Defensive clamp — the TUI hard-crashes on overwide lines.
			this.lastTailLines = tail;
			for (let ti = 0; ti < tail.length; ti++) {
				let t = tail[ti];
				// The hovered editor ref underlines like a link (2026-08-22).
				if (this.tailRefHover && this.tailRefHover.row === ti) {
					const { pre, mid, suf } = this.sliceSpan(t, this.tailRefHover.a, this.tailRefHover.b);
					t = pre + underline(mid) + suf;
				}
				out.push(visibleWidth(t) > width ? sliceByColumn(t, 0, width, true) : t);
			}
			return out;
		} catch (e) {
			return [ansiTruncate(`pager error: ${String(e)}`, Math.max(4, width))];
		}
	}

	// TUI.invalidate() fans out to every overlay component — it fires on
	// theme change. Cached lines carry baked-in SGR colors, so retire the
	// whole cache generation and force a full re-flatten rather than
	// showing the previous palette until the next content event.
	invalidate() {
		// bumpCacheGen() + getCacheGen(), never a `cacheGen` import. Under
		// jiti an imported `export let` is a SNAPSHOT, not a live binding
		// (round 31 audit, probes/livebinding.mjs): this bumped flatten.ts's
		// counter while every comparison here read a frozen 0, so the whole
		// cache stayed "current" and a live theme change left the transcript
		// in the old palette. Read the generation through the function.
		bumpCacheGen();
		this.rawWrappedWidth = -1;
		this.flatKey = "";
		this.liveDirty = true;
	}

	/* ----- mouse ----- */

	// Screen coords are 1-based; row 1 is the title bar; content starts
	// at screen column PAD_X + 1.
	handleMousePress(row: number, col: number) {
		if (this.station) {
			// Horizontal bar sits on the last body row when present.
			if (this.stationMaxW > this.lastWidth - 2 * PAD_X - 2 && row - 2 >= this.lastBody) {
				this.hDragging = true;
				this.hJumpToCol(col);
				return;
			}
			if (col >= this.lastWidth - 1 && row - 2 < this.lastBody) {
				this.sbDragging = true;
				this.jumpToRow(row);
				return;
			}
			// DRAG SELECTS here too (2026-08-22c, maintainer) — the main view's
			// mechanism: press anchors, drag highlights, right-click copies,
			// and a click that never dragged opens the run on RELEASE.
			if (row - 2 >= this.lastBody) return;
			const sIdx = this.offset + row - 2;
			this.selAnchor = null;
			this.selHead = null;
			this.dragged = false;
			if (sIdx < 0 || sIdx >= this.lastTotal) {
				this.stationPendingClick = null;
				this.tui.requestRender();
				return;
			}
			this.selecting = true;
			this.selAnchor = { idx: sIdx, col: Math.max(0, col - 1 - PAD_X) };
			this.selHead = { ...this.selAnchor };
			this.stationPendingClick = { row, col };
			this.tui.requestRender();
			return;
		}
		// Back segments live on the final row of a run view.
		if (this.childRun() && this.backBtns.length && row >= this.lastBody + 2) {
			for (const b of this.backBtns) {
				if (col > b.c0 && col <= b.c1) {
					if (b.target) this.openRun(b.target);
					else this.exitChildView();
					return;
				}
			}
		}
		if (this.jumpBtn && row === this.jumpBtn.row && col > this.jumpBtn.c0 && col <= this.jumpBtn.c1) {
			this.toBottom();
			return;
		}
		if (col >= this.lastWidth - 1 && row - 2 < this.lastBody) {
			this.sbDragging = true;
			this.jumpToRow(row);
			return;
		}
		// Clicks on the bottom UI rows (editor area) are not ours.
		if (row - 2 >= this.lastBody) return;
		const idx = this.offset + row - 2;
		const hadSelection = this.dragged && this.selAnchor;
		this.selAnchor = null;
		this.selHead = null;
		this.dragged = false;
		if (idx < 0 || idx >= this.lastTotal) {
			if (hadSelection) this.tui.requestRender();
			return;
		}
		this.selecting = true;
		this.selAnchor = { idx, col: this.contentCol(idx, col) };
		this.selHead = { ...this.selAnchor };
		if (hadSelection) this.tui.requestRender();
	}

	handleMouseMove(row: number, col: number, ctrl = false) {
		if (this.station) {
			const i = this.stationIndexAt(row);
			// CTRL+hover opens a run's full configuration (2026-08-22c) —
			// plain hover only lights; the arrows' selection opens it too. An
			// OPEN detail stays open while the pointer remains on its run
			// (releasing ctrl or a same-row wiggle must not fold it); leaving
			// the row folds.
			const d = ctrl ? i : this.stationDetail !== null && this.stationDetail === i ? i : null;
			if (i !== this.stationHover || d !== this.stationDetail) {
				this.stationHover = i;
				this.stationDetail = d;
				this.tui.requestRender();
			}
			return;
		}
		// Breadcrumb segments light up under the cursor.
		if (this.childRun() && this.backBtns.length) {
			let hit: number | null = null;
			if (row >= this.lastBody + 2) {
				this.backBtns.forEach((b, i) => {
					if (col > b.c0 && col <= b.c1) hit = i;
				});
			}
			if (hit !== this.backHover) {
				this.backHover = hit;
				this.tui.requestRender();
			}
		} else if (this.backHover !== null) {
			this.backHover = null;
		}
		const over = !!(this.jumpBtn && row === this.jumpBtn.row && col > this.jumpBtn.c0 && col <= this.jumpBtn.c1);
		let changed = false;
		if (over !== this.pillHover) {
			this.pillHover = over;
			changed = true;
		}
		const idx = this.offset + row - 2;
		const inBody = idx >= 0 && idx < this.lastTotal && row - 2 < this.lastBody;
		{
			// `[^image N]` in the INPUT BAR underlines under the mouse, like a
			// link — the ctrl+click tell.
			let hover: { row: number; a: number; b: number } | null = null;
			if (!inBody && row - 2 >= this.lastBody) {
				const ti = row - 2 - this.lastBody;
				const tl = this.lastTailLines[ti];
				if (typeof tl === "string") {
					const plain = stripAnsi(tl);
					const c = Math.max(0, col - 1);
					const re = /\[\^image \d+\]/g;
					let m: RegExpExecArray | null;
					while ((m = re.exec(plain))) {
						const a = visibleWidth(plain.slice(0, m.index));
						const b = a + visibleWidth(m[0]);
						if (c >= a && c < b) {
							hover = { row: ti, a, b };
							break;
						}
					}
				}
			}
			if (hover?.row !== this.tailRefHover?.row || hover?.a !== this.tailRefHover?.a) {
				this.tailRefHover = hover;
				changed = true;
			}
		}
		// Fold handles highlight on hover — the affordance the "click to
		// expand" hint used to be. Only the handle's TEXT span lights, and
		// only while the mouse is on it. It no longer SUPPRESSES the link
		// underline (2026-08-26b, maintainer: a path in `edited <path>` had
		// no cue): the two compose below — light says click folds, underline
		// says ctrl+click opens.
		const hspan = inBody && this.surfaceIsLive ? this.liveHandles.get(idx) : undefined;
		const cc = this.contentCol(idx, col);
		// A grouped handle (a wrapped header) lights as ONE control (round 26).
		const fold =
			!over && hspan && cc >= hspan.a && cc < hspan.b
				? (this.liveHandleGroup.get(idx) ?? { from: idx, to: idx + 1 })
				: null;
		// Field compare, not JSON.stringify — this runs per pixel of mouse
		// travel under all-motion tracking (round 30 audit).
		if (fold?.from !== this.hoverFold?.from || fold?.to !== this.hoverFold?.to) {
			this.hoverFold = fold;
			changed = true;
		}
		// Path-shaped tokens get a link-style underline on hover — every row a
		// wrapped one spans (tokenChainAt). A TEXT-GATED ctrl target (a canvas
		// title, an image ref) underlines FIRST, fold light or not — the same
		// precedence handleCtrlClick gives it — so the link cue shows on
		// collapsed heads too (2026-08-26, maintainer: no underline on hover).
		let link: { segs: { idx: number; a: number; b: number }[]; key: string } | null = null;
		if (!over && inBody && this.surfaceIsLive) {
			const g = this.liveRanges.find(
				(r) => r.ctrl && r.a !== undefined && idx >= r.start && idx < r.end && cc >= r.a && cc < (r.b ?? Infinity),
			);
			if (g) link = { segs: [{ idx, a: g.a ?? 0, b: g.b ?? (g.a ?? 0) + 1 }], key: `g${g.start}:${g.a}` };
		}
		if (!link && !over && inBody) {
			const chain = this.tokenChainAt(idx, this.contentCol(idx, col));
			// Underline only what ctrl+click could actually open — a real file or
			// a URL — never slashed prose.
			if (chain && this.openTarget(chain.token)) {
				// The underline covers what OPENS, not the sentence punctuation
				// around it (maintainer, 2026-08-20: the full stop after a path
				// was underlined too) — trim the span by what openTarget strips.
				const segs = chain.segs.map((g) => ({ ...g }));
				const lead = (/^[('"<\[·]+/.exec(chain.token) ?? [""])[0].length;
				const trail = (/[)'">\],;:·.…]+$/.exec(chain.token) ?? [""])[0].length;
				segs[0].a = Math.min(segs[0].a + lead, segs[0].b);
				const lastSeg = segs[segs.length - 1];
				lastSeg.b = Math.max(lastSeg.b - trail, lastSeg.a);
				link = { segs, key: segs.map((g) => `${g.idx}:${g.a}:${g.b}`).join("|") };
			}
		}
		if (link?.key !== this.hoverLink?.key) {
			this.hoverLink = link;
			changed = true;
		}
		if (changed) this.tui.requestRender();
	}

	/**
	 * Screen column → content column for a surface row. Flush-left
	 * informational rows have no side pad, so their content starts two
	 * columns earlier than padded rows.
	 */
	private contentCol(idx: number, col: number): number {
		const flush = this.surfaceIsLive && this.liveFlush.has(idx);
		return Math.max(0, col - 1 - (flush ? 0 : PAD_X));
	}

	/**
	 * Split a styled cell into [before span, span, after span] by VISIBLE
	 * columns, keeping the suffix's original bytes intact.
	 *
	 * The obvious `sliceByColumn(cell, b, …)` for the suffix re-emits the SGR
	 * state active at column b — and at a colour-reset boundary it re-emits the
	 * pre-reset colour AFTER the reset, so a hover/selection wrap made the
	 * following words inherit the span's colour (the "leak to the next words").
	 * Slicing on byte offsets instead — prefixes never re-emit — leaves the
	 * original `…\x1b[39m rest` exactly as it was, so the caller's wrap closes
	 * cleanly and nothing bleeds past the span.
	 */
	/**
	 * Lift a pre-painted row's FOREGROUND to the bright text tier, keeping
	 * bold/italic/underline/background as the renderer set them (the same
	 * substitution hover uses; the error red is state and stays).
	 */
	private liftToText(row: string): string {
		const seq = (tok: string) => {
			try {
				return ((this.theme as any).fg(tok, "\0") as string).split("\0")[0];
			} catch {
				return "";
			}
		};
		const textSeq = seq("text");
		const errSeq = seq("error");
		const lit = row.replace(/\x1b\[(?:38;[0-9;:]*m|39m|3[0-7]m|9[0-7]m)/g, (m) =>
			errSeq && m === errSeq ? m : textSeq,
		);
		return textSeq + lit + "\x1b[39m";
	}

	private sliceSpan(cell: string, aCol: number, bCol: number): { pre: string; mid: string; suf: string } {
		const pre = sliceByColumn(cell, 0, aCol, false);
		const midEnd = sliceByColumn(cell, 0, bCol, false);
		return { pre, mid: midEnd.slice(pre.length), suf: cell.slice(midEnd.length) };
	}

	// Token boundaries include quotes, brackets and parens — not just
	// whitespace — so a path embedded in code (`jiti('/home/x.ts')`, a quoted
	// string, `[link](url)`) is isolated to just the path/URL instead of being
	// glued to the surrounding syntax and failing to resolve.
	private static readonly TOKEN_BOUNDARY = /[\s'"`()<>[\]{}]/;
	/**
	 * `c` is a DISPLAY COLUMN and the walk is over CODE UNITS — the two are
	 * only the same for pure ASCII. The old version used the column straight
	 * as a string index and returned string indices as columns, so one CJK
	 * word ahead of a path (each glyph two columns wide, one code unit) slid
	 * the hit point and the underline by the whole width difference: seven
	 * columns on `日本語のテスト /path`, demonstrated with
	 * probes/tokenspan.mjs. Convert in on the way in (`sliceByColumn`) and
	 * out on the way out (`visibleWidth`); the token itself is text, so it
	 * stays in code units.
	 */
	private tokenSpanAt(idx: number, c: number): { a: number; b: number; token: string } | null {
		const raw = this.surfaceIsLive ? (this.liveLines[idx] ?? "") : (this.rawWrapped[idx]?.text ?? "");
		const plain = stripAnsi(raw);
		if (!plain.trim()) return null;
		const bound = PagerComponent.TOKEN_BOUNDARY;
		const cc = Math.min(sliceByColumn(plain, 0, Math.max(0, c), false).length, plain.length);
		let a = cc;
		while (a > 0 && !bound.test(plain[a - 1])) a--;
		let b = cc;
		while (b < plain.length && !bound.test(plain[b])) b++;
		if (a >= b) return null;
		return { a: visibleWidth(plain.slice(0, a)), b: visibleWidth(plain.slice(0, b)), token: plain.slice(a, b) };
	}

	/**
	 * The token at (idx, c) EXTENDED across the display rows it wrapped over
	 * (2026-08-20, maintainer: a URL wrapped over three rows hovered and
	 * ctrl-clicked as its one-row fragment). A hard wrap splits a long token
	 * mid-run: the fragment runs to the very end of a row that fills the
	 * measure, and the remainder opens the next row at its wrap indent. Both
	 * marks are checked on every hop — a token that merely ends a short line
	 * never chains — and fragments join with nothing between them, exactly as
	 * the wrap cut them. Bounded at 8 rows.
	 */
	private tokenChainAt(
		idx: number,
		c: number,
	): { token: string; segs: { idx: number; a: number; b: number }[] } | null {
		const first = this.tokenSpanAt(idx, c);
		if (!first) return null;
		const rowPlain = (i: number): string =>
			stripAnsi(this.surfaceIsLive ? (this.liveLines[i] ?? "") : (this.rawWrapped[i]?.text ?? ""));
		// "Fills the measure" depends on WHERE the row is: prose wraps at the
		// content width, but an expanded panel's rows wrap at the tool width
		// (width-10, plus their ⎿ inset), so a hard-wrapped URL inside a panel
		// never reached `contentW - 2` and its second row neither underlined
		// nor opened (demonstrated 2026-08-22: a wiki link in a read panel).
		// A field-painted row (leadingBg) is judged against the panel measure.
		const fullRow = (plain: string, i: number): boolean => {
			const raw = this.surfaceIsLive ? (this.liveLines[i] ?? "") : (this.rawWrapped[i]?.text ?? "");
			const measure = leadingBg(raw) ? this.lastContentW - 8 : this.lastContentW - 2;
			return visibleWidth(plain.replace(/\s+$/, "")) >= measure;
		};
		const endsRow = (plain: string, b: number): boolean => b >= visibleWidth(plain.replace(/\s+$/, ""));
		const leadCols = (plain: string): number => visibleWidth((/^\s*/.exec(plain) as RegExpExecArray)[0]);
		const segs = [{ idx, a: first.a, b: first.b }];
		let token = first.token;
		// Backward: this fragment starts the row → the previous row may hold the head.
		let at = idx;
		let cur = { a: first.a, b: first.b };
		while (segs.length < 8 && at > 0) {
			const plain = rowPlain(at);
			if (cur.a !== leadCols(plain)) break;
			const prev = rowPlain(at - 1);
			if (!fullRow(prev, at - 1)) break;
			const span = this.tokenSpanAt(at - 1, Math.max(0, visibleWidth(prev.replace(/\s+$/, "")) - 1));
			if (!span || !endsRow(prev, span.b)) break;
			at--;
			cur = { a: span.a, b: span.b };
			segs.unshift({ idx: at, a: span.a, b: span.b });
			token = span.token + token;
		}
		// Forward: this fragment fills the row to its end → the next row may continue it.
		at = idx;
		cur = { a: first.a, b: first.b };
		while (segs.length < 8) {
			const plain = rowPlain(at);
			if (!fullRow(plain, at) || !endsRow(plain, cur.b)) break;
			const next = rowPlain(at + 1);
			if (!next.trim()) break;
			const lead = leadCols(next);
			const span = this.tokenSpanAt(at + 1, lead);
			if (!span || span.a !== lead) break;
			at++;
			cur = { a: span.a, b: span.b };
			segs.push({ idx: at, a: span.a, b: span.b });
			token += span.token;
		}
		return { token, segs };
	}

	/**
	 * Resolve a hovered/clicked token to an openable target, or null.
	 *
	 * ONLY an http(s) URL or a path that actually EXISTS on disk qualifies —
	 * so prose that merely contains a slash ("she/he/it") never highlights and
	 * never claims to be openable. Memoised per raw token so hover, which fires
	 * on every mouse-move, does not stat the filesystem repeatedly.
	 */
	private openProbe: {
		raw: string;
		target: { kind: "url"; value: string } | { kind: "file"; path: string } | null;
	} | null = null;
	private openTarget(raw: string): { kind: "url"; value: string } | { kind: "file"; path: string } | null {
		if (this.openProbe?.raw === raw) return this.openProbe.target;
		// Trailing sentence punctuation is prose, not path: `Saved to /x/y.md.`
		// failed existsSync on the full stop (demonstrated 2026-08-20).
		const token = raw.replace(/^[('"<\[·]+|[)'">\],;:·.…]+$/g, "").replace(/:\d+(?:-\d+)?$/, "");
		let target: { kind: "url"; value: string } | { kind: "file"; path: string } | null = null;
		if (token) {
			if (/^https?:\/\//i.test(token)) {
				target = { kind: "url", value: token };
			} else {
				// Only stat something path-shaped: absolute, ~/, or containing a
				// slash or a dot. A real file makes it a target; anything else
				// (including slashed prose) fails existsSync and stays null.
				let p: string | undefined;
				if (token.startsWith("~/")) p = path.join(os.homedir(), token.slice(2));
				else if (path.isAbsolute(token)) p = token;
				else if (/[/.]/.test(token)) p = path.resolve(process.cwd(), token);
				if (p) {
					try {
						if (fs.existsSync(p)) target = { kind: "file", path: p };
					} catch {}
				}
			}
		}
		this.openProbe = { raw, target };
		return target;
	}

	// Ctrl+click: open the clicked token if it is an existing file or a URL,
	// otherwise say WHY on the footer so a dud click is never silent.
	/** Open a file in the system viewer (util/opener.ts), saying so — or why not. */
	private openFile(file: string) {
		if (!fs.existsSync(file)) {
			this.notify(`Can't open ${path.basename(file)} — the file is gone`);
			return;
		}
		// The opener answers a tick later (a missing binary is an async error,
		// never a throw — util/opener.ts); the notice follows it.
		void openExternal(file).then((r) =>
			this.notify(r.ok ? `Opened ${path.basename(file)}` : `Open failed: ${r.reason}`),
		);
	}

	handleCtrlClick(row: number, col: number) {
		if (this.station) return;
		const idx = this.offset + row - 2;
		// The INPUT BAR (2026-08-22, maintainer): a ctrl+click on an `[^image N]`
		// ref in the editor's rows opens that attachment — the store behind the
		// refs is the one the submit pipeline reads.
		if (row - 2 >= this.lastBody) {
			const tl = this.lastTailLines[row - 2 - this.lastBody];
			if (typeof tl === "string") {
				const plain = stripAnsi(tl);
				const c = Math.max(0, col - 1);
				const re = /\[\^image (\d+)\]/g;
				let m: RegExpExecArray | null;
				while ((m = re.exec(plain))) {
					const a = visibleWidth(plain.slice(0, m.index));
					const b = a + visibleWidth(m[0]);
					if (c >= a && c < b) {
						const file = attachmentPath(Number(m[1]));
						if (file) this.openFile(file);
						else this.notify(`[^image ${m[1]}] is not attached`);
						return;
					}
				}
			}
			return;
		}
		if (idx < 0 || idx >= this.lastTotal) return;
		const cc = this.contentCol(idx, col);
		// A TEXT-GATED ctrl range (a specific target, like an image row's
		// `[^image N]`) wins over the generic token probe — a banner glyph
		// under the same column is not what the click meant. A row-wide ctrl
		// range (the wire toggle) is the FALLBACK below, after token-open.
		const gated = this.surfaceIsLive
			? this.liveRanges.find(
					(r) => r.ctrl && r.a !== undefined && idx >= r.start && idx < r.end && cc >= r.a && cc < (r.b ?? Infinity),
				)
			: undefined;
		if (gated) {
			gated.action();
			return;
		}
		const span = this.tokenChainAt(idx, cc);
		// Token-open wins: ctrl+click ON a path or URL opens it, exactly as
		// before. Anywhere else on a wire-eligible beat (a tool act with a
		// result, a delivery, the prompt box) it toggles that beat's WIRE
		// view; the "Can't open" notice remains only for a non-opening token
		// on a beat with no wire.
		const target = span ? this.openTarget(span.token) : null;
		if (!target) {
			const wire = this.surfaceIsLive
				? this.liveRanges.find((r) => r.ctrl && r.a === undefined && idx >= r.start && idx < r.end)
				: undefined;
			if (wire) {
				wire.action();
				return;
			}
			if (!span) return;
			const shown = span.token.replace(/^[('"<\[·]+|[)'">\],;:·.…]+$/g, "").replace(/:\d+(?:-\d+)?$/, "") || span.token;
			const label = shown.length > 40 ? `${shown.slice(0, 40)}…` : shown;
			this.notify(`Can't open "${label}" — no such file or link`);
			return;
		}
		const arg = target.kind === "url" ? target.value : target.path;
		void openExternal(arg).then((r) =>
			this.notify(
				r.ok
					? target.kind === "url"
						? "Opened link"
						: `Opened ${path.basename(target.path)}`
					: `Open failed: ${r.reason}`,
			),
		);
	}

	handleMouseDrag(row: number, col: number) {
		if (this.hDragging) {
			this.hJumpToCol(col);
			return;
		}
		if (this.station) {
			if (this.sbDragging) {
				this.jumpToRow(row);
				return;
			}
			if (!this.selecting || !this.selAnchor) return;
			const sIdx = Math.max(0, Math.min(this.lastTotal - 1, this.offset + row - 2));
			const c = Math.max(0, col - 1 - PAD_X);
			if (sIdx !== this.selHead?.idx || c !== this.selHead?.col) {
				this.selHead = { idx: sIdx, col: c };
				this.dragged = true;
				this.stationPendingClick = null;
				this.tui.requestRender();
			}
			return;
		}
		if (this.sbDragging) {
			this.jumpToRow(row);
			return;
		}
		if (!this.selecting || !this.selAnchor) return;
		const idx = Math.max(0, Math.min(this.lastTotal - 1, this.offset + row - 2));
		const c = this.contentCol(idx, col);
		if (idx !== this.selHead?.idx || c !== this.selHead?.col) {
			this.selHead = { idx, col: c };
			this.dragged = true;
			this.follow = false;
			this.tui.requestRender();
		}
	}

	handleMouseRelease() {
		if (this.hDragging) this.hDragging = false;
		if (this.sbDragging) {
			this.sbDragging = false;
			return;
		}
		if (this.station) {
			this.selecting = false;
			const pending = this.stationPendingClick;
			this.stationPendingClick = null;
			if (this.dragged) {
				this.tui.requestRender();
			} else if (pending) {
				this.selAnchor = null;
				this.selHead = null;
				this.stationClick(pending.row, pending.col);
			}
			return;
		}
		if (!this.selecting || !this.selAnchor || !this.selHead) return;
		this.selecting = false;
		if (this.dragged) {
			// Selection stays highlighted; right-click copies it.
			this.tui.requestRender();
		} else {
			const idx = this.selAnchor.idx;
			const cc = this.selAnchor.col;
			this.selAnchor = null;
			this.selHead = null;
			// A click that lands on no range does nothing and says nothing,
			// which is indistinguishable from a click that was swallowed.
			// Record enough to tell those apart.
			trace({
				ev: "click",
				idx,
				cc,
				offset: this.offset,
				total: this.lastTotal,
				ranges: this.surfaceIsLive ? this.liveRanges.length : -1,
				hit: this.surfaceIsLive ? (this.liveRanges.some((r) => idx >= r.start && idx < r.end) ? 1 : 0) : -1,
				span: this.surfaceIsLive
					? (() => {
							const m = this.liveRanges.find((r) => idx >= r.start && idx < r.end);
							return m ? `${m.a ?? "-"}..${m.b ?? "-"}` : "none";
						})()
					: "raw",
			});
			this.handleClick(idx, cc);
		}
	}

	// Strip the common leading indentation of a run of plain lines —
	// removes pager/outputPad padding from copies.
	private dedent(lines: string[]): string[] {
		let min = Infinity;
		for (const l of lines) {
			if (!l.trim()) continue;
			min = Math.min(min, (/^ */.exec(l) as RegExpExecArray)[0].length);
		}
		if (!Number.isFinite(min)) min = 0;
		return lines.map((l) => l.slice(Math.min(min, l.length)).replace(/\s+$/, ""));
	}

	// Invoked by right-click: copy the current selection. Blocks fully
	// covered by the selection are copied as their RAW SOURCE (markdown
	// intact); partial coverage falls back to cleaned visible text.
	/**
	 * Rejoin rows that are only separated because the surface wrapped them.
	 *
	 * Copy walks DISPLAY rows, so a paragraph that wrapped across four rows
	 * arrived as four lines with hard breaks in the middle of sentences.
	 * A row that was wrapped nearly fills the measure — word wrap can only
	 * leave the width of one word ragged — whereas a line that genuinely
	 * ended stops short. That is the signal used here; blank rows always
	 * break, so real paragraph structure survives.
	 */
	private unwrap(rows: string[]): string[] {
		const w = this.lastContentW;
		if (!w) return rows;
		const out: string[] = [];
		for (const row of rows) {
			const cur = row.trimEnd();
			const prev = out.length ? out[out.length - 1] : undefined;
			const wrapped = prev !== undefined && prev.trim() !== "" && cur.trim() !== "" && visibleWidth(prev) >= w - 12;
			if (wrapped) out[out.length - 1] = `${prev.trimEnd()} ${cur.trimStart()}`;
			else out.push(cur);
		}
		return out;
	}

	setEditorTextGetter(fn: () => string) {
		this.editorTextFn = fn;
	}

	/**
	 * `row` is the terminal row the copy gesture happened on. Below the body
	 * is the bottom UI, where the editor lives — there is no selectable line
	 * space down there, so a right-click that lands on the input bar copies
	 * what you have typed instead of reporting "nothing selected".
	 */
	copySelectionNow(row?: number) {
		const inTail = row !== undefined && row - 2 >= this.lastBody;
		if (inTail && !(this.selAnchor && this.selHead && this.dragged)) {
			const text = (() => {
				try {
					return this.editorTextFn?.() ?? "";
				} catch {
					return "";
				}
			})();
			if (!text.trim()) {
				this.notify("Input bar is empty");
				return;
			}
			copyToClipboard(text)
				.then(() => this.notify("Copied input"))
				.catch(() => this.notify("Copy failed (no clipboard tool?)"));
			return;
		}
		this.copySelectionInner();
	}

	private copySelectionInner() {
		if (!this.selAnchor || !this.selHead || !this.dragged) {
			this.notify("Nothing selected");
			return;
		}
		let a = this.selAnchor;
		let b = this.selHead;
		if (a.idx > b.idx || (a.idx === b.idx && a.col > b.col)) [a, b] = [b, a];
		const pieces: string[] = [];
		let run: string[] = [];
		const flush = () => {
			if (run.length) {
				pieces.push(this.unwrap(this.dedent(run)).join("\n"));
				run = [];
			}
		};
		let i = a.idx;
		while (i <= b.idx) {
			const blk =
				this.surfaceIsLive && !this.station
					? this.liveBlocks.find((bl) => bl.s === i && bl.e - 1 <= b.idx && !(bl.s === a.idx && a.col > 0))
					: undefined;
			if (blk) {
				flush();
				pieces.push(blk.src.trim());
				i = blk.e;
				continue;
			}
			const raw = this.station
				? (this.stationBuilt[i] ?? "")
				: this.surfaceIsLive
					? (this.liveLines[i] ?? "")
					: (this.rawWrapped[i]?.text ?? "");
			let plain = stripAnsi(raw);
			if (i === a.idx || i === b.idx) {
				const from = i === a.idx ? a.col : 0;
				const to = i === b.idx ? b.col + 1 : 100000;
				plain = sliceByColumn(plain, from, Math.max(1, to - from), false);
			}
			run.push(plain);
			i++;
		}
		flush();
		const text = pieces.join("\n").replace(/\s+$/, "");
		const n = b.idx - a.idx + 1;
		copyToClipboard(text)
			.then(() => this.notify(n === 1 ? "Copied selection" : `Copied ${n} lines`))
			.catch(() => this.notify("Copy failed (no clipboard tool?)"));
	}

	private handleClick(idx: number, cc = 0) {
		this.lastClickScreenRow = Math.max(0, idx - this.offset);
		if (this.surfaceIsLive) {
			// A span-gated range (expand, open-run) needs the click ON its
			// text; span-less ranges (collapse) accept the whole row —
			// clicking anywhere in an open panel folds it (round 6). Ctrl
			// ranges (the wire view) never fire on a plain click.
			const range = this.liveRanges.find(
				(r) => !r.ctrl && idx >= r.start && idx < r.end && (r.a === undefined || (cc >= r.a && cc < (r.b ?? Infinity))),
			);
			range?.action();
			return;
		}
		const id = this.rawWrapped[idx]?.blockId;
		if (!id) return;
		collapseOverride.set(id, !isCollapsed(id));
		this.follow = false;
		this.refresh();
	}

	private jumpToRow(row: number) {
		const maxOffset = Math.max(0, this.lastTotal - this.lastBody);
		const frac = Math.max(0, Math.min(1, (row - 2) / Math.max(1, this.lastBody - 1)));
		this.offset = Math.round(frac * maxOffset);
		this.follow = this.offset >= maxOffset;
		this.tui.requestRender();
	}

	/* ----- keys ----- */

	toggleAll() {
		if (liveMode) {
			toolsExpandedAll = !toolsExpandedAll;
			toolGen++;
			// Clusters follow (round 29): expand-all opens every summary with
			// its members; collapse-all folds everything back. The generation
			// bump retires per-cluster overrides; clusterGen re-keys the
			// flatten (no component signature changes on this).
			clustersOpenAll = toolsExpandedAll;
			clusterAllGen++;
			clusterGen++;
			this.follow = false;
			this.liveDirty = true;
			this.tui.requestRender();
			return;
		}
		const ids = new Set<string>();
		for (const l of this.rawLines) if (l.blockId) ids.add(l.blockId);
		if (!ids.size) return;
		const anyCollapsed = [...ids].some((id) => isCollapsed(id));
		for (const id of ids) collapseOverride.set(id, !anyCollapsed);
		this.follow = false;
		this.refresh();
	}

	toggleRaw() {
		this.hoverFold = null;
		if (this.childView) {
			this.exitChildView();
			return;
		}
		liveMode = !liveMode;
		this.hoverLink = null;
		this.rawWrappedWidth = -1;
		this.liveDirty = true;
		this.selAnchor = null;
		this.selHead = null;
		this.selecting = false;
		this.dragged = false;
		this.tui.requestRender();
	}

	scrollLines(n: number) {
		const maxOffset = Math.max(0, this.lastTotal - this.lastBody);
		if (n < 0) this.follow = false;
		this.offset = Math.max(0, Math.min(maxOffset, this.offset + n));
		if (n > 0 && this.offset >= maxOffset) this.follow = true;
		this.tui.requestRender();
	}

	pageUp() {
		this.follow = false;
		this.offset = Math.max(0, this.offset - Math.max(1, this.lastBody - 1));
		this.tui.requestRender();
	}

	pageDown() {
		const maxOffset = Math.max(0, this.lastTotal - this.lastBody);
		this.offset = Math.min(maxOffset, this.offset + Math.max(1, this.lastBody - 1));
		if (this.offset >= maxOffset) this.follow = true;
		this.tui.requestRender();
	}

	toTop() {
		this.follow = false;
		this.offset = 0;
		this.tui.requestRender();
	}

	toBottom() {
		this.follow = true;
		this.tui.requestRender();
	}
}
