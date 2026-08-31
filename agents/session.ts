/**
 * Building, rehydrating and talking to child AgentSessions.
 *
 * Subagents run IN-PROCESS rather than as `pi --mode rpc` children:
 * ~44ms to spawn instead of ~400ms, a live SessionManager the views read
 * directly, linked AbortControllers instead of process-group kills, and
 * real per-invocation config because the SDK takes model/tools/cwd as
 * arguments instead of CLI flags.
 *
 * A settled run's session IS released (run.ts settle() -> releaseSession),
 * because the two things that kept it resident are both solved otherwise:
 * the footer's numbers are snapshotted onto the manifest at settle, and a
 * later chat rebuilds the session from its transcript in ~40ms via
 * ensureSession(). Memory is therefore O(runs actually working).
 *
 * What must NOT happen is disposing a session while its prompt() is still
 * unwinding: dispose() detaches the subscription that persists turns, so a
 * disposed session still answers prompt() but writes nothing, and the reply
 * never reaches the view. Always let the abort settle first.
 */

import { childProjectTrusted } from "../settings.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./config.ts";
import type { RunConfig } from "./run.ts";
import {
	agentDir,
	armTimeout,
	beginTurn,
	findRun,
	indexRun,
	knownRuns,
	parkedForInterrupt,
	registry,
	settle,
	transcriptFor,
	writeManifest,
	snapshotSession,
	closeInterrupt,
} from "./run.ts";
import type { Party, RunRecord } from "./run.ts";
import { appendStamp } from "../util/stamp.ts";
import { attachStream } from "./stream.ts";
import { childExtraTools, stockTrimExclusions } from "./childtools.ts";
import { childAppendPrompt, childBasePrompt, childExchangeRider, riderFactsOf } from "../prompt/child-base.ts";

/** Model registry, handed over at session_start so rehydration can resolve ids. */
let modelRegistry: any;
export function setModelRegistry(reg: any) {
	modelRegistry = reg;
}
/** For ask's bare completion (tools/agent.ts) — never a globalThis handle. */
export function getModelRegistry(): any {
	return modelRegistry;
}

/**
 * pi-ai's bare completion (`completeSimple`), loaded from the running pi
 * by absolute path — the jiti alias covers `@earendil-works/pi-ai`, not
 * its subpaths. Shared by ask (tools/agent.ts) and the peer ask handler
 * (agents/peers.ts). Upgrade Contract reach.
 */
export async function piAiCompat(): Promise<any> {
	// 0.84.3 first (pre-sweep 2026-08-25): the extension loader resolves
	// `@earendil-works/pi-ai` to the COMPAT entrypoint ("a strict superset
	// of the core entrypoint") through its virtual-module map, so the bare
	// import IS compat — and the same module instance the running pi uses.
	// On 0.83 the alias resolves to pi-ai's index, which has no
	// completeSimple, so the check falls through to the path walk below.
	try {
		const m = await import("@earendil-works/pi-ai");
		if (typeof (m as any)?.completeSimple === "function") return m;
	} catch {}
	// 0.83's shape: `<pi>/dist/cli.js` beside `<pi>/node_modules/…`. The
	// bundle's argv[1] (`dist/bundle/cli.js`) resolves one level deeper, so
	// walk up until a node_modules candidate exists.
	const bin = fs.realpathSync(process.argv[1]);
	for (const root of [path.resolve(path.dirname(bin), ".."), path.resolve(path.dirname(bin), "..", "..")]) {
		for (const cand of [
			path.join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
			path.resolve(root, "..", "pi-ai", "dist", "compat.js"),
		]) {
			try {
				if (fs.existsSync(cand)) return await import(cand);
			} catch {}
		}
	}
	throw new Error("ask is unavailable: pi-ai's completion API was not found beside the running pi.");
}

/**
 * The parent's ModelRuntime, reached through a PRIVATE field of pi's
 * ModelRegistry (`runtime` on every pi since 0.81; no public accessor).
 * Both child paths pass this to createAgentSession so a child shares the
 * parent's runtime — auth, provider config, compat state — instead of
 * getting a fresh one.
 *
 * If the reach misses, nothing errors: createAgentSession quietly builds a
 * fresh runtime from <agentDir>/auth.json and children still answer — the
 * original `modelRuntime` spelling missed on every pi it ever ran against
 * and no behavioural probe could see it. That is why this is a named
 * helper with an Upgrade Contract probe (see README) that checks the FIELD,
 * not the behaviour. `modelRuntime` is kept as a fallback spelling in case
 * pi renames the field back.
 */
export function sharedModelRuntime(reg: unknown): unknown {
	const r = reg as { runtime?: unknown; modelRuntime?: unknown } | undefined;
	return r?.runtime ?? r?.modelRuntime;
}

/**
 * Injected by index.ts to avoid a tools -> agents -> tools cycle: ONE
 * builder of a run's child `agent` tool, from the run RECORD (2026-08-28,
 * A11: the spawn and rehydrate paths built it with different arguments —
 * unstamped on one, no parent signal and no own concurrency on the other).
 */
let childToolFactory: ((rec: RunRecord) => ToolDefinition<any, any, any>) | undefined;
export function setChildToolFactory(fn: typeof childToolFactory) {
	childToolFactory = fn;
}
/**
 * The notice a CONTINUED run reads ahead of its turn about its own agents
 * that died with a session end (tools/interrupted.ts, wired by index.ts —
 * agents/ cannot import tools/). Main has had the same notice at its next
 * prompt since 2026-08-28; a lead messaged after a /reload knew nothing of
 * its dead workers until 2026-08-29.
 */
