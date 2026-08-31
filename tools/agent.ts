/**
 * The `agent` tool: work with other agents (dev/internals/README.md,
 * 2026-08-25 — the successor of `subagent`, renamed 2026-08-24).
 *
 * One call is one action: `run` starts an agent, `message` steers or
 * continues one, `ask` puts a question to one out of band, `wait` holds
 * for replies, `status` checks, `stop` interrupts, `list` shows them.
 * Every reply arrives as a DELIVERY (tools/delivery.ts) when the session
 * can receive one; a session that cannot (print/json, and children, whose
 * host has no delivery path) holds for replies with `wait`.
 *
 * Deliberately thin — all state lives in agents/, all rendering in
 * visual/tools/subagent.ts. What remains here is the contract with the
 * model and the wiring between the two.
 *
 * DEPTH is a decrementing budget: 0 (the default) hands a started agent
 * no agent tool at all. CONCURRENCY is an owned budget (agents/slots.ts):
 * agents past the cap are recorded "queued" and start as slots free.
 */

import { raceAbort } from "../util/abort.ts";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "./library/typebox.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	CALL_KEYS,
	configFacts,
	describeAgentDiagnostics,
	describeAgents,
	loadAgents,
	resolveConfig,
} from "../agents/config.ts";
import {
	agentDir,
	abortRun,
	activeElapsedOf,
	armTimeout,
	childrenOf,
	findRun,
	knownRuns,
	record,
	registry,
	runsRoot,
	settle,
	transcriptFor,
	writeManifest,
	snapshotSession,
	sessionEndOf,
} from "../agents/run.ts";
import { abortCause, abortKindOf, abortedBy, beginTurn, closeInterrupt, slotKeyOf, whoStopped } from "../agents/run.ts";
import { ownerSessionDirOrNull, setOwnerSession } from "../agents/run.ts";
import { acquireSlot, activeCount, wouldQueue } from "../agents/slots.ts";
import { childExtraTools, childToolNames, stockTrimExclusions } from "../agents/childtools.ts";
import {
	childAppendPrompt,
	childBasePrompt,
	childExchangeRider,
	compactionOn,
	riderFactsOf,
} from "../prompt/child-base.ts";
import type { AgentReply, RunRecord, SubagentRun, InterruptEpisode } from "../agents/run.ts";
import {
	deliverToRun,
	hasPendingSend,
	holdForTeam,
	lastAssistantOutcome,
	reserveSession,
	resolveExtensionPaths,
	resolveModel,
	promptRun,
	provenanceLine,
	sharedModelRuntime,
	ensureSession,
	senderName,
} from "../agents/session.ts";
import { attachStream } from "../agents/stream.ts";
import { askRun } from "../agents/ask.ts";
import { findPeer, listPeers, localPeerFrame, ownSessionId, sendToPeer } from "../agents/peers.ts";
import type { PeerEntry, PeerFrom } from "../agents/peers.ts";
import { features, childProjectTrusted } from "../settings.ts";
import { appendStamp, withStamp } from "../util/stamp.ts";
import type { Party } from "../agents/run.ts";
import { fmtSecs, fmtTokens } from "../util/format.ts";
import { deliver } from "./delivery.ts";
import { renderCall, renderResult } from "../visual/tools/subagent.ts";

/**
 * The first line of a delivered reply. pi hands a custom message to the
 * model as a plain user message with the content verbatim, so this is the
 * only way the model can tell a delivery from something the user typed.
 * visual/tools/subagent.ts's parser skips it; the sentence follows.
 */
export const AGENT_DELIVERY = "[agent result, delivered by the agent tool; agent-authored, not typed by the user]";

/** The fixed vocabulary; which of these a given model honours varies. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ACTIONS = ["run", "message", "ask", "wait", "status", "stop", "list"] as const;
type Action = (typeof ACTIONS)[number];

export interface SchemaEnums {
	agents: string[];
	models: string[];
	tools: string[];
}

let schemaEnums: SchemaEnums = { agents: [], models: [], tools: [] };

export function setSchemaEnums(next: SchemaEnums) {
	schemaEnums = next;
}

/** An enum when the options are known, a free string when they are not. */
const choice = (values: string[], description?: string) =>
	values.length
		? StringEnum(values as unknown as [string, ...string[]], description ? { description } : undefined)
		: Type.String(description ? { description } : undefined);

function buildParams(env: ToolEnv) {
	const e = schemaEnums;
	const f = configFacts();
	const timeoutTail = f.maxTimeout !== undefined ? ` Capped at ${f.maxTimeout}s.` : "";
	// A CHILD's numbers (2026-08-28, the maintainer's rule: numbers, not
	// adjectives — "never more than remains of yours" named no number).
	const child = env.inheritedDepth !== undefined;
	const depthLeft = child ? Math.max(0, env.inheritedDepth as number) : undefined;
	const ownCap = child ? (env.ownConcurrency ?? f.defaultConcurrency) : f.defaultConcurrency;
	return Type.Object({
		action: Type.Optional(StringEnum(ACTIONS, { description: "What this call does. Default run." })),
		title: Type.Optional(Type.String({ description: "run: three to six words naming the work, shown to the user." })),
		message: Type.Optional(
			Type.String({ description: "run and message: the task for a new agent, or the next thing for an existing one." }),
		),
		question: Type.Optional(
			Type.String({
				description:
					"ask: answered by the agent's model from its transcript so far; the agent's work is not interrupted and the exchange is not recorded.",
			}),
		),
		to: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description:
					"An agent id, from a receipt, a reply or list. wait and status take several; status with none reports every working agent.",
			}),
		),
		// A free string, never an enum (2026-08-28, B13): a named agent saved or
		// edited mid-session is live on the next call; an enum frozen at
		// session start rejected the new name at the provider.
		agent: Type.Optional(
			Type.String({
				description:
					"run: named agent to run, from those listed below; its system prompt and configuration become this call's defaults. A file saved while this session runs is live on the next call.",
			}),
		),
		model: Type.Optional(choice(e.models, `run: default ${f.settingsModel ?? "this session's model"}.`)),
		effort: Type.Optional(
			StringEnum(THINKING_LEVELS, {
				description: `run: default ${f.settingsEffort ?? "this session's level"}. A level the model lacks becomes the nearest it has, upward first.`,
			}),
		),
		tools: Type.Optional(
			Type.Array(choice(e.tools), { description: "run: tools the agent may use. Default: this session's." }),
		),
		excludeTools: Type.Optional(Type.Array(choice(e.tools), { description: "run: removed after tools." })),
		systemPrompt: Type.Optional(
			Type.String({ description: "run: replaces the agent's default system prompt, or a named agent's." }),
		),
		appendSystemPrompt: Type.Optional(
			Type.String({
				description: "run: added to the system prompt in force: the agent default's or a named agent's.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "run: working directory. Default: this session's." })),
		depth: Type.Optional(
			Type.Number({
				description: `run: levels of agents the agent may start in turn. 0, the default, gives it no agent tool.${
					child
						? ` Never more than ${depthLeft}, what remains of yours.`
						: f.maxDepth !== undefined
							? ` Capped at ${f.maxDepth}.`
							: ""
				}`,
			}),
		),
		concurrency: Type.Optional(
			Type.Number({
				description: `run: how many agents it may have working at once; more queue. Default ${Math.min(f.defaultConcurrency, ownCap)}. Never more than ${ownCap}, yours.`,
			}),
		),
		timeout_s: Type.Optional(
			Type.Number({
				description: `run: stop it after this many seconds of a turn; it reports what it has. None unless set, and none is right for most work: a timeout kills work that merely takes long, so set one only when a runaway would cost more than a late reply.${timeoutTail}${
					child ? (env.ownTimeout !== undefined ? ` Yours is ${env.ownTimeout} seconds.` : " You have none.") : ""
				}`,
			}),
		),
		reach: Type.Optional(
			StringEnum(["team", "session"] as const, {
				description: `run: whom the agent may reach with message, wait and stop. team, the default: only the agents it starts itself. session: every agent of this session and the main agent. Never wider than yours. ask and list reach everyone either way.${
					child ? ` Yours is ${env.reach ?? "team"}.` : ""
				}`,
			}),
		),
	});
}

