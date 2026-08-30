/**
 * The subagent runtime's state: run records, the on-disk manifests, the
 * in-memory index every view reads from, and the release of live child
 * sessions when a run settles.
 *
 * This layer knows nothing about rendering. `visual/` imports it; it
 * never imports `visual/`. That one-way arrow is what keeps the runtime
 * reusable — workflow and the MCP adapter will consume it the same way
 * the subagent tool does.
 *
 * Transcripts live BESIDE the conversation that spawned them:
 *   <sessions>/<cwd>/subagents/<owner-session-id>/<run>/
 * The legacy flat pool is still read so older runs stay visible.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fmtSecs } from "../util/format.ts";
import { releaseSlot } from "./slots.ts";

/* ---------------- types ---------------- */

export interface RunConfig {
	depth: number;
	model?: string;
	effort?: string;
	tools?: string[];
	excludeTools?: string[];
	extensions?: string[];
	timeout_s?: number;
	cwd?: string;
	/** Replaces Pi's default or the project's system prompt (2026-08-24). */
	systemPrompt?: string;
	/** Added to the system prompt in force. */
	appendSystemPrompt?: string;
	/** How many agents this agent may have working at once (agents/slots.ts). */
	concurrency?: number;
	/** Whom it may reach with message, wait and stop: its own team (default) or the whole session (2026-08-28). */
	reach?: "team" | "session";
}

export interface AgentDef {
	name: string;
	description: string;
	systemPrompt: string;
	config: Partial<RunConfig>;
}

/**
 * The states of the contract (dev/internals/README.md):
 * working | queued | idle | stopped | error. queued = recorded but waiting
 * for a concurrency slot; stopped covers the user's ✕, a parent teardown
 * and a timeout (the reply text says which); error is a provider or build
 * failure. Manifests from before the rename are mapped at the read
 * boundary (running→working, done→idle, failed→error), never rejected.
 */
export type AgentStatus = "working" | "queued" | "idle" | "stopped" | "error";

/** A finished turn's reply, kept for wait (contract: wait returns each answer). */
export interface AgentReply {
	/** The full reply text a foreground result would carry, trailer included. */
	body: string;
	isError: boolean;
	seconds: number;
	/** The turn was ended by the user's interrupt (the run is idle and alive); the sentence says so (2026-08-29). */
	interrupted?: boolean;
	/** This reply must not be delivered (an interrupted turn is not a reply; the follow-up's is). */
	suppressed?: boolean;
}

export interface SubagentRun {
	id: string;
	agent: string;
	title: string;
	task: string;
	sessionDir: string;
	sessionFile?: string;
	status: AgentStatus;
	startedAt: number;
	endedAt?: number;
	parentId: string | null;
	/** Root interactive session that owns this whole family. */
	ownerSession: string | null;
	depth: number;
	/** Pre-2026-08-24 manifests; every run replies by delivery now. */
	background: boolean;
	error?: string;
	/** PID of the pi process that owns this run, for stale detection. */
	pid?: number;
	/** Resolved config, persisted so a run can be rehydrated for chat. */
	config?: RunConfig;
	/** Model id the run finished on; the live session is gone by then. */
	model?: string;
	/** Thinking level the run finished on. */
	thinking?: string;
	/** The tool names the child was actually built with (snapshotSession). */
	tools?: string[];
	/**
	 * Token/cost/context snapshot taken when the run settled. The run
	 * footer reads this, which is what lets the session be released the
	 * moment a run finishes rather than kept resident just to answer
	 * getSessionStats().
	 */
	stats?: any;
	/**
	 * Context fill at settle (pi's getContextUsage): the errand-versus-
	 * worker and when-to-fold judgments both hinge on it, and the session
	 * is released the moment the run ends, so it must be captured here.
	 * tokens/percent are null right after a compaction (pi trusts only a
	 * post-compaction assistant's usage).
	 */
	context?: { tokens: number | null; window: number; percent: number | null };
	/** compactionSummary messages in the session at settle (draft 10: a fold quietly weakens a worker). */
	compactions?: number;
	/** An "interrupted (...)" death already told to the model at a session start (index.ts), never twice. */
	reported?: boolean;
	/** The same death already told to the run that started it, ahead of its next turn (tools/interrupted.ts). */
	reportedToPrincipal?: boolean;
}

/**
 * pi's own resolution of the agent dir — the SAME function pi uses, so the
 * two never disagree: it expands `~` in the env override and derives the env
 * name from pi's brand (`PI_CODING_AGENT_DIR`, or `TAU_…` on a rebrand). The
 * hand-rolled version read the raw env var, so `PI_CODING_AGENT_DIR=~/x`
 * pointed pi at `/home/u/x` and war-dogs at a literal `~/x`.
 */
export function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return path.join(os.homedir(), ".pi", "agent");
	}
}

/** Legacy flat location; still read so older runs stay visible. */
function legacyRunsRoot(): string {
	return path.join(agentDir(), "subagent-runs");
}

// Directory of the session that owns this pi process, captured at
// session_start.
let ownerSessionDir: string | null = null;
let ownerSessionId: string | null = null;