type ContinueNotice = { customType: string; content: string; display: boolean; details?: Record<string, unknown> };
let continueNotice: ((runId: string) => ContinueNotice | undefined) | undefined;
export function setContinueNotice(fn: typeof continueNotice) {
	continueNotice = fn;
}

function resolveModelById(spec: string | undefined) {
	if (!spec) return undefined;
	try {
		const reg = modelRegistry;
		if (!reg) return undefined;
		if (spec.includes("/")) {
			const i = spec.indexOf("/");
			const found = reg.find?.(spec.slice(0, i), spec.slice(i + 1));
			if (found) return found;
		}
		const available = reg.getAvailable?.() ?? [];
		return available.find((m: any) => m.id === spec) ?? available.find((m: any) => String(m.id).includes(spec));
	} catch {
		return undefined;
	}
}

export function resolveModel(ctx: ExtensionContext, spec: string | undefined) {
	if (!spec) return undefined;
	const registryRef = (ctx as any)?.modelRegistry;
	if (!registryRef) return undefined;
	try {
		if (spec.includes("/")) {
			const i = spec.indexOf("/");
			const found = registryRef.find(spec.slice(0, i), spec.slice(i + 1));
			if (found) return found;
		}
		const available = registryRef.getAvailable?.() ?? [];
		return available.find((m: any) => m.id === spec) ?? available.find((m: any) => String(m.id).includes(spec));
	} catch {
		return undefined;
	}
}

/** war-dogs' own folder (agents/ is one level down), realpath'd so a symlinked install compares equal. */
const OWN_ROOT = (() => {
	const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	try {
		return fs.realpathSync(here);
	} catch {
		return here;
	}
})();

/** Whether a path lies inside war-dogs itself. */
function isOwnExtension(p: string): boolean {
	let r = path.resolve(p);
	try {
		r = fs.realpathSync(r);
	} catch {}
	return r === OWN_ROOT || r.startsWith(OWN_ROOT + path.sep);
}

/**
 * Resolve extension names to on-disk paths; absolute paths pass through.
 * war-dogs' OWN folder is refused (2026-08-28, the stress report's B16):
 * loaded into a headless child it registers a pager with no screen, a
 * second agent tool and a peer socket. `refused` names what was dropped,
 * for the run's note.
 */
export function resolveExtensionPaths(names: string[] | undefined): { paths: string[]; refused: string[] } {
	if (!names?.length) return { paths: [], refused: [] };
	const out: string[] = [];
	const refused: string[] = [];
	for (const n of names) {
		const cands: string[] = [];
		if (n.includes("/") || n.endsWith(".ts") || n.endsWith(".js")) {
			cands.push(path.resolve(n));
		} else {
			for (const base of [path.join(agentDir(), "extensions"), path.join(process.cwd(), ".pi", "extensions")]) {
				for (const cand of [path.join(base, `${n}.ts`), path.join(base, n, "index.ts")]) {
					try {
						if (fs.existsSync(cand)) {
							cands.push(cand);
							break;
						}
					} catch {}
				}
				if (cands.length) break;
			}
		}
		for (const c of cands) {
			if (isOwnExtension(c)) refused.push(n);
			else out.push(c);
		}
	}
	return { paths: [...new Set(out)], refused: [...new Set(refused)] };
}

/** How a child's turn ENDED, not just what it said. */
export interface AssistantOutcome {
	/** The last assistant text, which may be from before the failure. */
	text: string;
	/** pi's stopReason on the final assistant message: "stop" | "error" | "length" | … */
	stopReason?: string;
	/** Provider/runtime error carried by a stopReason:"error" message. */
	errorMessage?: string;
}

/**
 * Read the child's LAST WORD and how it ended.
 *
 * A turn that dies at the provider still produces an assistant message —
 * with `stopReason: "error"`, an `errorMessage`, and NO content blocks. The
 * old text-only read returned "" for it, and both call sites translated ""
 * into "(no output)" on a run they then settled as `done`: a 401, a context
 * overflow or a truncation was reported to the parent model as a subagent
 * that simply had nothing to say. The stop reason has to travel with the
 * text, so the callers can tell the difference.
 *
 * The two are read from different places on purpose: the outcome belongs to
 * the LAST assistant message, the text to the last one that actually said
 * something — "I found 3 of the 10 files…" then a 401 is partial output
 * plus a failure, and the model needs both.
 */
export function lastAssistantOutcome(session: any): AssistantOutcome {
	const out: AssistantOutcome = { text: "" };
	try {
		const msgs = session?.messages ?? [];
		let outcomeTaken = false;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m?.role !== "assistant") continue;
			if (!outcomeTaken) {
				outcomeTaken = true;
				if (m.stopReason) out.stopReason = String(m.stopReason);
				if (m.errorMessage) out.errorMessage = String(m.errorMessage);
			}
			const text = (m.content ?? [])
				.filter((b: any) => b?.type === "text")
				.map((b: any) => String(b.text ?? ""))
				.join("\n")
				.trim();
			if (text) {
				out.text = text;
				break;
			}
		}
	} catch {}
	return out;
}

/**
 * Builds in flight, keyed by run.
 *
 * ensureSession() awaits a loader reload and createAgentSession(), so two
 * calls for the SAME run — two messages sent in quick succession, since
 * promptRun is fire-and-forget — would both sail past the "already have a
 * session" check and each construct one. That is two AgentSessions writing
 * the same transcript, which is the exact shape of the corruption we could
 * never reproduce. Callers now share one build.
 */
const building = new Map<string, Promise<any | undefined>>();