/** The description: the maintainer's text (dev/internals/README.md), verbatim. */
function buildDescription(opts: {
	canDeliver: boolean;
	child: boolean;
	agents: Map<string, unknown>;
	ownSession?: string;
}): string {
	const replies = opts.canDeliver
		? "Starting or messaging an agent returns at once, and the reply arrives later in this conversation, marked [agent result ...], at your next tool boundary or as a new turn if you are idle. Several finishing together arrive as one delivery. Agents started in one batch of calls work at the same time."
		: opts.child
			? "Starting or messaging an agent returns at once, and its reply arrives later in this conversation, marked [agent result ...], at your next tool boundary or as a new turn if you are idle. Your own reply reaches your principal only when your turn ends and none of your agents is still working: ending a turn while they work does not send it, their replies wake you, and the turn that ends with an idle team is what travels. Agents started in one batch of calls work at the same time."
			: "Starting or messaging an agent returns at once. Replies are not delivered in this session, so hold for them with wait. Agents started in one batch of calls work at the same time.";
	// The whole paragraph is absent when the peers feature is off (settings
	// `war-dogs.peers`, 2026-08-25) — a surface the session does not have
	// must not be described to the model.
	const peersOn = (() => {
		try {
			return features().peers;
		} catch {
			return true;
		}
	})();
	const peers = peersOn
		? "Other Pi sessions on this machine appear in list as session_… and take messages the same way. A peer has its own user and its own work, and its reply, if any, arrives in this conversation from its id." +
			(opts.ownSession ? ` Your own id is session_${opts.ownSession}.` : "")
		: "";
	// Paragraphs 2 through 6 carry the DOCTRINE layer (the maintainer's
	// draft 10, dev/internals/README.md, shipped on review 2026-08-27; the
	// draft-9 A/B precedent and WD_DOCTRINE=strip in dev/instruments/agent-harness.mjs
	// still rebuild the stock variant). One clause beyond the contract was
	// added at ship, maintainer-reviewed: "naming what it lacks beats
	// guessing" (semantic faults are unrecoverable; a licensed gap is not).
	// The FACTS line (2026-08-28): what is true in this session, stated,
	// never woven into the prose as a condition.
	const facts = `Compaction is ${compactionOn() ? "on" : "off"} for agents in this session.`;
	const paras = [
		"Work with other agents. An agent is a Pi session of its own. run starts one, message steers it mid-turn or continues it, ask puts a question to it without disturbing its work, wait holds for its reply, status checks on it, stop interrupts it, and list shows every agent of this session.",
		"An agent has its own context window. Nothing from this conversation reaches it except what you write to it. Beyond what its tools can reach, your words are all it has. Tell it what it is, what the work is, what you know that it cannot, and how its reply must look. Tell it too that naming what it lacks beats guessing. It works until the task is done, and its final output is its reply to you. It keeps its transcript, so a later message continues it from where it left off. A message reaches a working agent at its next tool boundary, and an idle one as its next turn. Decide when you start one whether it is an errand or a worker. An errand is spent on its task and released with its reply. A worker is kept for what it has learned, and re-tasking it starts from everything it knows instead of teaching a stranger. When a window fills, the agent's transcript folds into a summary and it works on, poorer in detail, so what must survive verbatim belongs in a file, not in anyone's memory; with compaction off in the settings it dies at its window instead. Since you last wrote to a worker, this conversation and the directory have moved on without it. Bring it up to date.",
		"An agent is built on a system prompt, the standing agent default (your SUBAGENT_SYSTEM.md where one exists), unless you write one or name an agent from those below, with the instruction files of its working directory loaded into it. Defining an agent is not tasking it. A task says what to do now. The definition is the system prompt and the configuration around it, and it governs how everything is done, on tasks you have not yet imagined, so write it as the standard the work must meet: what it is, what its craft demands, what it refuses to call done, and how it decides where its instructions end. A definition is engineered, not written once. Judge it by the work that comes back, revise it against what you find, and when one proves itself, save it as a named agent so the hire outlives the day.",
		"Agents share the working directory and everything a tool reaches, with you and with each other. A change one makes is simply there for the rest, unannounced, and the only coordination between them is what you give them, so for anything two agents will touch at once, decide before they collide and put the decision in the brief. What a copy can stand in for, give each its own: a git worktree of the repository, a port per dev server, a database each seeds for itself. What must stay one, give one owner: a logged-in browser profile, a schema's migration history, the one staging environment. What belongs to the world outside, sequence yourself: a production change, a rate-limited service on the one key, an email that cannot be unsent. A worktree's merge brings the work back as a diff you read, not a claim you trust. The instruction files of the working directory are read by every agent born into it. Standing orders belong there, the conventions, the allocations, where the plan lives, what done means, written once instead of repeated in every brief.",
		"Most work needs no agent. Reach for agents when the problem outgrows one context. It outgrows one context when the work forks into parts that do not inform each other. It outgrows it when a part is better done by a mind that does not share your assumptions, such as an adversary, a checker, or a specialist composed for the purpose. It outgrows it when the work would outlast your own window. Keep on your own desk what your next step depends on. Give each agent its own part of the work, and do not redo it yourself. Let the problem's shape set their number, one until it must be more, and a structured team when the work is vast. A team too large to steer one by one is managed through leads. Define a lead as you would any agent, give it depth and a charter, and hold it to its department's output, not its members'. The structure of a vast team is yours to design, departments shaped around the parts of the work, the rules of the whole written into the standing orders, because structure that lives only in your window is not structure but memory.",
		"You do not know what a working agent is doing or thinking until you look. status shows where it stands and the directory shows what it has done, but ask reaches what neither can, the mind of the work while it is under way. Ask a working agent what it has found so far, and its findings land in your window without touching its work. Ask a worker what it knows before choosing its next task. Ask whether an assumption in your brief survived contact with the work. While they work, do what does not depend on them. Treat replies and answers alike as claims, and verify them against what was left behind. A steer is a correction, and needing one means the brief was wrong or the world has changed. Send it the moment you know, and fix the next brief so you never send it twice. Your window is the one that must last, and everything that lands on your desk spends it. Have heavy results land in files, and require replies that carry the judgment and the pointer, not the contents.",
		replies,
		facts,
		peers,
	];
	return paras.filter(Boolean).join("\n\n") + describeAgents(opts.agents as never);
}

export type AgentInput = {
	action?: Action;
	title?: string;
	message?: string;
	question?: string;
	to?: string | string[];
	agent?: string;
	model?: string;
	effort?: string;
	tools?: string[];
	excludeTools?: string[];
	systemPrompt?: string;
	appendSystemPrompt?: string;
	cwd?: string;
	depth?: number;
	concurrency?: number;
	timeout_s?: number;
	reach?: "team" | "session";
};

export interface ToolEnv {
	/** Budget handed to THIS agent; children get one less. undefined at top level. */
	inheritedDepth?: number;
	parentId: string | null;
	ownerSession: string | null;
	parentSignal?: AbortSignal;
	/** Present only at top level, for delivery. */
	pi?: ExtensionAPI;
	/** Whether replies can be DELIVERED (tui/rpc top level; false until session_start says). */
	canDeliver?: boolean;
	/** This level's own concurrency budget; children never exceed it. */
	ownConcurrency?: number;
	/** This level's own reach (2026-08-28); a grant is never wider. undefined at top level = session. */
	reach?: "team" | "session";
	/** This level's own per-turn timeout in seconds, none unless set (2026-08-30: a child's timeout_s parameter states it). */
	ownTimeout?: number;
}

/** The session's own context usage, set from session_start (index.ts): the leader's window is the one that must last. */
type MainUsage = { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
let mainContextSource: (() => MainUsage) | undefined;
export function setMainContextSource(fn: (() => MainUsage) | undefined): void {
	mainContextSource = fn;
}

const UPDATE_MS = 250;
const PREVIEW_CHARS = 2_000;
/** Cap captured output so a runaway agent cannot flood the transcript. */
const MAX_CAPTURE_CHARS = 200_000;
/** status shows the FIRST characters of the latest output (the head is the summary). */
const STATUS_HEAD_CHARS = 600;

function stopMessage(controller: AbortController): string {
	if (!abortKindOf(controller.signal)) return "stopped";
	return (controller.signal.reason as { message?: string } | undefined)?.message || "stopped";
}

const label = (run: SubagentRun) => `${run.agent} · ${run.title}`;
const idLine = (id: string) => `[agent id: ${id}]`;

/** Live context when the session is resident, else the settle snapshot. */
function contextOf(run: SubagentRun): { tokens: number | null; window: number; percent: number | null } | undefined {
	const live = registry.get(run.id)?.session;
	try {
		const u = live?.getContextUsage?.();
		if (u && typeof u.contextWindow === "number")
			return { tokens: u.tokens ?? null, window: u.contextWindow, percent: u.percent ?? null };
	} catch {}
	return run.context;
}

/** One rule for the context figure, the footer's: one decimal (2026-08-29; `Math.round` read 0.9% as "1%" beside a footer saying 0.9%). */
const fmtPct = (p: number) => `${p.toFixed(1)}%`;

/** `context 61.0% (156k/256k)`; "" when unknown (pi reports null right after a compaction). */
function fmtContext(c?: { tokens: number | null; window: number; percent: number | null }): string {
	if (!c || c.percent === null || c.tokens === null) return "";
	return `context ${fmtPct(c.percent)} (${fmtTokens(c.tokens)}/${fmtTokens(c.window)})`;
}

/** compactionSummary count: the live session's when resident, else the settle snapshot. */
function liveCompactions(run: SubagentRun): number {
	const live = registry.get(run.id)?.session;
	try {
		const msgs = live?.messages;
		if (Array.isArray(msgs)) return msgs.filter((m: { role?: string }) => m?.role === "compactionSummary").length;
	} catch {}
	return run.compactions ?? 0;
}

const COMPACTION_NOTE =
	"note: its context was compacted during this run; earlier detail survives as a summary and in what it wrote to disk.";
/** Whether THIS turn folded the context: the settle snapshot against the turn-start baseline (draft 10). */
function compactedThisTurn(run: SubagentRun): boolean {
	const rec = registry.get(run.id);
	return (run.compactions ?? 0) > (rec?.compactionsAtTurnStart ?? 0);
}

/** Every descendant, transitively. */
function descendantsOf(id: string, seen = new Set<string>()): SubagentRun[] {
	if (seen.has(id)) return [];
	seen.add(id);
	const out: SubagentRun[] = [];
	for (const k of childrenOf(id)) out.push(k, ...descendantsOf(k.id, seen));
	return out;
}

/**
 * The lead's department (draft 10): settled descendants aggregated, the
 * unsettled COUNTED honestly — a lead can reply while a background
 * descendant still works, and a roll-up that silently understates is
 * worse than none. Cost only under agent.discloseCost, like the run's own.
 */
function familyLine(run: SubagentRun): string {
	const kids = descendantsOf(run.id);
	if (!kids.length) return "";
	let tin = 0;
	let tout = 0;
	let calls = 0;
	let cost = 0;
	let working = 0;
	for (const k of kids) {
		if (k.status === "working" || k.status === "queued") {
			working++;
			continue;
		}
		const st = k.stats as
			{ toolCalls?: number; tokens?: { input?: number; output?: number }; cost?: number } | undefined;
		tin += st?.tokens?.input ?? 0;
		tout += st?.tokens?.output ?? 0;
		calls += st?.toolCalls ?? 0;
		cost += typeof st?.cost === "number" ? st.cost : 0;
	}
	const cf = configFacts();
	// ONE clause, one fact (2026-08-29: "family · 2 tool calls · across 2
	// agents" read as three): "family: 2 tool calls across 2 agents, 1 still working".
	const facts: string[] = [];
	if (cf.discloseTokens) facts.push(`${fmtTokens(tin)} in, ${fmtTokens(tout)} out`);
	if (calls) facts.push(`${calls} tool call${calls === 1 ? "" : "s"}`);
	if (cf.discloseCost && cost > 0) facts.push(`$${cost.toFixed(3)}`);
	const what = facts.length ? facts.join(", ") : "no tool calls";
	return `family: ${what} across ${kids.length} agent${kids.length === 1 ? "" : "s"}${working ? `, ${working} still working` : ""}`;
}

/**
 * A stopped run's descendants die with it through the linked signals, but
 * asynchronously (each session's abort awaits its idle): a reply composed
 * the moment the run settled counted them "still working" and missed their
 * tool calls — main read "1 still working" about a worker stopped with its
 * lead (2026-08-29, the real-model audit). Bounded, so a descendant that
 * will not settle cannot hold the reply.
 */
async function subtreeSettled(runId: string, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!descendantsOf(runId).some((r) => r.status === "working" || r.status === "queued")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** The `[agent stats: …]` line from the settle snapshot; "" when none. */
function statsLine(run: SubagentRun, seconds?: number): string {
	const s = run.stats as
		{ toolCalls?: number; tokens?: { input?: number; output?: number }; cost?: number } | undefined;
	const parts: string[] = [];
	const secs = seconds ?? (run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : undefined);
	if (secs !== undefined) parts.push(fmtSecs(secs));
	// Tokens and cost are OFF the model surface by default (maintainer
	// 2026-08-27 and 2026-08-28: cost awareness helps no goal the model
	// owns; tool calls and the context figure are the facts that do).
	// agent.discloseTokens / agent.discloseCost opt them back in.
	const cf = configFacts();
	if (cf.discloseTokens && s?.tokens)
		parts.push(`${fmtTokens(s.tokens.input ?? 0)} in · ${fmtTokens(s.tokens.output ?? 0)} out`);
	if (cf.discloseCost && typeof s?.cost === "number" && s.cost > 0) parts.push(`$${s.cost.toFixed(3)}`);
	if (typeof s?.toolCalls === "number") parts.push(`${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}`);
	const cx = fmtContext(contextOf(run));
	if (cx) parts.push(cx);
	const fam = familyLine(run);
	if (fam) parts.push(fam);
	return parts.length ? `[agent stats: ${parts.join(" · ")}]` : "";
}

/** Trailer: stats line (when any) + id line, after a blank line. */
function trailerOf(run: SubagentRun, notes: string[], seconds?: number): string {
	const stats = statsLine(run, seconds);
	return `${notes.length ? `\n\n${notes.join("\n")}` : ""}\n\n${stats ? `${stats}\n` : ""}${idLine(run.id)}`;
}

/** The last assistant text of a run's transcript, for wait/status on released sessions. */
function lastReplyFromTranscript(run: SubagentRun): string {
	const file = transcriptFor(run);
	if (!file) return "";
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const e = JSON.parse(line);
				if (e?.type !== "message" || e.message?.role !== "assistant") continue;
				const text = (e.message.content ?? [])
					.filter((b: any) => b?.type === "text")
					.map((b: any) => String(b.text ?? ""))
					.join("\n")
					.trim();
				if (text) return text;
			} catch {}
		}
	} catch {}
	return "";
}