/** Set once per session so runs land beside the conversation that spawned them. */
export function setOwnerSession(id: string | null, sessionFile: string | null) {
	ownerSessionId = id;
	ownerSessionDir = sessionFile ? path.dirname(sessionFile) : null;
}

export function ownerSessionDirOrNull() {
	return ownerSessionDir;
}

/**
 * Subagent transcripts live BESIDE the conversation that spawned them:
 *
 *   <sessions>/<cwd>/subagents/<owner-session-id>/<run>/
 *
 * The old flat ~/.pi/agent/subagent-runs/ pool gave no way to tell which
 * chat a run belonged to, and had no relationship to the transcript it
 * came from. Falls back to the legacy path for ephemeral sessions.
 */
export function runsRoot(): string {
	if (ownerSessionDir && ownerSessionId) {
		return path.join(ownerSessionDir, "subagents", ownerSessionId);
	}
	return legacyRunsRoot();
}

/** Every directory the station should scan, newest layout first. */
export function runsRoots(): string[] {
	const roots: string[] = [];
	if (ownerSessionDir) {
		const base = path.join(ownerSessionDir, "subagents");
		try {
			for (const d of fs.readdirSync(base)) roots.push(path.join(base, d));
		} catch {}
	}
	roots.push(legacyRunsRoot());
	return roots;
}
/* ---------------- registry ---------------- */

// Module-scoped: nested runs are in-process now, so every level of the
// family shares this map. run.json is still written per run so finished
// runs survive a restart and the station can show them later.
/**
 * A party of the exchange (2026-08-30): who sent a message to a run, and
 * who a turn's final output goes back to. The user (the run view), the
 * main agent, or an agent of this session by id.
 */
export type Party = { kind: "user" } | { kind: "main" } | { kind: "agent"; id: string };

export interface RunRecord {
	run: SubagentRun;
	controller: AbortController;
	/**
	 * Live session while the run is working. Released by settle(); a later
	 * chat rebuilds it on demand via ensureSession().
	 */
	session?: any;
	liveText: string;
	activity: string[];
	/**
	 * The assistant message currently streaming. Partial content NEVER
	 * appears in session.messages — it only arrives through subscribe()
	 * as message_update — so without capturing it here a chat view can
	 * only redraw once a turn has fully finalised.
	 */
	streamMsg?: any;
	/** Start of the CURRENT turn, as opposed to the run's original start. */
	turnStartedAt?: number;
	/** compactionSummary count when the current turn started; the reply's compaction note compares against it. */
	compactionsAtTurnStart?: number;
	/** Unsubscribe for the persistent stream capture. */
	unstream?: () => void;
	/**
	 * The current (or last) turn's completion, for `wait`. Set by whoever
	 * owns the turn (tools/agent.ts run/message); resolves with the reply
	 * text a foreground result would carry. Never rejects.
	 */
	work?: Promise<AgentReply>;
	/**
	 * How many waits hold this turn's reply: deliverWhenDone skips a
	 * claimed reply, or the same reply arrived twice — once as wait's
	 * return, once as the delivery (maintainer's screenshot, 2026-08-24).
	 * An interrupted wait releases ITS claim, so "its reply will be
	 * delivered" holds; a COUNT, not a flag, because two waits on one run
	 * with one interrupted un-claimed what the other still held, and the
	 * reply arrived twice again (demonstrated 2026-08-25). A completed
	 * wait keeps its claim: it consumed the reply.
	 */
	claims?: number;
	/** Whether this run holds a concurrency slot (agents/slots.ts). */
	slotHeld?: boolean;
	/**
	 * Resolves when the CURRENT turn settles, whoever owns it — created at
	 * every owner-turn start (sendToRun, doRun), resolved by settle(). A
	 * message that JOINS a turn no tool started (the user's run-view turn)
	 * has no work promise to deliver on; this is what it delivers on
	 * (2026-08-25: the steered reply never reached the model at all).
	 */
	turnDone?: Promise<void>;
	resolveTurn?: () => void;
	/** A delivery is armed for this turn by a joiner; one per turn. Cleared at owner-turn start. */
	deliveryArmed?: boolean;
	/**
	 * Who THIS turn's final output goes back to (2026-08-30, the exchange
	 * block): the sender of the message that owns the turn; the user for a
	 * turn typed in the run view; the interrupted turn's receiver for the
	 * user's follow-up inside an interrupt episode. Set by doRun for the
	 * task and by sendToRun on every owned turn; a joiner reads it, and an
	 * agent joining a user turn takes it (it arms that turn's delivery).
	 * Stated in the provenance line of every message after the task.
	 */
	turnOutput?: Party;
	/**
	 * Messages sent while the run was QUEUED (no session, no transcript
	 * yet); handed over as steers the moment its task turn starts (doRun).
	 * Before this, promptRun on a queued run threw "transcript is missing"
	 * into a swallowed catch — the receipt said Delivered, nothing was.
	 */
	pendingSteers?: { text: string; images?: { type: "image"; mimeType: string; data: string }[]; from: Party }[];
	/** THIS turn's timeout timer (armTimeout): per turn, armed once work starts, cleared at settle. */
	timer?: ReturnType<typeof setTimeout>;
	/** Messages the run had accepted but not yet read when it was stopped (abortRun clears pi's queues); named in the reply. */
	droppedOnStop?: number;
	/**
	 * Turns this run's OWN agents started on it by delivering their replies
	 * (agents/session.ts deliverToRun), each resolving when that turn ends.
	 * The lead rule (2026-08-28): a lead's reply travels only once its team
	 * is idle and every wake has been answered — doRun/sendToRun hold on
	 * these before settling.
	 */
	wakes?: Set<Promise<void>>;
	/** True while the owner turn is over and the run is held for its team (status stays working; status text says so). */
	holding?: boolean;
	/** The user's run-view chats since the principal's last message (the reply notes them, 2026-08-28). */
	userChats?: number;
	/** The user's interrupts (Esc in the run view) since the principal's last message. */
	userInterrupts?: number;
	/**
	 * THE INTERRUPT EPISODE, one object (2026-08-29; it was five flags read by
	 * three paths). interruptRun opens it "unwinding": the turn is being
	 * ended by the user's hand, not the principal's, and the owner path
	 * settles the run idle inside it ("idle": no follow-up yet — nothing wakes
	 * the run, its agents' replies park). The user's follow-up settle fires
	 * `onFollowUp` (that reply travels) and closes it; the principal's own
	 * message closes it without a delivery. `timer` is the ten-minute notice,
	 * keyed on `at`; once it has told the principal the phase is "noticed":
	 * deliveries wake the run again, and a late follow-up still reports.
	 */
	interrupt?: InterruptEpisode;
	/**
	 * Its agents' replies that arrived while this run was interrupted (the
	 * maintainer's rule, 2026-08-29: an interrupted agent is woken by nothing
	 * on its own). Appended to its transcript ahead of its next turn, whoever
	 * starts it (agents/session.ts sendToRun).
	 */
	pendingDeliveries?: { customType: string; content: string; display: boolean; details?: Record<string, unknown> }[];
	/** Resolves the team hold at once (holdForTeam races on it) — set by interruptRun. */
	holdWake?: () => void;
	/**
	 * Tool results of the turn in flight, by toolCallId (agents/stream.ts).
	 * pi appends a batch's results to the agent's messages only once the
	 * whole batch has run, so a run view built from session.messages showed
	 * a receipt that came back in milliseconds as `starting agent |` for
	 * the length of the slowest call beside it (2026-08-29). Main reads its
	 * tools from pi's per-tool events; this is the same source for a child.
	 */
	liveToolResults?: Map<string, unknown>;
}