/**
 * Publish a build this module did not start.
 *
 * The spawn path (tools/subagent.ts) builds its own AgentSession, and until
 * it assigns `rec.session` — a loader reload plus createAgentSession, 40ms
 * on a fresh run and hundreds of ms on a large transcript — a chat sent at
 * that run saw neither a session nor an in-flight build, so ensureSession
 * built a SECOND one over the same transcript. Two writers on one file is
 * the corruption class this map exists to prevent; it only worked for
 * builds that started HERE. The spawn path now registers its promise the
 * moment it starts, so the window is closed rather than narrowed.
 */
export function reserveSession(runId: string, build: Promise<any | undefined>): void {
	building.set(runId, build);
	void build
		.catch(() => undefined)
		.finally(() => {
			if (building.get(runId) === build) building.delete(runId);
		});
}

export async function ensureSession(runId: string): Promise<any | undefined> {
	const existing = registry.get(runId);
	if (existing?.session) {
		// A session built by execute() has no stream capture yet; attach one
		// before the first chat turn, but only once.
		if (!existing.unstream) attachStream(existing, existing.session);
		return existing.session;
	}
	const inflight = building.get(runId);
	if (inflight) return inflight;
	const build = buildSession(runId).finally(() => building.delete(runId));
	building.set(runId, build);
	return build;
}

async function buildSession(runId: string): Promise<any | undefined> {
	const run = knownRuns.get(runId) ?? findRun(runId);
	if (!run) return undefined;

	const cfg: RunConfig = {
		depth: 0,
		...(run.config ?? {}),
	};
	const def = run.agent && run.agent !== "adhoc" ? loadAgents().get(run.agent) : undefined;
	// The child's settings manager is TRUST-GATED (2026-08-27): pi's
	// default is projectTrusted TRUE, which loaded an untrusted project's
	// .pi/SYSTEM.md and settings into children — main gates these, so
	// children must too (settings.ts childProjectTrusted). Shared by the
	// loader and the session; identical to the spawn path.
	const childSettings = SettingsManager.create(cfg.cwd || process.cwd(), agentDir(), {
		projectTrusted: childProjectTrusted(cfg.cwd || process.cwd()),
	} as never);
	const loader = new DefaultResourceLoader({
		cwd: cfg.cwd || process.cwd(),
		agentDir: agentDir(),
		settingsManager: childSettings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		// Context files (AGENTS.md and friends) ARE loaded: a child working
		// in this repo must know the same house rules main does, and it has
		// no other way to learn them — it cannot see the conversation. Only
		// skills and prompt templates stay off (a child is given one task,
		// not a menu). Keep this identical to the spawn path.
		additionalExtensionPaths: resolveExtensionPaths(cfg.extensions).paths,
		// The named agent's prompt is re-declared here too. It is NOT carried
		// in the restored history — pi keeps the system prompt out of the
		// transcript and rebuilds it per session — so a rehydrated run that
		// omits it silently changes personality mid-conversation. A call's
		// own systemPrompt (persisted in run.config) wins over the named
		// agent's, and appendSystemPrompt rides on whichever base is in
		// force — identical to the spawn path in tools/agent.ts.
		...(cfg.systemPrompt
			? { systemPrompt: cfg.systemPrompt }
			: def
				? { systemPrompt: def.systemPrompt }
				: ((cb) => (cb ? { systemPrompt: cb } : {}))(childBasePrompt(cfg.cwd || process.cwd()))),
		// ALWAYS an explicit list, even empty: pi discovers APPEND_SYSTEM.md
		// only when this option is undefined, and that file is main's
		// (2026-08-28, A4). The user's child append is SUBAGENT_APPEND_SYSTEM.md
		// (prompt/child-base.ts), after the rider, before the call's own.
		appendSystemPrompt: [
			childExchangeRider(riderFactsOf(cfg)),
			childAppendPrompt(cfg.cwd || process.cwd()),
			cfg.appendSystemPrompt,
		].filter((x): x is string => !!x),
	} as never);
	// See tools/subagent.ts: a loader passed to createAgentSession is never
	// reloaded for us, and an unreloaded one reports no system prompt.
	await loader.reload();

	// CONTINUING a run means continuing its transcript. Falling back to
	// SessionManager.create() started a blank conversation in the run's own
	// directory — the child answered with no memory of the task it was
	// given, and the real transcript was orphaned beside the new one. When
	// no transcript can be found, refuse: an empty session wearing this
	// run's id is worse than an error the user can act on.
	const file = transcriptFor(run);
	if (!file) {
		throw new Error(
			`Cannot continue ${run.agent} · ${run.title}: this run's transcript is missing (nothing in ${run.sessionDir}).`,
		);
	}
	const sm = SessionManager.open(file, run.sessionDir);

	// The record FIRST: the child tool is built from it (one builder, both
	// paths), and a manifest-only run adopted here is THIS process's now —
	// its pid too (2026-08-28, A15: the dead process's pid stayed on the
	// manifest and a second pi reaped a live continued run).
	const rec: RunRecord = registry.get(runId) ?? { run, controller: new AbortController(), liveText: "", activity: [] };
	rec.run.pid = process.pid;
	registry.set(runId, rec);

	// A rehydrated session must be rebuilt with the SAME capabilities the
	// original run had. Without this it came back with no subagent tool
	// (so it reported it "cannot spawn"), and with the default model
	// rather than the one the run was configured with.
	// Injected rather than imported: tools/ depends on agents/, so agents/
	// importing tools/ back would be a cycle. index.ts wires this once.
	// Same set the run was spawned with — a resumed run that came back
	// without webfetch/kimi-websearch would silently lose capability.
	const childTools: ToolDefinition<any, any, any>[] = [
		...childExtraTools(cfg.cwd || process.cwd()),
		...(cfg.depth > 0 && childToolFactory ? [childToolFactory(rec)] : []),
	];
	// `tools` is an EXACT allowlist (2026-08-28, the maintainer's ruling on
	// the stress report's A2): the old union with every child tool name
	// made a "read-only" agent able to edit, write and run bash. pi honours
	// the allowlist on custom tools too. Identical to the spawn path.
	const tools = cfg.tools ? [...new Set(cfg.tools)] : undefined;

	const created = await createAgentSession({
		settingsManager: childSettings,
		cwd: cfg.cwd || process.cwd(),
		agentDir: agentDir(),
		// The SAME ModelRuntime the spawn path uses. Omitting it made
		// createAgentSession build a fresh one from default paths, so a
		// rehydrated run resolved its model — and its provider config, auth
		// and compat flags — through a different runtime than the session
		// that spawned it. Those compat flags are not cosmetic on this
		// provider: k3 carries allowEmptySignature and forceAdaptiveThinking,
		// which govern how thinking blocks are serialised into the request.
		// sharedModelRuntime (above) owns the private-field reach; keep this
		// call site identical to the spawn path in tools/subagent.ts.
		modelRuntime: sharedModelRuntime(modelRegistry),
		model: resolveModelById(cfg.model),
		thinkingLevel: cfg.effort as never,
		sessionManager: sm,
		resourceLoader: loader,
		...(tools ? { tools } : {}),
		...(cfg.excludeTools?.length || stockTrimExclusions().length
			? { excludeTools: [...new Set([...(cfg.excludeTools ?? []), ...stockTrimExclusions()])] }
			: {}),
		customTools: childTools,
	} as never);
	const session = (created as any).session;

	rec.session = session;
	rec.run.sessionFile ??= session?.sessionFile;
	snapshotSession(rec, session);
	attachStream(rec, session);
	registry.set(runId, rec);
	indexRun(rec.run);
	return session;
}