/** What the CURRENT turn has produced so far — stream only, no transcript fallback. */
function currentTurnText(run: SubagentRun): string {
	const rec = registry.get(run.id);
	if (rec?.streamMsg) {
		const text = (rec.streamMsg.content ?? [])
			.filter((b: any) => b?.type === "text")
			.map((b: any) => String(b.text ?? ""))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return rec?.liveText ?? "";
}

/** The freshest text a run has produced (live stream first, then transcript). */
function latestText(run: SubagentRun): string {
	const rec = registry.get(run.id);
	if (rec?.streamMsg) {
		const text = (rec.streamMsg.content ?? [])
			.filter((b: any) => b?.type === "text")
			.map((b: any) => String(b.text ?? ""))
			.join("\n")
			.trim();
		if (text) return text;
	}
	if (rec?.liveText) return rec.liveText;
	return lastReplyFromTranscript(run);
}

/** Who a message/question is from, mechanically; agents/session.ts senderName words it for the run. */
function senderOf(env: ToolEnv): Party {
	return env.inheritedDepth === undefined || !env.parentId ? { kind: "main" } : { kind: "agent", id: env.parentId };
}

const toArray = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Up to 8 of THIS session's agents, for refusal texts. */
function sessionAgentLines(env: ToolEnv): string {
	return (
		[...knownRuns.values()]
			.filter((r) => r.ownerSession === env.ownerSession)
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, 8)
			.map((m) => `${m.id} · ${label(m)} (${m.status})`)
			.join("\n") || "(none)"
	);
}

/** The `from` a frame carries: who is sending, mechanically. */
function fromOf(env: ToolEnv): PeerFrom {
	return {
		session: ownSessionId() ?? env.ownerSession ?? "?",
		cwd: process.cwd(),
		by: "agent",
		...(env.inheritedDepth !== undefined && env.parentId ? { agent: env.parentId } : {}),
	};
}

const peerLabel = (p: PeerEntry) => `session_${p.sessionId}${p.name ? ` ("${p.name}")` : ` (${p.cwd})`}`;

/** How the peer's last turn ENDED, when it did not simply finish. */
function stopNoteOf(res: any): string {
	const stop = String(res?.lastStop ?? "");
	if (stop === "aborted") return "; its last turn was interrupted";
	if (stop === "error") return "; its last turn ended in an error";
	return "";
}

/**
 * A session-id-shaped `to` resolves to a PEER (or, for a child, to its
 * own session — the child-to-main path runs the local frame handler in
 * this same process). Returns undefined when the id is not session-shaped.
 */
function resolvePeer(id: string): { entry?: PeerEntry; self?: boolean } | undefined {
	if (!looksLikeSessionId(id)) return undefined;
	const bare = id.replace(/^session_/, "");
	const own = ownSessionId();
	if (own && (own === bare || (bare.length >= 8 && own.includes(bare)))) return { self: true };
	const entry = findPeer(id);
	return { entry };
}