/**
 * Whether a delivery to this run must WAIT instead of waking it: the user
 * interrupted it and it has not been driven since (idle inside the
 * interrupt episode), or the interrupt is still unwinding. The next turn on
 * it — the user's follow-up or its principal's message — takes the parked
 * deliveries first.
 */
export function parkedForInterrupt(rec: RunRecord | undefined): boolean {
	const ep = rec?.interrupt;
	if (!rec || !ep) return false;
	if (ep.phase === "unwinding") return true;
	return ep.phase === "idle" && rec.run.status === "idle";
}

export interface InterruptEpisode {
	phase: "unwinding" | "idle" | "noticed";
	/** When the episode was (re)armed; the notice timer's key. */
	at: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Delivers the user's follow-up reply to the principal (tools/agent.ts armInterruptFollowUp). */
	onFollowUp?: () => void;
}

/** End the episode: the timer dies, nothing is parked, nothing reports. */
export function closeInterrupt(rec: RunRecord): void {
	if (rec.interrupt?.timer) clearTimeout(rec.interrupt.timer);
	rec.interrupt = undefined;
}

export const registry = new Map<string, RunRecord>();

// Flat index of every run this session knows about: live records plus
// manifests from earlier processes, loaded ONCE at session_start. The
// transcript tree and the status strip read this, so rendering never
// touches the disk (the pager taught us what filesystem calls on the
// render path cost).
export const knownRuns = new Map<string, SubagentRun>();

export function indexRun(run: SubagentRun) {
	knownRuns.set(run.id, run);
}