/**
 * How long a message that JOINS a turn waits for that turn to be streaming.
 *
 * Generous on purpose: what it waits for is another path's preflight (an
 * auth check, a compaction check, the input event), and the cost of waiting
 * is a few hundred ms of latency on a steer, while the cost of not waiting
 * was the message being thrown away.
 */
const STEER_WAIT_MS = 5_000;

/**
 * The send currently being ACCEPTED for each run.
 *
 * Two chats typed in quick succession both reach prompt() before either has
 * flipped `isStreaming`, and pi rejects the second one outright ("Agent is
 * already processing") — the typed text is simply lost. Sends are therefore
 * queued per run: each one waits until the previous has been accepted (pi's
 * `preflightResult` callback, which fires the moment the turn is really
 * under way), not until the previous turn has FINISHED, so a steer is still
 * a steer rather than a follow-up turn.
 */
const sending = new Map<string, Promise<void>>();

/** Resolves when the run is streaming, when it settles, or on the deadline. */
async function awaitTurnStart(session: any, rec: RunRecord | undefined, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!session?.isStreaming && Date.now() < deadline) {
		if (rec && rec.run.status !== "working") return;
		await new Promise((r) => setTimeout(r, 15));
	}
}

/**
 * Send a message to a run — identical in behaviour to talking to main.
 *
 * A chat you start yourself does NOT feed back into the parent conversation;
 * only work the parent delegated does.
 *
 * Concurrency mirrors pi's own interactive submit. A message sent while the
 * run is idle starts a new turn; a message sent while a turn is in flight is
 * QUEUED with `streamingBehavior: "steer"` — exactly what main does on Enter
 * (it shows "Steering: …"), and what the run view renders. The decision keys
 * off whether a turn already exists (`ownsTurn`), never off a stale
 * `isStreaming` snapshot: pi flips isStreaming only after an async preflight,
 * so a queued send that read it too early used to be mis-sent as a second
 * turn and rejected with "already processing". Because a turn is owned by
 * exactly one call (status is set to "running" synchronously), only that
 * owner settles the run — queued sends join its turn and are answered in
 * order, never dropped.
 *
 * That ownership test is necessary but not sufficient, because pi's own
 * check is `isStreaming`, and between "a turn is owned" and "the session is
 * streaming" lies the owner's whole preflight — plus, on a released run, the
 * session BUILD. A message landing in that gap was sent as a steer, found
 * nothing streaming, was promoted to a second turn by pi and rejected with
 * "Agent is already processing": the user's typed text vanished
 * (demonstrated). So a joining message now waits, bounded, for the turn it
 * is joining to start, and sends per run are serialised behind the previous
 * send's acceptance. If nothing is streaming when the wait expires there is
 * no turn to join, and this message takes the turn itself rather than being
 * dropped.
 *
 * A double-fired Enter is already inert upstream: pi clears the editor on the
 * first submit, so the second Enter submits empty and mod.ts ignores it.
 */
/** What a send carries: the user's or principal's TEXT, or a delivered custom MESSAGE (an agent's reply to its lead). */
export type SendPayload =
	| { text: string; images?: { type: "image"; mimeType: string; data: string }[]; from: Party }
	| { custom: { customType: string; content: string; display: boolean; details?: Record<string, unknown> } };

/** The run's principal: the agent that started it, else the main agent. */
export function principalOf(run: { parentId?: string | null } | undefined): Party {
	return run?.parentId ? { kind: "agent", id: run.parentId } : { kind: "main" };
}