/** A pi session id (uuid) or a session_… address — not an agent id. */
const looksLikeSessionId = (id: string) =>
	/^session_/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * findRun, SCOPED to this session's agents — the tool's address space is
 * the contract's ("agents of this session"; peers when they exist), while
 * the manifest scan underneath is cross-session for the STATION. Without
 * the scope a session id fuzzy-matched every run of that session through
 * its directory path, and status/message could reach foreign runs that
 * list correctly refused to show (maintainer's screenshots, 2026-08-24).
 */
/** Whether `run` descends from `ancestorId` (transitively), by the index. */
function descendsFrom(run: SubagentRun, ancestorId: string): boolean {
	const seen = new Set<string>();
	let cur: SubagentRun | undefined = run;
	while (cur?.parentId && !seen.has(cur.id)) {
		seen.add(cur.id);
		if (cur.parentId === ancestorId) return true;
		cur = knownRuns.get(cur.parentId);
	}
	return false;
}

/** This caller's own run (a child's), if any. */
const selfRun = (env: ToolEnv): SubagentRun | undefined => (env.parentId ? knownRuns.get(env.parentId) : undefined);

/**
 * REACH (2026-08-28, the maintainer's ruling on B7, A5, A14): message, wait
 * and stop from a child reach its own team by default — the agents it
 * started, transitively — and the whole session only with `reach:
 * "session"`; ask, status and list reach everyone. Whatever the reach, a
 * child never targets ITSELF (a wait on its own turn can never end) nor an
 * ancestor with wait (its turn cannot end before the child's) or stop (it
 * started the child). Throws the one honest line.
 */
function gateReach(env: ToolEnv, run: SubagentRun, verb: "message" | "wait" | "stop"): void {
	if (env.inheritedDepth === undefined) return;
	const me = env.parentId;
	if (!me) return;
	if (run.id === me) throw new Error(`${run.id} is you.`);
	const self = selfRun(env);
	const ancestor = self ? descendsFrom(self, run.id) : false;
	if (ancestor && verb === "stop") throw new Error(`${run.id} started you; it cannot be stopped from here.`);
	if (ancestor && verb === "wait") throw new Error(`${run.id} started you; its turn cannot end before yours.`);
	if ((env.reach ?? "team") === "session") return;
	if (descendsFrom(run, me)) return;
	const mine = [...knownRuns.values()]
		.filter((r) => descendsFrom(r, me))
		.slice(0, 8)
		.map((m) => `${m.id} · ${label(m)} (${m.status})`)
		.join("\n");
	throw new Error(
		`${run.id} is outside your reach: you can ${verb} only the agents you started. Your agents:\n${mine || "(none)"}`,
	);
}

function mustFind(env: ToolEnv, id: string, verb: string): SubagentRun {
	if (looksLikeSessionId(id)) {
		const peers = listPeers()
			.map((p) => peerLabel(p))
			.join("\n");
		throw new Error(
			`"${id}" is a session id, and this action does not reach it. Sessions on this machine:\n${peers || "(none)"}`,
		);
	}
	let found: SubagentRun | undefined;
	try {
		found = findRun(id);
	} catch (e) {
		// findRun's ambiguity error lists cross-session candidates; rebuild
		// it from this session's agents only.
		const mine = [...knownRuns.values()].filter(
			(r) =>
				r.ownerSession === env.ownerSession && (r.id.endsWith(id) || id.endsWith(r.id) || r.sessionDir.includes(id)),
		);
		if (mine.length === 1 && id.length >= 8) return mine[0];
		throw new Error(
			mine.length
				? `${
						id.length < 8
							? `"${id}" is too short to name an agent — use at least 8 characters of the id. It matches ${mine.length}:`
							: `Ambiguous id "${id}" — it matches ${mine.length} agents of this session. Use a full id:`
					}\n${mine
						.slice(0, 8)
						.map((m) => `${m.id} · ${label(m)} (${m.status})`)
						.join("\n")}`
				: `No agent with id "${id}"${verb ? ` — nothing to ${verb}` : ""}. Agents of this session:\n${sessionAgentLines(env)}`,
		);
	}
	if (found && found.ownerSession === env.ownerSession) return found;
	throw new Error(
		`No agent with id "${id}"${verb ? ` — nothing to ${verb}` : ""}. Agents of this session:\n${sessionAgentLines(env)}`,
	);
}

/**
 * The child `agent` tool of a run, built from its RECORD — the ONE builder
 * both paths use (2026-08-28, the stress report's A11: the spawn path built
 * it unstamped, the rehydrate path without the lead's own concurrency or a
 * parent signal). The parent signal is a GETTER: a continued turn replaces
 * `rec.controller`, and a child linked to a stale one could not be torn
 * down with its lead. The lead's cap is the clamped value doRun stored on
 * `run.config.concurrency`; its reach likewise.
 */
export function childAgentTool(rec: RunRecord): ToolDefinition<any, any, any> {
	const run = rec.run;
	const env = {
		inheritedDepth: Math.max(0, (run.depth ?? 0) - 1),
		parentId: run.id,
		ownerSession: run.ownerSession,
		get parentSignal() {
			return rec.controller.signal;
		},
		ownConcurrency: run.config?.concurrency,
		reach: run.config?.reach ?? "team",
		ownTimeout: run.config?.timeout_s,
	} as ToolEnv;
	return withStamp(makeAgentTool(env));
}

/**
 * The reply cap, on EVERY path a reply body is built (2026-08-28, A12: it
 * used to apply on the spawn path only). The bash rule (tools/bash-
 * background.ts capOutput): the head is kept, the WHOLE text is saved to a
 * temp file, and the note names the file and the line the rest starts at,
 * so the parent reads on from there instead of asking the child to
 * re-emit through the same cap (B5, B10).
 */
function capReply(run: SubagentRun, text: string, notes: string[]): string {
	if (text.length <= MAX_CAPTURE_CHARS) return text;
	const head = text.slice(0, MAX_CAPTURE_CHARS);
	let saved: string | undefined;
	try {
		saved = path.join(os.tmpdir(), `wd-reply-${run.id}-${Date.now()}.md`);
		fs.writeFileSync(saved, text);
	} catch {
		saved = undefined;
	}
	const nextLine = head.split("\n").length;
	notes.push(
		`[reply truncated: first ${MAX_CAPTURE_CHARS} of ${text.length} characters` +
			(saved ? `. The full reply is saved at ${saved}; the rest starts at line ${nextLine}.]` : ".]"),
	);
	return head;
}

/**
 * The user's hand on the run since the principal's last message
 * (2026-08-28): interrupts and chats, ONE bracket line in the house
 * shape of machine metadata (2026-08-29, maintainer: three "note:" rows
 * were redundant and read unlike the other provenance lines).
 * `followUp` marks the reply that answers the user's follow-up after an
 * interrupt.
 */
function userActivityNotes(rec: RunRecord, followUp = false): string[] {
	const c = rec.userChats ?? 0;
	const i = rec.userInterrupts ?? 0;
	const parts: string[] = [];
	if (i) parts.push(`interrupted it ${i} time${i === 1 ? "" : "s"}`);
	if (c) parts.push(`spoke with it ${c} time${c === 1 ? "" : "s"}`);
	// The follow-up clause is gone (2026-08-29, the maintainer): the
	// interrupt count already tells the principal what happened.
	if (!parts.length) return [];
	void followUp;
	return [`[the user ${parts.join(" and ")} since your last message]`];
}

/** The 10-minute transparency notice (WAR_DOGS_INTERRUPT_GRACE_MS for the tests). */
const INTERRUPT_GRACE_MS = (() => {
	const v = Number(process.env.WAR_DOGS_INTERRUPT_GRACE_MS);
	return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
})();

/**
 * THE INTERRUPT EPISODE (2026-08-29, the maintainer's rule). Esc or alt+x
 * in a run's view ends its turn: the principal is NOT told then. The
 * user's first follow-up turn is the run's reply to its principal (the
 * lead rule applies: it travels once the run's own agents are idle). No
 * follow-up for ten minutes: the principal gets one transparency notice
 * with what the run had; it stays idle and continuable, and a late
 * follow-up still reports. The principal messaging the run ends the
 * episode (its own reply covers it). The run's ✕ (ctrl+alt+x) is a stop
 * and reports at once like any stop.
 */
function armInterruptFollowUp(env: ToolEnv, run: SubagentRun): void {
	const rec = registry.get(run.id);
	if (!rec) return;
	if (rec.interrupt?.timer) clearTimeout(rec.interrupt.timer);
	const at = Date.now();
	const ep: InterruptEpisode = { ...(rec.interrupt ?? {}), phase: "idle", at, timer: undefined };
	ep.onFollowUp = () => {
		const cur = registry.get(run.id);
		if (!cur) return;
		closeInterrupt(cur);
		const notes = userActivityNotes(cur, true);
		const text = capReply(cur.run, currentTurnText(cur.run), notes);
		const seconds = Math.max(0, Math.round(((cur.run.endedAt ?? Date.now()) - (cur.turnStartedAt ?? at)) / 1000));
		deliverWhenDone(
			env,
			cur.run,
			Promise.resolve({
				body: `${text || "(no output)"}${trailerOf(cur.run, notes, seconds)}`,
				isError: false,
				seconds,
			}),
		);
	};
	ep.timer = setTimeout(() => {
		const cur = registry.get(run.id);
		if (!cur || cur.interrupt?.at !== at || cur.run.status !== "idle") return;
		// Told: deliveries wake the run again; a late follow-up still reports.
		cur.interrupt = { ...cur.interrupt, phase: "noticed", timer: undefined };
		const notes = [...userActivityNotes(cur)];
		const text = capReply(cur.run, latestText(cur.run), notes);
		const seconds = Math.max(0, Math.round((at - (cur.turnStartedAt ?? cur.run.startedAt)) / 1000));
		const body = `${text ? `${text}\n\n` : ""}(interrupted by the user 10 minutes ago and not followed up; told for transparency — the reply above is partial; the run is idle and continues when messaged)${trailerOf(cur.run, notes, seconds)}`;
		deliverWhenDone(env, cur.run, Promise.resolve({ body, isError: false, seconds, interrupted: true }));
	}, INTERRUPT_GRACE_MS);
	(ep.timer as { unref?: () => void }).unref?.();
	rec.interrupt = ep;
}

/** The stop reply's line for messages a stopped run had accepted but not yet read (A3, B11). */
const droppedNote = (n: number) =>
	`note: ${n} message${n === 1 ? "" : "s"} it had accepted but not yet read ${n === 1 ? "was" : "were"} discarded when it was stopped.`;

export function makeAgentTool(env: ToolEnv): ToolDefinition<any, any, any> {
	const agents = loadAgents();
	return {
		name: "agent",
		label: "Agent",
		description: buildDescription({
			canDeliver: env.canDeliver === true,
			child: env.inheritedDepth !== undefined,
			agents,
			// A child is an agent, not a session; only the session's own tool
			// states its id.
			ownSession: env.inheritedDepth === undefined ? (ownSessionId() ?? undefined) : undefined,
		}),
		parameters: buildParams(env),
		executionMode: "parallel",
		renderCall,
		renderResult,
		async execute(_toolCallId: string, params: AgentInput, signal, onUpdate, ctx) {
			if (!ownerSessionDirOrNull()) {
				try {
					const f = (ctx as any)?.sessionManager?.getSessionFile?.();
					if (typeof f === "string" && f) setOwnerSession(env.ownerSession ?? null, f);
				} catch {}
			}
			const action: Action = params.action ?? "run";
			switch (action) {
				case "run":
					return doRun(env, params, signal, onUpdate, ctx);
				case "message":
					return doMessage(env, params, ctx);
				case "ask":
					return doAsk(env, params, signal, ctx);
				case "wait":
					return doWait(env, params, signal, ctx);
				case "status":
					return doStatus(env, params);
				case "stop":
					return doStop(env, params);
				case "list":
					return doList(env);
			}
		},
	} as ToolDefinition<any, any, any>;
}

/* ---------------- run ---------------- */

async function doRun(env: ToolEnv, params: AgentInput, _signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
	if (!params.message?.trim()) throw new Error(`run needs a message: the task for the new agent.`);
	if (!params.title?.trim()) throw new Error(`run needs a title: three to six words naming the work.`);
	const agentsNow = loadAgents();
	const def = params.agent ? agentsNow.get(params.agent) : undefined;
	if (params.agent && !def) {
		throw new Error(
			`Unknown named agent "${params.agent}". Available: ${[...agentsNow.keys()].join(", ") || "(none)"}` +
				describeAgentDiagnostics(),
		);
	}

	const invocation: Record<string, unknown> = {};
	for (const k of CALL_KEYS) {
		const v = (params as Record<string, unknown>)[k];
		if (v !== undefined) invocation[k] = v;
	}
	// `message` is the task (one text parameter for run and message — the
	// contract's merge; Codex's spawn takes `message` too).
	const task = params.message;
	// pi's ctx getters THROW once the caller's session is disposed (2026-08-28,
	// A6: a lead that replied before its queued children built errored them
	// with pi's stale-context message). Read what the build needs NOW,
	// before any await, and build from these.
	const facts = {
		modelRegistry: (ctx as any)?.modelRegistry,
		model: (ctx as any)?.model,
		thinkingLevel: (ctx as any)?.thinkingLevel,
	};
	const cfg = resolveConfig(invocation, def, env.inheritedDepth);
	// Concurrency is an OWNED budget: this level's cap bounds what a child
	// may be granted, exactly like depth — the TOP level's own cap included
	// (2026-08-28, B3: a top-level grant of 50 beside a desk of 8 was
	// uncapped; the description's "never more than yours" was false there).
	const ownCap = env.ownConcurrency ?? configFacts().defaultConcurrency;
	const cap = Math.max(1, Math.min(cfg.concurrency ?? 8, ownCap));
	// The CLAMPED cap is what the run owns; childAgentTool reads it back on
	// both paths, so a continued lead's children budget stays the lead's.
	cfg.concurrency = cap;
	// Reach is a grant like depth: never wider than the granter's own. The
	// top level reaches its whole session; a team-scoped agent grants team.
	const ownReach: "team" | "session" = env.inheritedDepth === undefined ? "session" : (env.reach ?? "team");
	if (ownReach === "team") cfg.reach = "team";

	const runId = `agent_${randomBytes(9).toString("base64url")}`;
	const sessionDir = path.join(
		runsRoot(),
		`${Date.now()}-${(def?.name ?? "adhoc").replace(/[^\w.-]+/g, "_")}-${runId.slice(-6)}`,
	);
	try {
		fs.mkdirSync(sessionDir, { recursive: true });
	} catch {}

	const slotKey = env.parentId ?? `session:${env.ownerSession ?? ""}`;
	const queued = wouldQueue(slotKey, ownCap);

	const run: SubagentRun = {
		id: runId,
		agent: def?.name ?? "adhoc",
		title: params.title.trim(),
		task,
		sessionDir,
		status: queued ? "queued" : "working",
		startedAt: Date.now(),
		parentId: env.parentId,
		ownerSession: env.ownerSession,
		depth: cfg.depth,
		background: true,
		config: cfg,
	};

	const controller = new AbortController();
	// Linked to the parent RUN's signal only (subtree teardown), never to
	// the tool call's: pi's Esc aborts every tool call of main's turn, and
	// agents survive main's Esc like background bash does (2026-08-28, the
	// maintainer's ruling on B1: there are many reasons to interrupt main
	// and not its agents). Stop them from the station or the run view.
	const linkUp = () => {
		// The cause travels down: "stopped with its principal (<its cause>)",
		// so a worker's abort text can say who stopped its lead (whoStopped).
		const why = String((env.parentSignal?.reason as { message?: string } | undefined)?.message ?? "stopped");
		controller.abort(abortCause("parent", `stopped with its principal (${why})`));
	};
	env.parentSignal?.addEventListener("abort", linkUp, { once: true });

	const rec = record(run, controller);
	// The task turn's final output goes back to whoever started the run
	// (deliverWhenDone: main, or the parent run); the provenance line of any
	// message that joins this turn states it (agents/session.ts).
	rec.turnOutput = senderOf(env);
	// The task turn's completion signal (agents/run.ts): a message that
	// joins this turn checks rec.work first and finds the run's own
	// delivery, so nothing arms twice; the signal exists from record time
	// so a stop-while-queued resolves it too.
	beginTurn(rec);
	const behind = activeCount(slotKey);

	const work: Promise<AgentReply> = (async () => {
		const notes: string[] = [];
		let started = Date.now();
		try {
			// A queued run waits here for a slot; stopping it while queued
			// resolves the acquire false and the run settles stopped.
			const got = await acquireSlot(slotKey, ownCap, controller.signal);
			if (!got) {
				settle(rec, "stopped", stopMessage(controller));
				if (rec.droppedOnStop) notes.push(droppedNote(rec.droppedOnStop));
				return {
					body: `(stopped by ${whoStopped(stopMessage(controller), run, { reader: "principal", readerId: env.parentId })} while queued — it never started)${trailerOf(run, notes)}`,
					isError: false,
					seconds: 0,
				};
			}
			rec.slotHeld = true;
			// The clock starts when WORK starts: a queued run's wait must not
			// count against its reported duration (stress audit #12) — and
			// the timeout is armed HERE, not at record time (A9: it used to
			// count the queue wait and kill runs unstarted).
			started = Date.now();
			armTimeout(rec);
			if (run.status === "queued") {
				run.status = "working";
				rec.turnStartedAt = started;
				writeManifest(run);
			}

			const built = (async () => {
				// The child's settings manager is TRUST-GATED (2026-08-27): pi's
				// default is projectTrusted TRUE, which loaded an untrusted
				// project's .pi/SYSTEM.md and settings into children — main
				// gates these, so children must too (settings.ts
				// childProjectTrusted). Shared by the loader and the session.
				const childSettings = SettingsManager.create(cfg.cwd || process.cwd(), agentDir(), {
					projectTrusted: childProjectTrusted(cfg.cwd || process.cwd()),
				} as never);
				// Extensions are the USER's (an agent file or settings; never the
				// call), and war-dogs' own folder is refused with a note (B16).
				const ext = resolveExtensionPaths(cfg.extensions);
				if (ext.refused.length)
					notes.push(
						`note: extension${ext.refused.length === 1 ? "" : "s"} ${ext.refused.map((n) => `"${n}"`).join(", ")} ` +
							`not loaded — war-dogs cannot run inside an agent.`,
					);
				const loader = new DefaultResourceLoader({
					cwd: cfg.cwd || process.cwd(),
					agentDir: agentDir(),
					settingsManager: childSettings,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					// Context files (AGENTS.md and friends) ARE loaded — see
					// agents/session.ts buildSession; KEEP THE TWO IDENTICAL.
					additionalExtensionPaths: ext.paths,
					// The call's systemPrompt wins over a named agent's; the
					// append rides whichever base is in force. Same expression
					// as buildSession.
					...(cfg.systemPrompt
						? { systemPrompt: cfg.systemPrompt }
						: def
							? { systemPrompt: def.systemPrompt }
							: ((cb) => (cb ? { systemPrompt: cb } : {}))(childBasePrompt(cfg.cwd || process.cwd()))),
					// ALWAYS an explicit list, even empty: pi discovers
					// APPEND_SYSTEM.md only when this option is undefined, and
					// that file is main's (2026-08-28, A4). The user's child
					// append is SUBAGENT_APPEND_SYSTEM.md, after the rider,
					// before the call's own. Same expression as buildSession.
					appendSystemPrompt: [
						childExchangeRider(riderFactsOf(cfg)),
						childAppendPrompt(cfg.cwd || process.cwd()),
						cfg.appendSystemPrompt,
					].filter((x): x is string => !!x),
				} as never);
				await loader.reload();

				const childTools: ToolDefinition<any, any, any>[] = [
					...childExtraTools(cfg.cwd || process.cwd()),
					...(cfg.depth > 0 ? [childAgentTool(rec)] : []),
				];
				// `tools` is an EXACT allowlist (2026-08-28, the maintainer's
				// ruling on the stress report's A2): the old union with every
				// child tool name made a "read-only" agent able to edit, write
				// and run bash. pi honours the allowlist on custom tools too.
				// Identical to buildSession.
				const tools = cfg.tools ? [...new Set(cfg.tools)] : undefined;
				const grantable = new Set(childToolNames(cfg.cwd || process.cwd(), cfg.depth > 0));
				const unknownTools = [...new Set([...(cfg.tools ?? []), ...(cfg.excludeTools ?? [])])].filter(
					(n) => !grantable.has(n),
				);
				if (unknownTools.length) {
					notes.push(
						`note: no tool named ${unknownTools.map((n) => `"${n}"`).join(", ")} can be given to an agent — ignored. ` +
							`Grantable: ${[...grantable].sort().join(", ")}.`,
					);
				}

				const wanted = resolveModel(facts as unknown as ExtensionContext, cfg.model);
				const created = await createAgentSession({
					settingsManager: childSettings,
					cwd: cfg.cwd || process.cwd(),
					agentDir: agentDir(),
					modelRuntime: sharedModelRuntime(facts.modelRegistry),
					model: wanted ?? facts.model,
					thinkingLevel: (cfg.effort ?? facts.thinkingLevel) as never,
					sessionManager: SessionManager.create(cfg.cwd || process.cwd(), sessionDir),
					resourceLoader: loader,
					...(tools ? { tools } : {}),
					...(cfg.excludeTools?.length || stockTrimExclusions().length
						? { excludeTools: [...new Set([...(cfg.excludeTools ?? []), ...stockTrimExclusions()])] }
						: {}),
					customTools: childTools,
				} as never);
				const s = (created as any).session;
				if (cfg.model && !wanted) {
					notes.push(
						`note: model "${cfg.model}" is not available in this session — ran on ` +
							`${s?.model?.id ?? "the default model"} instead.`,
					);
				}
				rec.session = s;
				rec.compactionsAtTurnStart = 0;
				rec.turnStartedAt = rec.turnStartedAt ?? started;
				snapshotSession(rec, s);
				attachStream(rec, s);
				run.sessionFile = s?.sessionFile;
				writeManifest(run);
				return s;
			})();
			reserveSession(run.id, built);
			const session = await built;

			let lastUpdate = 0;
			const push = (force = false) => {
				const now = Date.now();
				if (!force && now - lastUpdate < UPDATE_MS) return;
				lastUpdate = now;
				const parts: string[] = [];
				if (rec.activity.length) parts.push(rec.activity.slice(-4).join("  "));
				if (rec.liveText) parts.push(rec.liveText.slice(-PREVIEW_CHARS));
				try {
					onUpdate?.({
						content: [{ type: "text", text: parts.join("\n\n") || "(starting…)" }],
						details: {
							running: true,
							runId: run.id,
							agent: run.agent,
							depth: cfg.depth,
							background: true,
							seconds: Math.round((now - started) / 1000),
						},
					} as never);
				} catch {}
			};

			const unsubscribe = session.subscribe?.((ev: any) => {
				try {
					if (ev?.type === "message_update" && ev.message?.role === "assistant") {
						const texts = (ev.message.content ?? [])
							.filter((b: any) => b?.type === "text")
							.map((b: any) => String(b.text ?? ""));
						if (texts.length) rec.liveText = texts.join("\n");
					} else if (ev?.type === "tool_execution_start") {
						// recorded by attachStream now (every turn); this
						// subscriber only refreshes the preview.
					}
					push();
				} catch {}
			});

			const onAbort = () => {
				try {
					session.abort?.();
				} catch {}
			};
			if (controller.signal.aborted) onAbort();
			else controller.signal.addEventListener("abort", onAbort, { once: true });

			// The TASK carries the same provenance line every later message gets
			// (2026-08-31, the maintainer's ruling on the stress session): the
			// exchange block teaches "the first line of every message names who
			// sent it", and the one message a fresh child had seen was the task,
			// which carried only the stamp — so a child MINTED its own header
			// ("[from orchestrator]", two children independently), and status
			// honestly previewed it. Same composer, same grammar, from = to =
			// the starter (the task's output goes back to whoever handed it).
			const starter = senderOf(env);
			const turn = session.prompt(appendStamp(`${provenanceLine(starter, starter, run)}\n\n${task}`), {
				source: "extension",
			} as never);
			// Messages that arrived while the run was QUEUED (promptRun held
			// them): steers into this turn, sent once it is under way —
			// promptRun waits for streaming before it steers, so they land at
			// the first tool boundary, and this turn's delivery covers them.
			for (const held of rec.pendingSteers?.splice(0) ?? []) {
				void promptRun(run.id, held.text, held.images, { from: held.from }).catch(() => {});
			}
			await turn;
			// THE LEAD RULE (agents/session.ts holdForTeam): the reply travels
			// only once this run's own agents are idle and their wakes
			// answered; meanwhile status says "waiting on N agents".
			await holdForTeam(rec, session);
			unsubscribe?.();
			// The fold note (draft 10): the live count against the turn-start
			// baseline — the session is still resident here, and settle
			// snapshots the count for every later reader.
			try {
				const nComp = (session.messages as { role?: string }[] | undefined)?.filter(
					(m) => m?.role === "compactionSummary",
				).length;
				if ((nComp ?? 0) > (rec.compactionsAtTurnStart ?? 0)) notes.push(COMPACTION_NOTE);
			} catch {}

			const outcome = lastAssistantOutcome(session);
			const text = capReply(run, outcome.text, notes);
			const aborted = controller.signal.aborted;
			// The team dies with a stopped run: let it settle so the family
			// roll-up counts it as it ended, not as "still working".
			if (aborted) await subtreeSettled(run.id);
			if (aborted && rec.droppedOnStop) notes.push(droppedNote(rec.droppedOnStop));
			notes.push(...userActivityNotes(rec));
			// The user's interrupt (agents/run.ts interruptRun): the run goes
			// idle and alive; nothing travels now — the follow-up's reply or
			// the 10-minute notice does (armInterruptFollowUp). A wait that
			// held this turn still gets the partial.
			if (!aborted && rec.interrupt?.phase === "unwinding") {
				rec.interrupt.phase = "idle";
				const seconds = Math.round((Date.now() - started) / 1000);
				settle(rec, "idle");
				armInterruptFollowUp(env, run);
				return {
					body: `${text ? `${text}\n\n` : ""}(interrupted by the user — the reply above is partial; the run is idle and continues when messaged)${trailerOf(run, notes, seconds)}`,
					isError: false,
					seconds,
					interrupted: true,
					suppressed: true,
				};
			}
			const why = abortKindOf(controller.signal);
			const timedOut = aborted && why === "timeout";
			const failure = !aborted && outcome.stopReason === "error";
			const seconds = Math.round((Date.now() - started) / 1000);
			if (failure) {
				const reason = outcome.errorMessage || "the model provider returned an error";
				settle(rec, "error", reason);
				return {
					body:
						`Agent ${label(run)} errored: ${reason}` +
						(text ? `\n\nPartial reply before the failure:\n\n${text}` : "") +
						trailerOf(run, notes, seconds),
					isError: true,
					seconds,
				};
			}
			settle(
				rec,
				aborted ? "stopped" : "idle",
				aborted ? (timedOut ? `timed out after ${cfg.timeout_s}s` : stopMessage(controller)) : undefined,
			);
			const stopNote = timedOut
				? `timed out after ${cfg.timeout_s}s`
				: `stopped by ${whoStopped(stopMessage(controller), run, { reader: "principal", readerId: env.parentId })}`;
			const truncated = outcome.stopReason === "length";
			const body = text
				? aborted
					? `${text}\n\n(${stopNote} — the reply above is partial)`
					: truncated
						? `${text}\n\n(cut off at the output token limit — the reply above is incomplete)`
						: text
				: aborted
					? `(${stopNote} — no output)`
					: "(no output)";
			return { body: `${body}${trailerOf(run, notes, seconds)}`, isError: false, seconds };
		} catch (e) {
			settle(rec, "error", String((e as Error)?.message ?? e));
			const seconds = Math.round((Date.now() - started) / 1000);
			const msg = String((e as Error)?.message ?? e);
			return {
				body: msg.includes(idLine(run.id)) ? msg : `Agent ${label(run)} errored: ${msg}${trailerOf(run, [], seconds)}`,
				isError: true,
				seconds,
			};
		} finally {
			env.parentSignal?.removeEventListener("abort", linkUp);
			// The session is released by settle() on every path above; see
			// agents/run.ts — never dispose from here.
		}
	})();
	rec.work = work;

	deliverWhenDone(env, run, work);

	const receipt = queued
		? `Queued "${run.title}" (${run.agent}) behind ${behind} working agent${behind === 1 ? "" : "s"}.`
		: `Started "${run.title}" (${run.agent}).`;
	return {
		content: [{ type: "text", text: `${receipt}\n\n${idLine(run.id)}` }],
		details: { runId: run.id, agent: run.agent, depth: cfg.depth, background: true, sessionDir, seconds: 0 },
	};
}

/**
 * Deliver a turn's reply: to main when the session can receive one, and to
 * the run that started this one otherwise (2026-08-28: every agent
 * receives its agents' replies the way main does — a steer mid-turn, a
 * woken turn when idle; agents/session.ts deliverToRun). The lead's owner
 * path holds on the wake (rec.wakes) before it settles, so a lead is never
 * released while its team still reports. A wait's claim skips the
 * delivery either way.
 */
function deliverWhenDone(env: ToolEnv, run: SubagentRun, work: Promise<AgentReply>, should?: () => boolean) {
	const toMain = !!env.pi && env.canDeliver === true;
	const toParent = !toMain && env.inheritedDepth !== undefined && !!env.parentId;
	if (!toMain && !toParent) return;
	void work.then((r) => {
		if (should && !should()) return;
		// A wait in progress has claimed this reply; delivering it too would
		// hand the model the same text twice. An interrupted turn is not a
		// reply either (`suppressed`): the follow-up's is.
		const cur = registry.get(run.id);
		if ((cur?.claims ?? 0) > 0) return;
		if (r.suppressed) return;
		const state = r.interrupted
			? `was interrupted by the user after ${fmtSecs(r.seconds)}`
			: run.status === "stopped"
				? run.error?.startsWith("timed out")
					? `timed out after ${fmtSecs(r.seconds)}`
					: `was stopped by ${whoStopped(run.error ?? "", run, { reader: "principal", readerId: env.parentId })} after ${fmtSecs(r.seconds)}`
				: run.status === "error"
					? `errored after ${fmtSecs(r.seconds)}`
					: `finished in ${fmtSecs(r.seconds)}`;
		const body = `Agent "${run.title}" (${run.agent}) ${state}:\n\n${r.body}`;
		const details = { runId: run.id, agent: run.agent, seconds: r.seconds, isError: r.isError };
		if (toMain) {
			// A later wait on this turn points at this delivery instead of
			// repeating it (rec.deliveredTurn; doWait).
			if (cur) cur.deliveredTurn = true;
			deliver(env.pi as ExtensionAPI, { customType: "agent-result", provenance: AGENT_DELIVERY, body, details });
			return;
		}
		const parent = registry.get(env.parentId as string);
		// The lead is stopped or gone: nothing to wake (its subtree died with
		// it, or it was never this process's) — the reply stays readable
		// through wait and status.
		if (!parent || parent.controller.signal.aborted) return;
		if (cur) cur.deliveredTurn = true;
		const p = deliverToRun(
			env.parentId as string,
			{
				customType: "agent-result",
				content: appendStamp(`${AGENT_DELIVERY}\n\n${body}`),
				display: true,
				details,
			},
			{ kind: "agent", id: run.id },
		).catch(() => {});
		(parent.wakes ??= new Set()).add(p);
		void p.finally(() => parent.wakes?.delete(p));
	});
}

/* ---------------- message ---------------- */

async function doMessage(env: ToolEnv, params: AgentInput, _ctx: any) {
	const ids = toArray(params.to);
	if (ids.length !== 1) throw new Error(`message needs one agent id in "to".`);
	if (!params.message?.trim()) throw new Error(`message needs a message.`);
	const peer = resolvePeer(ids[0]);
	if (peer) {
		const frame = { type: "message", from: fromOf(env), text: params.message };
		if (peer.self) {
			// A child messaging the session that owns it — the local handler,
			// same process. The top level messaging itself is a loop, refused;
			// a team-scoped child does not reach its session's main agent
			// (2026-08-28: a blocker ends the turn and travels in the reply).
			if (env.inheritedDepth === undefined) throw new Error(`"${ids[0]}" is this session's own id.`);
			if ((env.reach ?? "team") !== "session")
				throw new Error(
					`Your session's main agent is outside your reach: you can message only the agents you started. What it must know travels in your reply.`,
				);
			const res = await localPeerFrame(frame);
			if (!res?.ok) throw new Error(`Not delivered: ${String(res?.reason ?? "the session is not receiving")}`);
			return { content: [{ type: "text", text: `Delivered to your session.` }], details: { peer: "self" } };
		}
		if (!peer.entry)
			throw new Error(
				`No session matches "${ids[0]}". Sessions on this machine:\n${listPeers().map(peerLabel).join("\n") || "(none)"}`,
			);
		try {
			const res = await sendToPeer(peer.entry, frame);
			if (!res?.ok) throw new Error(`Not delivered to ${peerLabel(peer.entry)}: ${String(res?.reason ?? "refused")}`);
			return {
				content: [{ type: "text", text: `Delivered to ${peerLabel(peer.entry)}.` }],
				details: { peer: peer.entry.sessionId },
			};
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			if (msg.includes("no longer running"))
				throw new Error(`${peerLabel(peer.entry)} is no longer running; nothing delivered.`);
			throw e;
		}
	}
	const run = mustFind(env, ids[0], "message");
	gateReach(env, run, "message");
	const wasQueued = run.status === "queued";
	// A released run is rebuilt here, OUTSIDE the send, so a missing
	// transcript is the tool's error, never a swallowed one.
	if (run.status !== "working" && !wasQueued) await ensureSession(run.id);
	const started = Date.now();
	// The receipt is written at ACCEPTANCE — pi's preflightResult(true) —
	// not before it (2026-08-25). Until then nothing has been delivered,
	// and a send that fails first rejects here, into the tool's own error.
	// `owns` is what the send turned out to be: a steer into a turn in
	// flight (false), or a new turn of its own (true — an idle run, or one
	// whose turn ended while the steer waited to join it).
	let owns: boolean | undefined;
	let acceptResolve!: (o: boolean) => void;
	const acceptance = new Promise<boolean>((resolve) => (acceptResolve = resolve));
	// The body only: the provenance line (sender, and where this turn's
	// output goes back to) and the stamp are sendToRun's (2026-08-30).
	const send = promptRun(run.id, params.message, undefined, {
		from: senderOf(env),
		onAccepted: (o) => {
			owns = o === true;
			acceptResolve(owns);
		},
	});
	owns = await Promise.race([acceptance, send.then(() => owns ?? false)]);
	const rec = registry.get(run.id);
	// The reply THIS turn produced: its own stream (agents/stream.ts), never
	// the transcript's last text, which is the previous turn's when this one
	// died or was stopped before it said anything (stress audit 1(b): the
	// previous reply delivered as fresh).
	const replyOf = (current: SubagentRun, failure?: string): AgentReply => {
		const seconds = Math.round((Date.now() - started) / 1000);
		const notes = compactedThisTurn(current) ? [COMPACTION_NOTE] : [];
		const partial = capReply(current, currentTurnText(current), notes);
		if (current.status === "stopped" && rec?.droppedOnStop) notes.push(droppedNote(rec.droppedOnStop));
		if (rec) notes.push(...userActivityNotes(rec));
		if (failure || current.status === "error") {
			const reason = current.error ?? failure ?? "the model provider returned an error";
			return {
				body:
					`Agent ${label(current)} errored: ${reason}` +
					(partial ? `\n\nPartial reply before the failure:\n\n${partial}` : "") +
					trailerOf(current, notes, seconds),
				isError: true,
				seconds,
			};
		}
		// The user's interrupt ended this turn (agents/session.ts settled it
		// idle inside the episode): the sentence says so and the body names it.
		if (rec?.interrupt && rec.interrupt.phase !== "noticed") {
			return {
				body: `${partial ? `${partial}\n\n` : ""}(interrupted by the user — the reply above is partial; the run is idle and continues when messaged)${trailerOf(current, notes, seconds)}`,
				isError: false,
				seconds,
				interrupted: true,
				suppressed: true,
			};
		}
		const reply = partial || "(no output)";
		return { body: `${reply}${trailerOf(current, notes, seconds)}`, isError: false, seconds };
	};
	if (owns) {
		// This send OWNS a turn: its completion is the reply, delivered once.
		const work: Promise<AgentReply> = (async () => {
			let failure: string | undefined;
			try {
				await send;
			} catch (e) {
				failure = String((e as Error)?.message ?? e);
			}
			// The user interrupted this principal-owned turn: the episode's
			// route is this principal's (agents/session.ts settled it idle).
			const cur = registry.get(run.id);
			if (cur?.interrupt?.phase === "idle" && !cur.interrupt.timer) armInterruptFollowUp(env, run);
			if (knownRuns.get(run.id)?.status === "stopped") await subtreeSettled(run.id);
			return replyOf(knownRuns.get(run.id) ?? run, failure);
		})();
		if (rec) rec.work = work;
		deliverWhenDone(env, run, work);
	} else if (rec && !rec.work && rec.turnDone && !rec.deliveryArmed) {
		// Joined a turn NO tool started (the user's, from the run view): the
		// owner delivers nothing, so the joiner arms this turn's one delivery
		// — the reply covers the user's prompt and this message alike. A turn
		// a tool started (rec.work) delivers through its owner as before.
		rec.deliveryArmed = true;
		const work = rec.turnDone.then(() => replyOf(knownRuns.get(run.id) ?? run));
		rec.work = work;
		deliverWhenDone(env, run, work);
	}
	const behind = activeCount(slotKeyOf(run));
	const receipt = wasQueued
		? `Delivered to ${label(run)}; it is queued behind ${behind} working agent${behind === 1 ? "" : "s"} and reads it as soon as it starts.`
		: owns
			? `Delivered to ${label(run)}; it starts its next turn with it.`
			: `Delivered to ${label(run)}; it reads it at its next tool boundary.`;
	return {
		content: [{ type: "text", text: `${receipt}\n\n${idLine(run.id)}` }],
		details: { runId: run.id, agent: run.agent },
	};
}

/* ---------------- ask ---------------- */

async function doAsk(env: ToolEnv, params: AgentInput, signal: AbortSignal | undefined, ctx?: unknown) {
	const ids = toArray(params.to);
	if (ids.length !== 1) throw new Error(`ask needs one agent id in "to".`);
	if (!params.question?.trim()) throw new Error(`ask needs a question.`);
	const peer = resolvePeer(ids[0]);
	if (peer) {
		const frame = { type: "ask", from: fromOf(env), question: params.question };
		let res: any;
		if (peer.self) {
			if (env.inheritedDepth === undefined) throw new Error(`"${ids[0]}" is this session's own id.`);
			res = await localPeerFrame(frame);
		} else if (peer.entry) {
			res = await sendToPeer(peer.entry, frame, 120_000);
		} else {
			throw new Error(
				`No session matches "${ids[0]}". Sessions on this machine:\n${listPeers().map(peerLabel).join("\n") || "(none)"}`,
			);
		}
		if (!res?.ok) throw new Error(`ask failed: ${String(res?.reason ?? "no answer")}`);
		return {
			content: [{ type: "text", text: `${String(res.answer ?? "(no answer)")}` }],
			details: { peer: peer.self ? "self" : peer.entry?.sessionId, ask: true },
		};
	}
	const run = mustFind(env, ids[0], "ask");
	const asker = senderName(senderOf(env), run);
	const answer = await raceAbort(
		askRun(run, params.question, asker, signal),
		signal,
		() => `Ask aborted by ${abortedBy(ctx)}: ${label(run)} was not asked.`,
	);
	return {
		content: [{ type: "text", text: `${answer}\n\n${idLine(run.id)}` }],
		details: { runId: run.id, agent: run.agent, ask: true },
	};
}

async function doWait(env: ToolEnv, params: AgentInput, signal: AbortSignal | undefined, ctx?: unknown) {
	const ids = toArray(params.to);
	if (!ids.length) throw new Error(`wait needs one or more agent ids in "to".`);
	// Claim EVERY resolvable target UP FRONT, before the first hold. The old
	// per-id claim was placed only when the sequential loop REACHED an id, so
	// every id behind a slow one sat unclaimed for the whole earlier hold, and
	// a run settling in that window was delivered by deliverWhenDone AND then
	// reported by this wait — the same reply twice (the maintainer's stress
	// session, 2026-08-31: three replies composed mid-wait at 16:45:52–16:46:23
	// against a wait whose result composed at 16:47:21). One claim per
	// OCCURRENCE, matching the loop's one release per aborted occurrence; ids
	// that do not resolve here (peers, unknown, reach-refused) claim nothing
	// and the loop reports them exactly as before.
	for (const id of ids) {
		try {
			const r = mustFind(env, id, "hold for");
			gateReach(env, r, "wait");
			const rc = registry.get(r.id);
			if (rc) rc.claims = (rc.claims ?? 0) + 1;
		} catch {
			/* the loop below composes the refusal text */
		}
	}
	const sections: string[] = [];
	let anyError = false;
	// An aborted wait is an ERROR result like bash's aborted command — red on
	// screen, an error to the model — and pi marks a result as an error only
	// when the tool THROWS (agent-loop.js prepareToolCall: a returned
	// `isError` is ignored), so the abort is thrown at the end (2026-08-29).
	let aborted = false;
	for (const id of ids) {
		const peer = resolvePeer(id);
		if (peer) {
			// wait holds until the agent is idle, whoever started the turn —
			// a peer included (the 2026-08-24 redefinition). Its user may be
			// hours from done; the caller's Esc ends the hold, never the peer.
			if (peer.self || !peer.entry) {
				sections.push(peer.self ? `session_${ownSessionId()} is this session.` : `No session matches "${id}".`);
				continue;
			}
			let out = "";
			for (;;) {
				if (signal?.aborted) {
					aborted = true;
					out = `Wait aborted by ${abortedBy(ctx)}: ${peerLabel(peer.entry)} was still working; it continues (a session's user answers to nobody here).`;
					break;
				}
				try {
					const res = await sendToPeer(peer.entry, { type: "status" }, 5_000);
					if (String(res?.state) !== "working") {
						out =
							`${peerLabel(peer.entry)} is idle${stopNoteOf(res)}.` +
							(res?.lastText ? `\nIts latest output:\n${String(res.lastText)}` : "");
						break;
					}
				} catch {
					out = `${peerLabel(peer.entry)} is no longer running.`;
					break;
				}
				await new Promise((r) => setTimeout(r, 1_000));
			}
			sections.push(out);
			continue;
		}
		let run: SubagentRun | undefined;
		try {
			run = mustFind(env, id, "hold for");
			gateReach(env, run, "wait");
		} catch (e) {
			sections.push(String((e as Error).message));
			continue;
		}
		const rec = registry.get(run.id);
		if (run.status === "working" || run.status === "queued" || hasPendingSend(run.id)) {
			// wait holds until the agent is IDLE, whoever started the turn
			// (2026-08-24, maintainer: the user chats with agents too — a
			// run-view turn has no work promise, and the old fall-through
			// reported it "finished (earlier)" while it visibly worked).
			// A tool-started turn has rec.work; any other turn is watched
			// through its settle (the record's status flips there).
			// The claim was placed by the UP-FRONT pass above (one per
			// occurrence, before any hold); this wait is the reply's consumer,
			// so the delivery must not repeat it. Released on interruption.
			// A COUNT: two waits, one interrupted, must not release what the
			// other still holds.
			const settled: Promise<boolean> = rec?.work
				? rec.work.then(() => true)
				: (async () => {
						while (run.status === "working" || run.status === "queued" || hasPendingSend(run.id)) {
							if (signal?.aborted) return false;
							await new Promise((r) => setTimeout(r, 250));
						}
						return true;
					})();
			const interrupted = await Promise.race([
				settled.then(() => false),
				new Promise<boolean>((resolve) => {
					if (!signal) return;
					if (signal.aborted) resolve(true);
					else signal.addEventListener("abort", () => resolve(true), { once: true });
				}),
			]);
			if (interrupted === true) {
				if (rec) rec.claims = Math.max(0, (rec.claims ?? 0) - 1);
				// Three situations, three true sentences (2026-08-29, the
				// maintainer's screenshot: a stopped lead's wait said its
				// stopped workers "continue" and would "arrive"): the WAITER is
				// being stopped and the target dies with it (a descendant); the
				// waiter is being stopped and the target is not its own (reach
				// session); the waiter was interrupted (Esc) or is main after
				// the user's Esc, and the target works on.
				const me = env.parentId ? registry.get(env.parentId) : undefined;
				const stopping = !!me && me.controller.signal.aborted;
				const who = abortedBy(ctx);
				aborted = true;
				if (stopping && me && descendsFrom(run, me.run.id))
					sections.push(`Wait aborted by ${who}: you were stopped, and ${run.id} was stopped with you.`);
				else if (stopping) sections.push(`Wait aborted by ${who}: you were stopped; ${run.id} continues on its own.`);
				else
					sections.push(
						`Wait aborted by ${who}: ${run.id} was still working; it continues, and its reply ${env.parentId ? "is read at your next turn" : "arrives with the next user prompt"}.`,
					);
				continue;
			}
			const current = knownRuns.get(run.id) ?? run;
			if (current.status === "stopped") await subtreeSettled(run.id);
			if (rec?.work) {
				const r = await rec.work;
				anyError = anyError || r.isError;
				const word = r.interrupted
					? `was interrupted by the user after ${fmtSecs(r.seconds)}`
					: stateWord(current, r.seconds);
				// A turn whose reply already went out as its own delivery is
				// pointed at, never repeated (rec.deliveredTurn) — repeating it
				// handed the model the same text twice.
				if (rec.deliveredTurn) {
					sections.push(
						`Agent "${current.title}" (${current.agent}) ${word}; its reply was delivered as its own agent result and is not repeated here.`,
					);
				} else {
					sections.push(`Agent "${current.title}" (${current.agent}) ${word}:\n\n${r.body}`);
				}
			} else if (rec?.deliveredTurn) {
				const from = rec.turnStartedAt ?? current.startedAt;
				const seconds = current.endedAt ? Math.max(0, Math.round((current.endedAt - from) / 1000)) : 0;
				anyError = anyError || current.status === "error";
				sections.push(
					`Agent "${current.title}" (${current.agent}) ${stateWord(current, seconds, env.parentId)}; its reply was delivered as its own agent result and is not repeated here.`,
				);
			} else {
				// The TURN's duration, not the run's lifetime: a run continued
				// twice reports the turn just waited on.
				const from = rec?.turnStartedAt ?? current.startedAt;
				const seconds = current.endedAt ? Math.max(0, Math.round((current.endedAt - from) / 1000)) : 0;
				// This turn's own text (its stream), not the transcript's last
				// reply — the previous turn's, when this one said nothing.
				const wnotes = compactedThisTurn(current) ? [COMPACTION_NOTE] : [];
				const reply = capReply(current, currentTurnText(current), wnotes) || "(no output)";
				anyError = anyError || current.status === "error";
				sections.push(
					`Agent "${current.title}" (${current.agent}) ${stateWord(current, seconds, env.parentId)}:\n\n${reply}${trailerOf(
						current,
						wnotes,
						seconds,
					)}`,
				);
			}
			continue;
		}
		// Already settled (this process or an earlier one): its last reply.
		// The LAST TURN's duration when this process saw it start; the run's
		// lifetime is the only clock a manifest from an earlier process has.
		const from = rec?.turnStartedAt ?? run.startedAt;
		const seconds = run.endedAt ? Math.max(0, Math.round((run.endedAt - from) / 1000)) : 0;
		// The fourth duplicate of the stress session lived HERE: the run
		// finished and its reply was delivered between two waits, and the
		// later wait repeated the whole body. Point at the delivery instead.
		if (rec?.deliveredTurn) {
			sections.push(
				`Agent "${run.title}" (${run.agent}) ${stateWord(run, seconds, env.parentId)} (earlier); its reply was delivered as its own agent result and is not repeated here.`,
			);
			continue;
		}
		const enotes: string[] = [];
		const reply = capReply(run, lastReplyFromTranscript(run), enotes) || "(no output)";
		sections.push(
			`Agent "${run.title}" (${run.agent}) ${stateWord(run, seconds, env.parentId)} (earlier):\n\n${reply}${trailerOf(run, enotes)}`,
		);
	}
	if (aborted) throw new Error(sections.join("\n\n---\n\n"));
	return {
		content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
		details: { wait: ids, anyError },
	};
}

function stateWord(run: SubagentRun, seconds: number, readerId: string | null = null): string {
	if (run.status === "stopped")
		return run.error?.startsWith("timed out")
			? `timed out after ${fmtSecs(seconds)}`
			: `was stopped by ${whoStopped(run.error ?? "", run, { reader: "principal", readerId })} after ${fmtSecs(seconds)}`;
	if (run.status === "error") return `errored after ${fmtSecs(seconds)}`;
	return `finished in ${fmtSecs(seconds)}`;
}

/* ---------------- status ---------------- */

async function doStatus(env: ToolEnv, params: AgentInput) {
	let ids = toArray(params.to);
	const bare = !ids.length;
	// The leader's own window (draft 10: it is the one that must last, and
	// nothing else ever tells the model how full it is). Top level only —
	// a child's fill is its host's to report.
	const own = (() => {
		if (env.inheritedDepth !== undefined) return "";
		let u: MainUsage;
		try {
			u = mainContextSource?.();
		} catch {}
		const cx =
			u && typeof u.contextWindow === "number"
				? fmtContext({ tokens: u.tokens ?? null, window: u.contextWindow, percent: u.percent ?? null })
				: "";
		// print sessions have no peer registration and may never see
		// session_start, so the id can be unknown — say nothing rather than
		// "session_…" (a literal ellipsis is not an id).
		const sid = ownSessionId() ?? env.ownerSession;
		return cx ? `This session${sid ? ` (session_${sid})` : ""}: ${cx}` : "";
	})();
	// Bare status (no `to`): every working or queued agent of this session.
	if (!ids.length) {
		ids = [...knownRuns.values()]
			.filter((r) => r.ownerSession === env.ownerSession && (r.status === "working" || r.status === "queued"))
			.sort((a, b) => b.startedAt - a.startedAt)
			.map((r) => r.id);
		if (!ids.length)
			return {
				content: [{ type: "text", text: own ? `${own}\n\n---\n\n(no working agents)` : "(no working agents)" }],
				details: { status: [] },
			};
	}
	const sections: string[] = [];
	if (bare && own) sections.push(own);
	for (const id of ids) {
		const peer = resolvePeer(id);
		if (peer) {
			if (peer.self) {
				sections.push(own || `session_${ownSessionId()} is this session.`);
				continue;
			}
			if (!peer.entry) {
				sections.push(`No session matches "${id}".`);
				continue;
			}
			try {
				const res = await sendToPeer(peer.entry, { type: "status" }, 5_000);
				sections.push(
					`${peerLabel(peer.entry)}: ${String(res?.state ?? "unknown")}${stopNoteOf(res)}` +
						(res?.lastText ? `\nlast text:\n${String(res.lastText)}` : ""),
				);
			} catch {
				sections.push(`${peerLabel(peer.entry)} is no longer running.`);
			}
			continue;
		}
		const run = mustFind(env, id, "check");
		const rec = registry.get(run.id);
		// The last TURN's duration (a continued run reported its whole
		// lifetime as "finished in"); the run's start when no turn clock exists.
		const from = rec?.turnStartedAt ?? run.startedAt;
		const took = fmtSecs(Math.max(0, Math.round(((run.endedAt ?? from) - from) / 1000)));
		const team = descendantsOf(run.id).filter((r) => r.status === "working" || r.status === "queued").length;
		const state =
			run.status === "working"
				? `working for ${activeElapsedOf(run)}${rec?.holding && team ? `, waiting on ${team} agent${team === 1 ? "" : "s"} of its own` : ""}`
				: run.status === "queued"
					? "queued"
					: run.status === "idle"
						? `idle${run.endedAt ? ` for ${fmtSecs(Math.round((Date.now() - run.endedAt) / 1000))}` : ""} (finished in ${took})`
						: run.status === "stopped"
							? `stopped after ${took}${sessionEndOf(run.error) ? ` · ${sessionEndOf(run.error)}` : ""}`
							: `errored after ${took}${run.error ? `: ${run.error}` : ""}`;
		// The context figure and the fold count (draft 10): the errand-
		// versus-worker judgment hinges on both, and status is where the
		// leader looks. Live when resident, the settle snapshot otherwise.
		const cx = fmtContext(contextOf(run));
		const folds = liveCompactions(run);
		const stateLine = `${state}${cx ? ` · ${cx}` : ""}${folds ? ` · compacted ${folds}×` : ""}`;
		const tools = rec?.activity.length
			? `\nlast tools: ${rec.activity
					.slice(-6)
					.map((a) => a.replace(/^⚙ /, ""))
					.join(", ")}`
			: "";
		// A WORKING run shows only what THIS turn has produced — its stream —
		// never the previous reply masquerading as progress; a settled one
		// shows its latest reply.
		const src = run.status === "working" || run.status === "queued" ? currentTurnText(run) : latestText(run);
		const head = src.slice(0, STATUS_HEAD_CHARS);
		const tail = head ? `\nreply so far:\n${head}` : "";
		sections.push(`Agent ${label(run)} (${run.id}): ${stateLine}${tools}${tail}\n\n${idLine(run.id)}`);
	}
	return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }], details: { status: ids } };
}