/** Is the process that owned a run still alive? */
export function pidAlive(pid?: number): boolean {
	if (!pid) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means it exists but belongs to someone else.
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

export function loadKnownRuns() {
	for (const m of listManifests()) {
		if (knownRuns.has(m.id)) continue;
		// A run marked "running" whose owning process is gone cannot still
		// be running — pi was killed, or quit before it could settle. Left
		// alone it shows as running forever, survives restarts, and cannot
		// be stopped because no controller exists in THIS process.
		// Keyed on pid rather than "not in our registry" so a second,
		// concurrently-running pi does not reap the first one's work.
		if ((m.status === "working" || m.status === "queued") && !pidAlive(m.pid)) {
			// A session end is a STOP, not a failure (2026-08-29, the
			// maintainer): the run can be continued, and red is for errors.
			m.status = "stopped";
			m.error = "stopped by pi exiting";
			// NOT Date.now(): the run died whenever its process did, which
			// may have been days ago. Dating the end at the moment we
			// happen to notice reported a five-second run as "3d 4h".
			// The transcript's last write is the closest thing to a time of
			// death we have; the manifest's own mtime is the fallback, and
			// the start time the floor.
			m.endedAt = m.endedAt ?? lastWriteAt(m);
			writeManifest(m);
		}
		knownRuns.set(m.id, m);
	}
}

/** When this run's files were last touched — its best available end time. */
function lastWriteAt(run: SubagentRun): number {
	let newest = 0;
	for (const f of [transcriptFor(run), path.join(run.sessionDir, "run.json")]) {
		if (!f) continue;
		try {
			newest = Math.max(newest, fs.statSync(f).mtimeMs);
		} catch {}
	}
	return newest > run.startedAt ? newest : run.startedAt;
}

/**
 * The transcript a run must be CONTINUED from.
 *
 * `sessionFile` is written onto the manifest once the child session exists,
 * but a run from an older war-dogs — or one killed between mkdir and the
 * first write — has none. Both continue paths used to read `run.sessionFile`
 * directly and fall back to `SessionManager.create()`, which starts a BLANK
 * conversation in the same directory: the child answers with no memory of
 * its task and the real transcript is orphaned beside the new one.
 *
 * The transcript is the run, so it is found the way a human would: the file
 * the manifest names, else the newest `.jsonl` in the run's own directory.
 * When there is none, callers must REFUSE rather than start blank.
 */
export function transcriptFor(run: SubagentRun): string | undefined {
	if (run.sessionFile) return run.sessionFile;
	let newest: { file: string; mtime: number } | undefined;
	try {
		for (const f of fs.readdirSync(run.sessionDir)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = path.join(run.sessionDir, f);
			try {
				const mtime = fs.statSync(full).mtimeMs;
				if (!newest || mtime > newest.mtime) newest = { file: full, mtime };
			} catch {}
		}
	} catch {}
	return newest?.file;
}

/** Every descendant of a run, transitively, by the index. */
export function descendantRuns(id: string, seen = new Set<string>()): SubagentRun[] {
	if (seen.has(id)) return [];
	seen.add(id);
	const out: SubagentRun[] = [];
	for (const k of childrenOf(id)) out.push(k, ...descendantRuns(k.id, seen));
	return out;
}

/**
 * THE USER'S INTERRUPT (2026-08-28, the maintainer's design): Esc in a
 * run's view ends its CURRENT turn only — the run stays alive and idle,
 * its own agents keep working, and the principal is not told at once;
 * the run's reply says so at once ("was interrupted by the user", 2026-08-29:
 * the maintainer's revision, every interruption reports back) and its
 * later replies count them. With `team`, its agents are stopped too. The run controller is untouched:
 * it is the subtree's teardown signal, and this is not a stop. The owner
 * path (tools/agent.ts, agents/session.ts) reads `userInterrupted` and
 * settles the run idle without delivering.
 */
export function interruptRun(
	runId: string,
	opts: { team: boolean },
): { result: "interrupted" | "idle" | "none"; teamStopped: number } {
	const rec = registry.get(runId);
	if (!rec) return { result: "none", teamStopped: 0 };
	// How many of its agents alt+x actually stopped: the notice says that
	// number, never "its agents stopped" for a run that had none (2026-08-29).
	let teamStopped = 0;
	if (opts.team)
		for (const k of descendantRuns(runId))
			if (
				(k.status === "working" || k.status === "queued") &&
				abortRun(k.id, abortCause("stopped", "stopped by the user"))
			)
				teamStopped++;
	const done = (result: "interrupted" | "idle") => ({ result, teamStopped });
	if (rec.run.status !== "working") return done("idle");
	// A run HELD for its team (its turn is over, it waits on its agents — the
	// lead rule) is interrupted too: the wait is what Esc ends. The hold
	// releases at once and the owner path settles it idle inside the episode
	// (2026-08-29: Esc on a held lead used to answer "nothing to interrupt").
	if (rec.holding && !rec.session?.isStreaming) {
		rec.userInterrupts = (rec.userInterrupts ?? 0) + 1;
		rec.interrupt = { ...(rec.interrupt ?? { at: Date.now() }), phase: "unwinding" };
		rec.holdWake?.();
		return done("interrupted");
	}
	if (!rec.session || !rec.session.isStreaming) return done("idle");
	rec.userInterrupts = (rec.userInterrupts ?? 0) + 1;
	// Re-interrupting inside an open episode keeps its route and its key: a
	// later follow-up still reports, the notice still fires on its own clock.
	rec.interrupt = { ...(rec.interrupt ?? { at: Date.now() }), phase: "unwinding" };
	try {
		void rec.session.abort?.();
	} catch {}
	return done("interrupted");
}

/** Direct children of a run, oldest first (invocation order). */
export function childrenOf(id: string): SubagentRun[] {
	const out: SubagentRun[] = [];
	for (const r of knownRuns.values()) if (r.parentId === id) out.push(r);
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Every descendant beneath a run — children, grandchildren, all of it. */
export function descendantCount(id: string, seen = new Set<string>()): number {
	if (seen.has(id)) return 0;
	seen.add(id);
	let n = 0;
	for (const k of childrenOf(id)) n += 1 + descendantCount(k.id, seen);
	return n;
}

/** Runs owned by this session, for the status strip. */
export function runsForOwner(owner: string | null): SubagentRun[] {
	const out: SubagentRun[] = [];
	for (const r of knownRuns.values()) if (!owner || r.ownerSession === owner) out.push(r);
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

export function writeManifest(run: SubagentRun) {
	try {
		fs.mkdirSync(run.sessionDir, { recursive: true });
		fs.writeFileSync(path.join(run.sessionDir, "run.json"), JSON.stringify(run));
	} catch {}
}

export function record(run: SubagentRun, controller: AbortController): RunRecord {
	run.pid = process.pid;
	const rec: RunRecord = { run, controller, liveText: "", activity: [] };
	registry.set(run.id, rec);
	indexRun(run);
	writeManifest(run);
	return rec;
}

/**
 * Mark a run finished and RELEASE its session.
 *
 * A settled session was only ever kept resident for two reasons: to
 * answer getSessionStats() for the run footer, and to make a later chat
 * instant. The first is solved by snapshotting the stats onto the
 * manifest here; the second by ensureSession(), which rebuilds from the
 * session file on demand in ~40ms. Everything else the views need
 * already falls back to reading the transcript file.
 *
 * So memory is now O(runs actually working), not O(runs ever spawned) —
 * no cap to tune, and a workflow spawning 20 agents holds 20 sessions
 * only while they are genuinely running.
 */
/** Concurrency owner key: the parent run, else the owning session. */
export function slotKeyOf(run: SubagentRun): string {
	return run.parentId ?? `session:${run.ownerSession ?? ""}`;
}

export function settle(rec: RunRecord, status: SubagentRun["status"], error?: string) {
	// Idempotent by contract. releaseSession() disposes the AgentSession,
	// and disposing one twice — or disposing one another path is still
	// awaiting — detaches the subscription that persists turns. Belt and
	// braces with the ownership rule in promptRun().
	if (rec.run.status !== "working" && rec.run.status !== "queued") return;
	clearTimeout(rec.timer);
	rec.timer = undefined;
	rec.run.status = status;
	rec.run.endedAt = Date.now();
	if (error) rec.run.error = error;
	if (rec.slotHeld) {
		rec.slotHeld = false;
		releaseSlot(slotKeyOf(rec.run));
	}
	try {
		rec.run.stats = rec.session?.getSessionStats?.() ?? rec.run.stats;
	} catch {}
	// Context fill and compaction count die with the released session —
	// snapshot them here or status/replies on idle runs have nothing.
	try {
		const u = rec.session?.getContextUsage?.();
		if (u && typeof u.contextWindow === "number")
			rec.run.context = { tokens: u.tokens ?? null, window: u.contextWindow, percent: u.percent ?? null };
	} catch {}
	try {
		const msgs = rec.session?.messages;
		if (Array.isArray(msgs))
			rec.run.compactions = msgs.filter((m: { role?: string }) => m?.role === "compactionSummary").length;
	} catch {}
	snapshotSession(rec, rec.session);
	indexRun(rec.run);
	writeManifest(rec.run);
	releaseSession(rec);
	// The turn is over for whoever joined it (rec.turnDone).
	const resolve = rec.resolveTurn;
	rec.resolveTurn = undefined;
	resolve?.();
}

/**
 * Arm THIS turn's timeout from the run's config. Per turn (2026-08-28, the
 * maintainer's ruling on B4: a worker re-tasked ten times had a timeout on
 * turn one), and armed once WORK starts, never while queued (A9: the
 * timer used to count the wait for a slot and killed runs unstarted).
 * Cleared at settle; a fresh owner turn re-arms.
 */
export function armTimeout(rec: RunRecord): void {
	clearTimeout(rec.timer);
	rec.timer = undefined;
	const s = rec.run.config?.timeout_s;
	if (s === undefined) return;
	const controller = rec.controller;
	rec.timer = setTimeout(
		() => {
			try {
				controller.abort(abortCause("timeout", `timed out after ${s}s`));
			} catch {}
		},
		Math.max(1, s) * 1000,
	);
	(rec.timer as { unref?: () => void }).unref?.();
}

/** Arm a fresh per-turn completion promise on the record (owner-turn start). */
export function beginTurn(rec: RunRecord): void {
	rec.resolveTurn?.();
	rec.turnDone = new Promise<void>((resolve) => (rec.resolveTurn = resolve));
	rec.deliveryArmed = false;
}

/**
 * What the child was ACTUALLY built with — model id, thinking level, active
 * tool names — onto the run record, so the station can show the truth for a
 * live run (and a manifest keeps it once the session is released). Called
 * on BOTH build paths (spawn in tools/subagent.ts, rehydrate in
 * agents/session.ts) right where `rec.session` is assigned, and again at
 * settle. A miss keeps what the record had.
 */
export function snapshotSession(rec: RunRecord, session: any): void {
	try {
		rec.run.model = session?.model?.id ?? rec.run.model;
		rec.run.thinking = session?.thinkingLevel ?? rec.run.thinking;
		const names = session?.getActiveToolNames?.();
		if (Array.isArray(names) && names.length) rec.run.tools = names.map(String);
	} catch {}
}

/** Drop a run's live session and stream subscription. */
function releaseSession(rec: RunRecord) {
	try {
		rec.unstream?.();
	} catch {}
	rec.unstream = undefined;
	try {
		rec.session?.dispose?.();
	} catch {}
	rec.session = undefined;
}

export function elapsedOf(run: SubagentRun): string {
	const end = run.status === "working" || run.status === "queued" ? Date.now() : (run.endedAt ?? Date.now());
	return fmtSecs(Math.max(0, Math.round((end - run.startedAt) / 1000)));
}

/**
 * Elapsed for what a run is doing RIGHT NOW. A run spawned 36 minutes
 * ago that you just sent a chat message to has been working for seconds,
 * not 36 minutes — the strip was reporting the run's total age.
 */
export function activeElapsedOf(run: SubagentRun): string {
	if (run.status !== "working") return elapsedOf(run);
	const t0 = registry.get(run.id)?.turnStartedAt ?? run.startedAt;
	return fmtSecs(Math.max(0, Math.round((Date.now() - t0) / 1000)));
}

/** The only statuses a run may carry; anything else is a corrupt manifest. */
const STATUSES: ReadonlySet<string> = new Set<AgentStatus>(["working", "queued", "idle", "stopped", "error"]);

/** Manifests from before the 2026-08-24 state rename, mapped, never rejected. */
const LEGACY_STATUS: Record<string, AgentStatus> = { running: "working", done: "idle", failed: "error" };

/** Manifests on disk, for runs from previous processes. */
export function listManifests(): SubagentRun[] {
	const out: SubagentRun[] = [];
	const seen = new Set<string>();
	for (const root of runsRoots()) {
		try {
			for (const d of fs.readdirSync(root)) {
				try {
					const m = JSON.parse(fs.readFileSync(path.join(root, d, "run.json"), "utf8"));
					// `status` is validated at the BOUNDARY, not at each reader.
					// knownRuns feeds several renderers that index status-keyed
					// maps directly (visual/tools/subagent.ts STATUS_PAINT/GLYPH),
					// and a manifest carrying an unknown status would make those
					// lookups undefined — a renderer throw that pi degrades to raw
					// output. Every manifest WE write is one of these three; this
					// guards a hand-edited or foreign file, and keeps the invariant
					// in one place rather than in every consumer.
					if (m && typeof m.status === "string" && LEGACY_STATUS[m.status]) m.status = LEGACY_STATUS[m.status];
					if (m?.id && m?.sessionDir && STATUSES.has(m.status) && !seen.has(m.id)) {
						seen.add(m.id);
						out.push(m as SubagentRun);
					}
				} catch {}
			}
		} catch {}
	}
	out.sort((a, b) => b.startedAt - a.startedAt);
	return out;
}

/**
 * Shortest fragment allowed to stand in for a run id.
 *
 * Agent ids are `agent_` + 12 url-safe characters (older manifests carry
 * `subagent_…` or pi tool-call ids `tool_…`); eight characters of one is a
 * deliberate abbreviation, anything shorter is a coincidence.
 */
const MIN_FUZZY_ID = 8;

/**
 * Resolve a run id the model handed us.
 *
 * EXACT first, always. The fuzzy pass exists because models quote a suffix
 * or the directory name instead of the id — but it used to be a bare
 * `find()`, so the FIRST manifest whose id merely ended with the string won:
 * `findRun("a")` resolved to an arbitrary run (demonstrated), and `abort`
 * or `resume` then hit a run nobody named. A fuzzy candidate must therefore
 * be specific AND unique; anything else is a question, not an answer, and
 * is thrown back at the model with the candidates so it can pick.
 */
export function findRun(id: string): SubagentRun | undefined {
	const live = registry.get(id);
	if (live) return live.run;
	// The index first (2026-08-28, A17): knownRuns holds every manifest
	// since session start, so the disk scan below is for an id written by
	// another process since then, not for every status call on a released run.
	const known = knownRuns.get(id);
	if (known) return known;
	const indexed = [...knownRuns.values()].filter(
		(m) => m.id.endsWith(id) || id.endsWith(m.id) || m.sessionDir.includes(id),
	);
	if (indexed.length === 1 && id.length >= MIN_FUZZY_ID) return indexed[0];
	const all = listManifests();
	const exact = all.find((m) => m.id === id);
	if (exact) return exact;
	const candidates = all.filter((m) => m.id.endsWith(id) || id.endsWith(m.id) || m.sessionDir.includes(id));
	if (!candidates.length) return undefined;
	if (candidates.length === 1 && id.length >= MIN_FUZZY_ID) return candidates[0];
	throw new Error(
		(id.length < MIN_FUZZY_ID
			? `"${id}" is too short to name a run — use at least ${MIN_FUZZY_ID} characters of the id. It matches ${candidates.length} run${candidates.length > 1 ? "s" : ""}:\n`
			: `Ambiguous run id "${id}" — it matches ${candidates.length} run${candidates.length > 1 ? "s" : ""}. Use the full id from the result trailer:\n`) +
			candidates
				.slice(0, 8)
				.map((m) => `${m.id} — ${m.agent} · ${m.title} (${m.status})`)
				.join("\n"),
	);
}
/**
 * Why a run was aborted, carried ON the abort itself.
 *
 * `AbortController.abort()` takes a reason and `signal.reason` hands it
 * back, which is the only way the completion path can tell a timeout from a
 * user's ✕ from a parent tearing down its subtree — they are three
 * different sentences to the model and were all reported as "aborted".
 * Read back duck-typed rather than with `instanceof`, so a cause that
 * crossed a module boundary (or a plain object) still classifies.
 */
export type AbortKind = "timeout" | "stopped" | "parent";

export function abortCause(kind: AbortKind, message: string): Error {
	return Object.assign(new Error(message), { runAbortKind: kind });
}

export function abortKindOf(signal: AbortSignal | undefined): AbortKind | undefined {
	return (signal?.reason as { runAbortKind?: AbortKind } | undefined)?.runAbortKind;
}

/**
 * WHO aborted the turn a tool was running in, as the phrase that completes
 * its abort sentence ("Command aborted by the user"). The maintainer's rule
 * (2026-08-29): the model is told who interrupted it in the abort artefact
 * itself, never in a later prompt. Resolved from the tool's ctx: a child's
 * session maps to its run record (the interrupt flag, else the controller's
 * cause); main's aborts are the user's.
 */
export function abortedBy(ctx: unknown): string {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.();
		if (!id) return "the user";
		for (const rec of registry.values()) {
			let sid: string | undefined;
			try {
				sid = rec.session?.sessionManager?.getSessionId?.();
			} catch {}
			if (sid !== id) continue;
			if (rec.interrupt?.phase === "unwinding") return "the user";
			return whoStopped(stopCauseOf(rec), rec.run, { reader: "self" });
		}
	} catch {}
	return "the user";
}

/** The run's stop cause as recorded: the controller's reason while it lives, the manifest's error after. */
export function stopCauseOf(rec: RunRecord): string {
	const live = (rec.controller.signal.reason as { message?: string } | undefined)?.message;
	return String(live ?? rec.run.error ?? "");
}

/**
 * WHO a stop cause names, as the phrase after "by". The causes are written
 * in one grammar at every abort site — "stopped by the user" (the station's
 * ✕, ctrl+alt+x, alt+x's team), "stopped by the agent that started it" (the
 * tool's stop), "timed out after Ns", "stopped with its principal (<the
 * principal's cause>)" (the subtree teardown forwards the cause it was
 * given), "stopped by the session ending (/reason)" / "stopped by pi exiting" — so
 * one reader answers for every text: a child's `Command aborted by …`, the
 * wait's and ask's abort lines, the delivery's "was stopped by … after".
 */
/**
 * A session end in a stop cause, in the one grammar ("stopped by the session
 * ending (/reload)", "stopped by pi exiting") or the pre-2026-08-29 form still
 * on older manifests ("interrupted (session reload)", "interrupted (pi
 * exited)"); unanchored, since a worker stopped with its lead carries the
 * wrapped cause. Returns the reason word ("reload" | … | "pi exited").
 */
export const SESSION_END =
	/stopped by the session ending \(\/(\w+)\)|interrupted \(session (\w+)\)|stopped by pi exiting|interrupted \(pi exited\)/;
export function sessionEndReason(cause: string | undefined): string | undefined {
	const m = SESSION_END.exec(String(cause ?? ""));
	if (!m) return undefined;
	return m[1] ?? m[2] ?? "pi exited";
}

/** Who reads a stop sentence: the stopped run itself, or its principal (main when `readerId` is null). */
export type StopReader = { reader: "self" } | { reader: "principal"; readerId: string | null };

/** The stopper named by a cause written as "stopped by agent <id>" / "stopped by the main agent"; null for main, undefined when no agent. */
function stopperOf(cause: string): string | null | undefined {
	const m = /stopped by agent (\S+)/.exec(cause);
	if (m) return m[1];
	if (/stopped by the main agent|by the parent agent|by the agent that started it/.test(cause)) return null;
	return undefined;
}

/**
 * WHO a stop cause names, as the phrase after "by", RELATIVE TO ITS READER
 * (the maintainer, 2026-08-29: main reading "stopped by the agent that
 * started it" about its own stop must read "stopped by you"). The causes
 * are written in one grammar at every abort site: "stopped by the user"
 * (the station's ✕, ctrl+alt+x, alt+x's team), "stopped by agent <id>" /
 * "stopped by the main agent" (the tool's stop, naming the stopper),
 * "timed out after Ns", "stopped with its principal (<the principal's
 * cause>)" (the subtree teardown forwards the cause it was given),
 * "stopped by the session ending (/reason)" / "stopped by pi exiting". One reader
 * answers for every text: a child's `Command aborted by …`, the wait's and
 * ask's abort lines, the delivery's "was stopped by … after".
 */
export function whoStopped(cause: string, run: SubagentRun | undefined, view: StopReader): string {
	const c = String(cause ?? "");
	const self = view.reader === "self";
	const inner = /with its principal \((.*)\)$/.exec(c)?.[1];
	if (inner !== undefined) {
		const principal = self ? "your principal" : "its principal";
		if (/by the user/.test(inner)) return `the user, who stopped ${principal}`;
		if (/timed out/.test(inner)) return `${principal}'s timeout`;
		if (SESSION_END.test(inner) || /with its principal/.test(inner)) return whoStopped(inner, run, view);
		const st = stopperOf(inner);
		if (st === undefined) return principal;
		if (!self && st === view.readerId) return `you, who stopped ${principal}`;
		return `${st === null ? "the main agent of the session" : `agent ${st}`}, who stopped ${principal}`;
	}
	if (/by the user/.test(c)) return "the user";
	const st = stopperOf(c);
	if (st !== undefined) {
		if (self)
			return st === (run?.parentId ?? null)
				? "the agent that started you"
				: st === null
					? "the main agent of your session"
					: `agent ${st}`;
		if (st === view.readerId) return "you";
		return st === (run?.parentId ?? null)
			? "the agent that started it"
			: st === null
				? "the main agent of the session"
				: `agent ${st}`;
	}
	if (/timed out/.test(c)) return self ? "your timeout" : "its timeout";
	const end = sessionEndReason(c);
	if (end) return end === "pi exited" ? "pi exiting" : `the session ending (/${end})`;
	return self ? "your principal" : "its principal";
}

/**
 * Stop a run and, through its linked controller, everything beneath it.
 *
 * Signals the controller and nothing else. It deliberately does NOT
 * settle here: settle() releases the session, and disposing an
 * AgentSession while its prompt() is still unwinding tears down that
 * session's extension runner mid-flight. The run's own completion path
 * settles it a moment later, which also avoids settling twice.
 *
 * Abort is one-directional by construction — a child links to its
 * parent's signal, never the reverse — so stopping a subagent never
 * touches the turn that spawned it.
 */
/**
 * The session end a stop cause records, as the short reason the user's
 * surfaces show beside "stopped" (the station row, list, status):
 * "the session ended (/reload)" | "pi exited"; undefined for any other stop.
 */
export function sessionEndOf(cause: string | undefined): string | undefined {
	const c = String(cause ?? "");
	const end = sessionEndReason(c);
	if (!end) return undefined;
	return end === "pi exited" ? "pi exited" : `the session ended (/${end})`;
}

/** Whether a run's team is still at work (any descendant working or queued). */
export function teamWorking(runId: string): boolean {
	return descendantRuns(runId).some((k) => k.status === "working" || k.status === "queued");
}

export function abortRun(runId: string, reason?: unknown): boolean {
	const rec = registry.get(runId);
	if (rec) {
		// A run whose TEAM still works is working in the hierarchy (the
		// maintainer, 2026-08-29): the station's ✕ and ctrl+alt+x stop it and
		// everything under it, so an idle lead with running workers stops
		// them, with the same cause; only a purely idle run is a no-op.
		if (rec.run.status !== "working" && rec.run.status !== "queued") {
			let any = false;
			for (const k of descendantRuns(runId))
				if ((k.status === "working" || k.status === "queued") && abortRun(k.id, reason)) any = true;
			return any;
		}
		// Stop means stop (2026-08-28, the maintainer's ruling on A3): pi's
		// abort() ends the active loop only and then CONTINUES on any queued
		// steer under a fresh controller, so a stopped run answered the steer
		// and was reported "was stopped" afterwards. Clear the queues first;
		// what was dropped is counted for the reply.
		let dropped = rec.pendingSteers?.length ?? 0;
		rec.pendingSteers = [];
		try {
			const q = rec.session?.clearQueue?.() as { steering?: unknown[]; followUp?: unknown[] } | undefined;
			dropped += (q?.steering?.length ?? 0) + (q?.followUp?.length ?? 0);
		} catch {}
		rec.droppedOnStop = (rec.droppedOnStop ?? 0) + dropped;
		try {
			rec.controller.abort(reason ?? abortCause("stopped", "stopped"));
		} catch {}
		return true;
	}
	// No live record: a leftover from a previous process. There is nothing
	// to signal, but the row is still shown as running — so settle the
	// manifest instead of leaving the user with a button that does nothing.
	const run = knownRuns.get(runId);
	if (!run || (run.status !== "working" && run.status !== "queued")) return false;
	// …unless the process that owns it is still alive. Two pi sessions can
	// see each other's runs (the station scans every root), and marking a
	// live run "interrupted" from over here would be a lie that its own
	// process then overwrites — the same reason loadKnownRuns() reaps on
	// pid, not on "not in our registry". Nothing to signal, so refuse.
	if (pidAlive(run.pid)) return false;
	run.status = "stopped";
	run.error = "stopped by pi exiting";
	run.endedAt = Date.now();
	writeManifest(run);
	return true;
}

export function statsFor(runId: string): any | undefined {
	// Live session first (a running run has fresher numbers), then the
	// snapshot taken at settle.
	try {
		const live = registry.get(runId)?.session?.getSessionStats?.();
		if (live) return live;
	} catch {}
	return knownRuns.get(runId)?.stats;
}

export function sessionFor(runId: string): any | undefined {
	return registry.get(runId)?.session;
}

/** The assistant message currently streaming for a run, if any. */
export function liveMessageFor(runId: string): any | undefined {
	return registry.get(runId)?.streamMsg;
}

/** Elapsed for the CURRENT turn, falling back to the run's own start. */
export function turnStartFor(runId: string): number | undefined {
	const rec = registry.get(runId);
	return rec?.turnStartedAt ?? rec?.run.startedAt;
}