const sameParty = (a: Party, b: Party): boolean =>
	a.kind === b.kind && (a.kind !== "agent" || b.kind !== "agent" || a.id === b.id);

/** How a sender reads to the run (the agent contract's provenance vocabulary, unchanged since 2026-08-24). */
export function senderName(from: Party, run: { parentId?: string | null } | undefined): string {
	if (from.kind === "user") return "your user";
	if (from.kind === "main") return "the main agent of your session";
	return from.id === (run?.parentId ?? null) ? "the agent that started you" : `agent ${from.id} in your session`;
}

/** Whose turn it is, when the sender is not the one it goes back to. */
function ownerPhrase(to: Party, run: { parentId?: string | null } | undefined): string {
	if (to.kind === "main") return "this turn is still the main agent's; its final output goes back to it";
	if (to.kind === "user") return "this turn is still the user's; its final output stays with the user";
	return to.id === (run?.parentId ?? null)
		? `this turn is still the agent's; its final output goes back to it: ${to.id}`
		: `this turn is still ${to.id}'s; its final output goes back to it`;
}

/**
 * THE PROVENANCE LINE (2026-08-30, the exchange block): the first line of
 * every message after the task names the sender and states where THIS
 * turn's final output goes — the facts the maintainer set; the receiver is
 * decided in sendToRun, where the turn is known to be owned, joined or
 * held. The task itself arrives unmarked.
 */
export function provenanceLine(from: Party, to: Party, run: { parentId?: string | null } | undefined): string {
	const who = senderName(from, run);
	if (from.kind === "user") {
		if (to.kind === "user") return `[from ${who} • your final output stays with the user]`;
		return `[from ${who} • ${ownerPhrase(to, run)}]`;
	}
	if (sameParty(from, to)) {
		if (to.kind === "main") return `[from ${who} • your final output goes back to the main agent]`;
		return `[from ${who} • your final output goes back to it: ${(to as { id: string }).id}]`;
	}
	return `[from ${who} • ${ownerPhrase(to, run)}]`;
}

/** The message as the run reads it: the provenance line, the body, the stamp (util/stamp.ts, the model's clock). */
function withProvenance(payload: SendPayload, to: Party, run: { parentId?: string | null } | undefined): SendPayload {
	if (!("text" in payload)) return payload;
	return { ...payload, text: appendStamp(`${provenanceLine(payload.from, to, run)}\n\n${payload.text}`) };
}

/**
 * A message to a run: the BODY and who sends it (`from`). The provenance
 * line and the stamp are composed in sendToRun once the turn's receiver is
 * known (2026-08-30); callers never prepend either.
 */
export async function promptRun(
	runId: string,
	text: string,
	images: { type: "image"; mimeType: string; data: string }[] | undefined,
	opts: { from: Party; onAccepted?: (ownsTurn: boolean) => void; followUp?: boolean },
): Promise<void> {
	return sendPayload(runId, { text, from: opts.from, ...(images?.length ? { images } : {}) }, opts);
}

/**
 * Deliver an agent's REPLY to the run that started it (2026-08-28, the
 * lead rule): a steer when that run's session is streaming, a turn of its
 * own otherwise — the rule main's deliveries follow. Resolves when the
 * woken turn ends (a steer resolves at once; the turn it joins covers it).
 * The lead's owner path holds on these (rec.wakes) before it settles.
 */
export async function deliverToRun(
	runId: string,
	msg: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
	from: Party,
): Promise<void> {
	// An INTERRUPTED run is woken by nothing on its own (the maintainer's
	// rule, 2026-08-29): while it is idle inside the interrupt episode, or
	// the interrupt is still unwinding, its agents' replies wait on the record
	// and are appended ahead of its next turn — the user's follow-up or its
	// principal's message — in sendToRun. Before this a worker finishing after
	// Esc or alt+x started a turn on the interrupted lead (demonstrated in
	// the harness: alt+x, then "Got the background result" from a lead the
	// user had just stopped).
	const rec = registry.get(runId);
	if (parkedForInterrupt(rec)) {
		(rec!.pendingDeliveries ??= []).push(msg);
		return;
	}
	return sendPayload(runId, { custom: msg }, { from });
}

async function sendPayload(
	runId: string,
	payload: SendPayload,
	opts: { from: Party; onAccepted?: (ownsTurn: boolean) => void; followUp?: boolean },
): Promise<void> {
	// A QUEUED run has no session and no transcript yet (it builds when a
	// slot frees), so there is nothing to send to. Hold the message on the
	// record; doRun hands it over as a steer the moment the task turn is
	// under way. It joins the run's own turn, so that turn's delivery
	// covers it (2026-08-25: this used to throw "transcript is missing"
	// into a swallowed catch — Delivered, and nothing was).
	const queued = registry.get(runId);
	if (queued?.run.status === "queued" && "text" in payload) {
		(queued.pendingSteers ??= []).push({
			text: payload.text,
			from: payload.from,
			...(payload.images?.length ? { images: payload.images } : {}),
		});
		try {
			opts?.onAccepted?.(false);
		} catch {}
		return;
	}
	const session = await ensureSession(runId);
	if (!session) throw new Error(`No such agent: ${runId}`);
	const previous = sending.get(runId);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	sending.set(runId, gate);
	let acceptFired = false;
	// Fires on GENUINE acceptance only — pi's preflightResult(true). A send
	// that fails before then rejects instead, so the caller can tell "your
	// message is in" from "it never got in" (2026-08-25: the finally used
	// to report every failure as a joined steer, and the message path
	// answered Delivered to a message that was never sent).
	const accept = (ownsTurn: boolean) => {
		release();
		if (acceptFired) return;
		acceptFired = true;
		try {
			opts?.onAccepted?.(ownsTurn);
		} catch {}
	};
	try {
		// Never rejects: the gate is resolved in the sender's finally, so a
		// failed send releases the queue instead of wedging it.
		if (previous) await previous;
		await sendToRun(runId, session, payload, accept, opts.from, opts.followUp === true);
	} finally {
		release();
		if (sending.get(runId) === gate) sending.delete(runId);
	}
}