/* ---------------- stop ---------------- */

function doStop(env: ToolEnv, params: AgentInput) {
	const ids = toArray(params.to);
	if (ids.length !== 1) throw new Error(`stop needs one agent id in "to".`);
	const peer = resolvePeer(ids[0]);
	if (peer) {
		const who = peer.self ? `session_${ownSessionId()}` : peer.entry ? peerLabel(peer.entry) : ids[0];
		throw new Error(`${who} is a session with its own user; it cannot be stopped from here.`);
	}
	const run = mustFind(env, ids[0], "stop");
	gateReach(env, run, "stop");
	// The WHOLE subtree dies with it (linked signals); count it all
	// (2026-08-28, C5: direct children only understated the toll).
	const family = descendantsOf(run.id).filter((r) => r.status === "working" || r.status === "queued").length;
	// The cause names the STOPPER, so every reader gets its own phrase (you /
	// the agent that started it / agent <id>; agents/run.ts whoStopped).
	const stopped = abortRun(
		run.id,
		abortCause("stopped", env.parentId ? `stopped by agent ${env.parentId}` : "stopped by the main agent"),
	);
	const dropped = registry.get(run.id)?.droppedOnStop ?? 0;
	const what = stopped
		? `Stopped ${label(run)}${family ? ` and ${family} agent${family === 1 ? "" : "s"} under it` : ""}.` +
			(dropped
				? ` ${dropped} message${dropped === 1 ? "" : "s"} it had accepted but not yet read ${dropped === 1 ? "was" : "were"} discarded.`
				: "")
		: run.status === "working" || run.status === "queued"
			? `${label(run)} is owned by another pi process and cannot be stopped from here.`
			: `${label(run)} was already ${run.status}.`;
	return {
		content: [{ type: "text", text: `${what}\n\n${idLine(run.id)}` }],
		details: { runId: run.id, agent: run.agent, stopped },
	};
}

