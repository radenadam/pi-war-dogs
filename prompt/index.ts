/**
 * The inherent system prompt (dev/internals/README.md; prose reviewed green
 * 2026-08-26). Two mechanical layers on ONE hook:
 *
 * THE BASE — war-dogs' prompt replaces pi's stock default, per turn, via
 * `before_agent_start` returning `systemPrompt`. The swap goes through
 * pi's own `buildSystemPrompt({...options, customPrompt: BASE})`, which
 * is exactly the assembly a user SYSTEM.md gets: APPEND_SYSTEM.md, the
 * project context files (AGENTS.md), skills and the cwd line all survive.
 * `buildSystemPrompt` is NOT exported from pi's package index (only its
 * options type is) — it is reached from `dist/core/system-prompt.js` via
 * pidist.ts (Upgrade Contract). A miss degrades honestly: one stderr line
 * at registration, pi's stock prompt stays in force, the brief still
 * rides. Precedence mirrors the agent-config rule: when the USER runs
 * their own SYSTEM.md (`options.customPrompt` truthy — project
 * `.pi/SYSTEM.md` when trusted, else `<agentDir>/SYSTEM.md`), this module
 * returns NOTHING — their context engineering is honored whole, brief
 * included.
 *
 * THE SESSION BRIEF — machine/runtime/reference/model facts, injected
 * ONCE per session as a `session-brief` custom message riding the first
 * turn's event result (persisted beside the user's prompt, display:true,
 * rendered by visual/tools/brief.ts). Once-per-session is read from the
 * TRANSCRIPT (a `/fork` carries the brief with it and must not get a
 * second; a resumed pre-brief session gets one), memoised by session id
 * only after it is SEEN in the branch — never at injection, so an aborted
 * first turn does not lose the brief for the session.
 *
 * Registered from installOnce only (index.ts, `prompt` feature key): a
 * boot-off never touches the prompt — prompt parity stays the proof.
 * Children are structurally untouched: they load no extensions, so this
 * hook does not exist in their sessions (the child-prompt question is a
 * deliberately open decision — HANDOFF 2026-08-26).
 *
 * Per-turn replacement is what buys compaction survival for free: the
 * hook receives the freshly assembled prompt every turn, so there is no
 * re-injection path to maintain. A turn that a background delivery starts
 * while main is idle used to skip this hook (pi's sendMessage with
 * triggerTurn runs `_runAgentPrompt` directly); since 2026-08-28 idle-time
 * deliveries go through pi's `sendUserMessage`, which is `prompt()` and
 * this hook (tools/delivery.ts, the delivery-turn rule in dev/internals/README.md
 * ledger), so every turn is covered. Riders that must survive a FOREIGN base
 * (memory, when built) append to `event.systemPrompt` in this same
 * handler, after the stand-down check — see dev/internals/README.md.
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { importPiModule } from "../pidist.ts";
import { BASE_PROMPT } from "./base.ts";
import { buildBriefText } from "./brief.ts";
import { buildMemoryRider, registerMemory } from "./memory.ts";
import { renderBriefMessage } from "../visual/tools/brief.ts";

type PromptBuilder = (options: BuildSystemPromptOptions) => string;

/** pi's own assembler, reached once from the running pi's dist (cached by pidist). */
function promptBuilder(): Promise<PromptBuilder | null> {
	return importPiModule("core/system-prompt.js").then((m) =>
		typeof m?.buildSystemPrompt === "function" ? (m.buildSystemPrompt as PromptBuilder) : null,
	);
}

/** Session ids whose transcript is KNOWN to carry a brief (memo over the branch scan). */
const briefSeen = new Set<string>();

/** Whether this session's branch already carries a session brief. */
function briefAlreadyInSession(ctx: unknown): boolean {
	const sm = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as
		{ getSessionId?: () => string; getBranch?: () => unknown[]; getEntries?: () => unknown[] } | undefined;
	let sid = "";
	try {
		sid = String(sm?.getSessionId?.() ?? "");
	} catch {}
	if (sid && briefSeen.has(sid)) return true;
	let found = false;
	try {
		const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
		for (const e of entries) {
			// On disk a custom message is its OWN entry type — `{type:
			// "custom_message", customType}` (session-manager.d.ts), no
			// `.message` wrapper; the wrapped shape is kept as a defensive
			// second read. Scanning `.message` alone re-injected the brief
			// on every `pi -p --continue` (demonstrated on the wire).
			const entry = e as { type?: string; customType?: string; message?: { role?: string; customType?: string } };
			const m = entry?.message;
			if (
				(entry?.type === "custom_message" && entry?.customType === "session-brief") ||
				(m?.role === "custom" && m?.customType === "session-brief")
			) {
				found = true;
				break;
			}
		}
	} catch {}
	if (found && sid) briefSeen.add(sid);
	return found;
}

export function registerPrompt(pi: ExtensionAPI): void {
	// The brief's renderer — registered here so a boot-off never has it
	// (pi's stock custom box is the documented fallback for transcripts
	// that already carry one, exactly like agent-result).
	pi.registerMessageRenderer("session-brief", renderBriefMessage);

	// MEMORY (prompt/memory.ts): /memory and the store scaffolding. The
	// rider itself is stage 2 of the handler below; everything is gated
	// per turn on memory.enabled (default ON), so a war-dogs-on boot with
	// memory off appends and reads nothing.
	registerMemory(pi);

	// Name the degradation once, at registration: a base swap that cannot
	// reach pi's assembler is OFF, not subtly different. ON-boots only —
	// a boot-off never runs this, so off stays stock on stderr too.
	void promptBuilder().then((b) => {
		if (!b)
			console.error(
				"[war-dogs] prompt: pi's core/system-prompt.js is not reachable — the inherent base prompt is off " +
					"(pi's stock prompt stays in force); the session brief still rides. See dev/internals/README.md's Upgrade Contract.",
			);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const opts = event?.systemPromptOptions;
		const result: {
			systemPrompt?: string;
			message?: { customType: string; content: unknown[]; display: boolean };
		} = {};
		// STAGE 1 — the base and the brief. The user's own SYSTEM.md wins
		// WHOLE over both (and an event with no options is a pi this module
		// does not know; stand down rather than guess).
		if (opts && !opts.customPrompt) {
			const build = await promptBuilder();
			if (build) result.systemPrompt = build({ ...opts, customPrompt: BASE_PROMPT });
			if (!briefAlreadyInSession(ctx)) {
				const text = buildBriefText(ctx);
				if (text) result.message = { customType: "session-brief", content: [{ type: "text", text }], display: true };
			}
		}
		// STAGE 2 — the memory RIDER (dev/internals/README.md): it must
		// survive ANY base, the user's SYSTEM.md included, so it appends to
		// whichever prompt is in force — after the stand-down, never inside
		// it. Per turn, so compaction re-injection is free, the index stays
		// current, and off (the default) reads nothing.
		const rider = buildMemoryRider();
		if (rider) {
			const inForce = result.systemPrompt ?? (typeof event?.systemPrompt === "string" ? event.systemPrompt : undefined);
			if (inForce !== undefined) result.systemPrompt = `${inForce}${rider}`;
		}
		if (result.systemPrompt === undefined && result.message === undefined) return;
		return result as never;
	});
}