/** A send or build in flight for this run — wait treats it as working (stress audit #6/#13). */
export function hasPendingSend(runId: string): boolean {
	return sending.has(runId) || building.has(runId);
}

async function sendToRun(
	runId: string,
	sessionIn: any,
	payload: SendPayload,
	accepted: (ownsTurn: boolean) => void,
	from: Party,
	followUp = false,
): Promise<void> {
	let session = sessionIn;
	const rec = registry.get(runId);
	const origin: "principal" | "user" = from.kind === "user" ? "user" : "principal";
	// A run HELD for its team (the lead rule: its owner turn is over, its
	// agents still work, status stays working) is idle at the session: a
	// delivery or a chat starts a turn on it, and the holder — still awaiting
	// rec.wakes — covers it. Never a join: nothing streams to join.
	// …unless the user just interrupted the hold: the owner path is settling
	// the run idle, and this send takes the next turn itself (below).
	const held = !!rec?.holding && !session?.isStreaming && rec?.interrupt?.phase !== "unwinding";
	// Is a turn ALREADY in flight for this run? If so this message just
	// joins its queue and that turn stays the owner: it keeps its
	// controller, its clock, and — critically — the sole right to settle.
	//
	// Without this check two completion paths ran against one session.
	// Whichever finished first called settle(), which disposes the session
	// and clears rec.session; the other was left awaiting prompt() on a
	// disposed session (persistence subscription detached, so nothing ever
	// rendered), and the next ensureSession() built a SECOND AgentSession
	// over the same session file while the first was still writing to it.
	// Two writers on one transcript is how a resumed run ends up replying
	// with garbage.
	let ownsTurn = !rec || rec.run.status !== "working";
	if (held) {
		// The holder owns settle; this turn just runs on the held session and
		// is awaited through rec.wakes (a delivery) or watched by status (a
		// chat). Counted like any turn for the notes.
		if (origin === "user") rec!.userChats = (rec!.userChats ?? 0) + 1;
		// The user's chat on a held lead flows into the holder's reply (the
		// turn that ends with an idle team is the reply); an agent's message
		// owns its own delivery (doMessage's `owns`).
		const heldTo: Party = from.kind === "user" ? (rec!.turnOutput ?? principalOf(rec!.run)) : from;
		const p = runHeldTurn(session, withProvenance(payload, heldTo, rec!.run));
		(rec!.wakes ??= new Set()).add(p);
		void p.finally(() => rec!.wakes?.delete(p));
		accepted(true);
		await p;
		return;
	}
	if (rec && !ownsTurn) {
		// Joining a turn: wait for it to actually be streaming, so pi sees a
		// steer as a steer. If nothing is streaming by the deadline the turn
		// we meant to join does not exist — take it instead of losing the
		// message.
		await awaitTurnStart(session, rec, STEER_WAIT_MS);
		ownsTurn = !session.isStreaming;
		// The turn we meant to join may have SETTLED while we waited — the
		// tail race: between the child's agent_settled (isStreaming false)
		// and the tool's settle() (session disposed), a message judged
		// "join" took the turn itself on a session that was then released:
		// pi ran it detached from persistence and the message vanished
		// (demonstrated 2026-08-25, dev/instruments/agent-scenarios.mjs tailrace). A
		// turn we take must run on the LIVE session — re-resolve it.
		if (ownsTurn && rec.session !== session) {
			const live = rec.session ?? (await ensureSession(runId));
			if (!live) throw new Error(`No such agent: ${runId}`);
			session = live;
		}
	}
	// Captured so the completion check below reads THIS turn's controller
	// even if another turn replaces rec.controller meanwhile.
	let controller: AbortController | undefined;
	if (rec && ownsTurn) {
		// A chat turn needs its OWN abort handle. The controller sitting on
		// the record belongs to the run that already finished — and is very
		// likely already aborted — so firing it does nothing at all. Without
		// a fresh one wired to THIS session, the station's ✕ and
		// subagent(abort:) both silently no-op on a run you continued
		// yourself: status stays "running" forever and nothing stops.
		controller = new AbortController();
		rec.controller = controller;
		const onAbort = () => {
			try {
				session.abort?.();
			} catch {}
		};
		if (rec.controller.signal.aborted) onAbort();
		else rec.controller.signal.addEventListener("abort", onAbort, { once: true });
		rec.run.status = "working";
		rec.run.endedAt = undefined;
		rec.droppedOnStop = 0;
		// WHO THIS TURN'S FINAL OUTPUT GOES BACK TO (2026-08-30, stated in the
		// provenance line): an agent's message owns its delivery (doMessage);
		// the user's turn stays with the user, unless it is the follow-up of
		// an interrupt episode on an agent's turn, which armInterruptFollowUp
		// delivers to that turn's receiver; a delivery-woken turn is the run's
		// reply to its principal (the lead rule). Read before closeInterrupt.
		rec.turnOutput =
			"custom" in payload
				? principalOf(rec.run)
				: from.kind !== "user"
					? from
					: rec.interrupt && rec.turnOutput && rec.turnOutput.kind !== "user"
						? rec.turnOutput
						: { kind: "user" };
		// An unwinding interrupt never owns a turn (the owner path settles
		// first); the episode stays open for the user's follow-up and the
		// principal driving again closes it without a delivery (its own reply
		// covers it).
		if (rec.interrupt?.phase === "unwinding") rec.interrupt.phase = "idle";
		if (origin === "principal") closeInterrupt(rec);
		// The principal's message resets the user-activity counts the reply
		// notes ("since your last message"); the user's own chat is counted.
		if (origin === "user") rec.userChats = (rec.userChats ?? 0) + 1;
		else {
			rec.userChats = 0;
			rec.userInterrupts = 0;
		}
		// This turn's timeout, from the run's config (per turn, 2026-08-28).
		armTimeout(rec);
		// The previous turn's completion promise is STALE the moment a new
		// turn owns the run: a wait that read it got the OLD reply while the
		// new turn visibly worked (demonstrated 2026-08-24, the user-chat
		// scenario). The new owner assigns its own at acceptance, or none —
		// wait's poll path covers a turn with no promise.
		rec.work = undefined;
		// A claim belongs to ONE turn's reply: left set, the NEXT turn's
		// delivery was skipped forever (stress audit #1, 2026-08-24 — a
		// wait, then a message: the message's reply reached the model zero
		// times).
		rec.claims = 0;
		// The delivered flag is the previous turn's too: left set, a wait on
		// the NEXT turn would point at a delivery that never happened.
		rec.deliveredTurn = false;
		// This turn's completion signal, for a joiner with no owner delivery
		// to ride on (agents/run.ts beginTurn; resolved by settle).
		beginTurn(rec);
		// liveText is the previous turn's stream; status must not show it as
		// "reply so far" on a turn that has produced nothing yet. activity
		// too — status's "last tools" was frozen at the first turn's list
		// (stress audit #10).
		rec.liveText = "";
		rec.activity = [];
		// This turn's clock, not the run's original start — otherwise a
		// run spawned an hour ago reports "1h 3m" the moment you chat.
		rec.turnStartedAt = Date.now();
		// The compaction-note baseline (tools/agent.ts COMPACTION_NOTE):
		// folds BEFORE this turn are old news; the note reports this turn's.
		try {
			const msgs = (session as { messages?: { role?: string }[] }).messages;
			rec.compactionsAtTurnStart = Array.isArray(msgs) ? msgs.filter((m) => m?.role === "compactionSummary").length : 0;
		} catch {
			rec.compactionsAtTurnStart = 0;
		}
		// Release the previous turn's partial here rather than at
		// agent_settled, so the renderer keeps something to draw right
		// through the handoff.
		rec.streamMsg = undefined;
		indexRun(rec.run);
		// The manifest MUST be written here: the pager decides whether to
		// keep repainting a run view from run status, and it reads that
		// through the manifest-backed accessor. Without this the reply
		// lands in the session but nothing on screen ever refreshes.
		writeManifest(rec.run);
	}
	// The message as the run reads it. A joiner's turn belongs to whoever
	// owns it — except an agent joining the user's turn, which arms that
	// turn's delivery for itself (doMessage) and so takes its output.
	const to: Party =
		rec && ownsTurn
			? (rec.turnOutput as Party)
			: rec
				? from.kind !== "user" && !rec.work && rec.turnDone && !rec.deliveryArmed
					? from
					: (rec.turnOutput ?? principalOf(rec.run))
				: from.kind === "user"
					? { kind: "user" }
					: from;
	const out = withProvenance(payload, to, rec?.run);
	try {
		if (rec && !ownsTurn && origin === "user") rec.userChats = (rec.userChats ?? 0) + 1;
		// Its agents that died with a session end, told once, ahead of this
		// turn (the same plain append as the parked deliveries below).
		if (rec && ownsTurn && continueNotice) {
			let notice: ContinueNotice | undefined;
			try {
				notice = continueNotice(runId);
			} catch {}
			if (notice) {
				try {
					await session.sendCustomMessage(notice, { triggerTurn: false });
				} catch {}
			}
		}
		// Deliveries parked while the run was interrupted (deliverToRun) go
		// into the transcript first, as plain custom messages on the idle
		// session (no turn of their own), so this turn reads them.
		if (rec && ownsTurn && rec.pendingDeliveries?.length) {
			for (const m of rec.pendingDeliveries.splice(0)) {
				try {
					await session.sendCustomMessage(m, { triggerTurn: false });
				} catch {}
			}
		}
		if ("custom" in payload) {
			// A delivered reply: pi's sendCustomMessage steers a streaming
			// session and, with triggerTurn, runs a turn on an idle one
			// (agent-session.js) — the same call main's deliveries use.
			// triggerTurn is ALWAYS true (2026-08-29, the real-model audit):
			// pi reads it in the streaming branch too (`isStreaming &&
			// triggerTurn !== false` is the steer), and `false` on a streaming
			// session is its fourth case — the message is deferred to the
			// turn's end and appended to the transcript, which the running
			// loop's context snapshot never sees. A lead streaming when its
			// worker replied kept the reply unread and told main the worker
			// was still working (ci `leadsteer`).
			accepted(ownsTurn);
			await session.sendCustomMessage(payload.custom, { deliverAs: "steer", triggerTurn: true });
		} else {
			// Idle → new turn. A turn already in flight → queue with steer,
			// exactly like main's Enter. Images ride the same options pi's own
			// submit path uses. `preflightResult` fires the moment pi has
			// accepted this message (queued as a steer, or the turn started),
			// which is what releases the next send.
			await session.prompt((out as { text: string }).text, {
				...(payload.images?.length ? { images: payload.images } : {}),
				// Joining a turn: a steer (Enter) or a follow-up after it
				// (alt+Enter), the two keys main has (2026-08-28).
				...(ownsTurn ? {} : { streamingBehavior: followUp ? "followUp" : "steer" }),
				// pi says false when its preflight threw (agent-session.js
				// prompt(): `catch (error) { preflightResult?.(false); throw
				// error; }`); that is a failure, not an acceptance, and the throw
				// that follows reports it.
				preflightResult: (ok: boolean) => {
					if (ok) accepted(ownsTurn);
				},
			} as never);
		}
		// prompt() RESOLVES on abort — an abort is not an exception — so
		// settling "done" unconditionally marked every stopped chat turn
		// with a green tick. execute() in tools/subagent.ts has always
		// checked this; the continue-a-run path never did, which is why
		// only runs you resumed yourself flipped to the wrong glyph.
		//
		// A turn that died at the PROVIDER also resolves, with an assistant
		// message carrying stopReason:"error" and no content — settling that
		// "done" put a green tick on a 401. The stop reason is the only
		// place that failure is recorded.
		if (rec && ownsTurn) {
			// The lead rule: this turn's reply travels only once the run's own
			// agents are idle and their wakes answered (tools/agent.ts
			// holdForTeam is the same wait on the spawn path).
			await holdForTeam(rec, session);
			const aborted = !!controller?.signal.aborted;
			const outcome = lastAssistantOutcome(session);
			// The user's interrupt (agents/run.ts interruptRun): the run goes
			// idle and alive; the principal is NOT told now (2026-08-29, the
			// maintainer's rule): the user's follow-up reply is what travels,
			// or the 10-minute notice (tools/agent.ts armInterruptFollowUp).
			if (!aborted && rec.interrupt?.phase === "unwinding") {
				rec.interrupt.phase = "idle";
				settle(rec, "idle");
			} else if (aborted) {
				const cause = controller?.signal.reason as { message?: string } | undefined;
				settle(rec, "stopped", cause?.message || "stopped");
			} else if (outcome.stopReason === "error") {
				settle(rec, "error", outcome.errorMessage || "the model provider returned an error");
			} else {
				settle(rec, "idle");
				// THE FOLLOW-UP (2026-08-29): the user's first turn after their
				// interrupt is the run's reply to its principal; the owner path
				// left the route here. The lead rule held above, so the team
				// is idle by now.
				if (origin === "user" && rec.interrupt?.onFollowUp) {
					const go = rec.interrupt.onFollowUp;
					closeInterrupt(rec);
					try {
						go();
					} catch {}
				}
			}
		}
	} catch (e) {
		// A failed chat turn must not be recorded as "done" — the station
		// and the strip both read status, and a silent green tick on a
		// turn that errored is worse than no status at all.
		if (rec && ownsTurn) settle(rec, "error", String((e as Error)?.message ?? e));
		throw e;
	}
}