/* ---------------- list ---------------- */

async function doList(env: ToolEnv) {
	const all = [...knownRuns.values()].filter((r) => r.ownerSession === env.ownerSession);
	const roots = all.filter((r) => !r.parentId || !knownRuns.has(r.parentId)).sort((a, b) => b.startedAt - a.startedAt);
	const lines: string[] = [];
	// Relations for a CHILD caller (2026-08-28, B17): itself, its principal,
	// its own team; everyone is listed, marked. A lead row counts its team.
	const me = env.inheritedDepth !== undefined ? env.parentId : null;
	const mine = me ? knownRuns.get(me) : undefined;
	const relation = (run: SubagentRun): string => {
		if (!me) return "";
		if (run.id === me) return " (you)";
		if (mine?.parentId === run.id) return " (your principal)";
		if (descendsFrom(run, me)) return " (yours)";
		return "";
	};
	const emit = (run: SubagentRun, depth: number) => {
		const state =
			run.status === "working"
				? `working ${activeElapsedOf(run)}`
				: run.status === "queued"
					? "queued"
					: run.status === "idle"
						? `idle${run.endedAt ? ` ${fmtSecs(Math.round((Date.now() - run.endedAt) / 1000))}` : ""}`
						: run.status === "stopped"
							? `stopped${sessionEndOf(run.error) ? ` · ${sessionEndOf(run.error)}` : ""}`
							: "error";
		const cx = contextOf(run);
		const cxs = cx && cx.percent !== null ? ` · ctx ${fmtPct(cx.percent)}` : "";
		const under = descendantsOf(run.id).length;
		const team = under ? ` · ${under} under it` : "";
		lines.push(
			`${depth ? `${"  ".repeat(depth - 1)}└ ` : ""}${run.id} · ${label(run)} · ${state}${cxs}${team}${relation(run)}`,
		);
		for (const k of childrenOf(run.id)) emit(k, depth + 1);
	};
	for (const r of roots) emit(r, 0);
	const peers = listPeers();
	// In PARALLEL: N hung peers used to cost 1.5s each, serially (stress
	// audit #18).
	const peerLines: string[] = await Promise.all(
		peers.map(async (p) => {
			let state = "unreachable";
			let name = p.name;
			try {
				const res = await sendToPeer(p, { type: "status" }, 1_500);
				if (res?.ok) {
					state = String(res.state ?? "idle");
					// The live name (a /name after the peer's boot), not the
					// registry's boot-time one (2026-08-29).
					if (typeof res.name === "string" && res.name) name = res.name;
				}
			} catch {}
			return `session_${p.sessionId} · ${name ? `"${name}"` : p.cwd} · ${state}`;
		}),
	);
	const parts: string[] = [];
	parts.push(lines.length ? `Your agents:\n${lines.join("\n")}` : "(no agents)");
	if (peerLines.length) parts.push(`Peers:\n${peerLines.join("\n")}`);
	return { content: [{ type: "text", text: parts.join("\n\n") }], details: { count: all.length, peers: peers.length } };
}