/** One turn on a HELD session (the lead rule): a steer while it streams, a triggered turn otherwise; resolves when that turn ends. */
async function runHeldTurn(session: any, payload: SendPayload): Promise<void> {
	if ("custom" in payload) {
		// triggerTurn true in BOTH states: streaming, it is what makes pi
		// steer instead of deferring the message to the turn's end unread
		// (see sendToRun); idle, it is the turn of its own.
		await session.sendCustomMessage(payload.custom, { deliverAs: "steer", triggerTurn: true });
		return;
	}
	await session.prompt(payload.text, {
		...(payload.images?.length ? { images: payload.images } : {}),
		...(session.isStreaming ? { streamingBehavior: "steer" } : {}),
	} as never);
}

/**
 * THE LEAD RULE (2026-08-28, the maintainer's ruling on the stress
 * report's scenario 155 and 46): a run's reply reaches its principal only
 * when its turn ends AND none of its own agents is still working. While
 * they work, the turn-end is not a reply: the run stays `working` (status
 * says "waiting on N agents"), the workers' replies wake it (deliverToRun,
 * through rec.wakes), and the turn that ends with an idle team is the
 * reply. A stop or timeout ends the hold at once (the subtree dies with
 * the signal). Polled: a descendant may settle in another tick than the
 * wake it triggers.
 */
export async function holdForTeam(rec: RunRecord, session: any): Promise<void> {
	const working = () => {
		const out: string[] = [];
		const seen = new Set<string>();
		const walk = (id: string) => {
			for (const r of knownRuns.values()) {
				if (r.parentId !== id || seen.has(r.id)) continue;
				seen.add(r.id);
				if (r.status === "working" || r.status === "queued") out.push(r.id);
				walk(r.id);
			}
		};
		walk(rec.run.id);
		return out;
	};
	rec.holding = true;
	try {
		for (;;) {
			if (rec.controller.signal.aborted) return;
			// The user's interrupt ends the wait too (interruptRun): the run
			// settles idle inside the episode, its agents keep working, and their
			// replies park until its next turn (deliverToRun).
			if (rec.interrupt?.phase === "unwinding") return;
			const wakes = [...(rec.wakes ?? [])];
			if (!working().length && !wakes.length && !session?.isStreaming) return;
			const woken = new Promise<void>((r) => (rec.holdWake = r));
			await Promise.race([...wakes, woken, new Promise((r) => setTimeout(r, 250))]);
		}
	} finally {
		rec.holding = false;
		rec.holdWake = undefined;
	}
}
