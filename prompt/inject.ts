/**
 * INJECT — the user's own injected messages (HANDOFF 2026-08-28, built
 * 2026-08-28). Two files in an `inject/` folder, read verbatim and handed
 * to the model as custom messages, no wrapper, no rewording:
 *
 *   SESSION_START.md   once per session, riding the first turn that finds it
 *   PER_TURN.md        every turn, the turns a delivery starts included
 *                      (the delivery-turn rule, dev/internals/README.md ledger)
 *
 * Two scopes, BOTH ride when present, global first then project (the
 * context-file rule, AGENTS.md's accumulation, not SYSTEM.md's override:
 * a project reminder should not silently retire a global one):
 *
 *   <agentDir>/inject/<file>          global
 *   <cwd>/.pi/inject/<file>           project, only when the project is TRUSTED
 *                                     (settings.ts projectAllowed, the one gate)
 *
 * Mechanism. pi's `before_agent_start` runner collects ONE `message` per
 * handler and appends every handler's message to the turn in registration
 * order (runner.js emitBeforeAgentStart: `messages.push(result.message)`;
 * agent-session.js then persists each as its own `custom_message` entry,
 * user-role on the wire, AFTER the user's prompt). So each of the four
 * slots is its own handler, registered in the order above, and a slot
 * whose file is absent or blank returns nothing. The messages are
 * persisted with `display:true` and `details: {kind, scope, path}` — the
 * provenance lives in details, never in the text, because the text is
 * the user's and reaches the model byte for byte.
 *
 * Once-per-session for SESSION_START is read from the TRANSCRIPT per
 * scope, exactly as the session brief's is (prompt/index.ts): scan the
 * branch for an `inject` entry whose details say session-start and that
 * scope (both persisted shapes), memoise by session id only after one is SEEN, never at
 * injection, so a first turn that dies before persisting still injects.
 * A `/fork` carries the entry along and is never doubled; a resumed
 * session that predates the file gains one at its next turn; a file
 * created mid-session arrives once at the next turn.
 *
 * Deliberately NOT gated on the user's SYSTEM.md: the inject files ARE
 * the user's context engineering, so unlike the base and the brief they
 * ride any prompt (the memory rider's rule). Children never receive them
 * (dev/internals/README.md, "Session-start and per-turn injection"): a child's
 * context is its definition and its briefs, not an inherited pile.
 *
 * Costs stated where they bind (GUIDE): every PER_TURN copy is a real
 * persisted message the model re-reads on every later turn until
 * compaction, so that file wants to be short; SESSION_START can be long,
 * but compaction may fold it into a summary.
 *
 * Registered from installOnce only (index.ts, `inject` feature key) — a
 * boot-off registers nothing, and a transcript that carries one renders
 * under pi's stock custom-message box, the documented fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "../agents/run.ts";
import { projectAllowed } from "../settings.ts";
import { renderInjectMessage } from "../visual/tools/inject.ts";

/** The folder name, under the agent dir and under a trusted project's `.pi/`. */
export const INJECT_DIR = "inject";

export type InjectKind = "session-start" | "per-turn";
export type InjectScope = "global" | "project";

/** The file each kind reads. */
export const INJECT_FILES: Record<InjectKind, string> = {
	"session-start": "SESSION_START.md",
	"per-turn": "PER_TURN.md",
};

/** The ONE persisted customType (the pager's ownResultKind); `details.kind` tells the files apart. */
export const INJECT_TYPE = "inject";

/** What rides in the custom message's `details`: provenance, never in the text. */
export interface InjectDetails {
	kind: InjectKind;
	scope: InjectScope;
	path: string;
}

/** The four slots, in wire order: session-start before per-turn, global before project. */
const SLOTS: { kind: InjectKind; scope: InjectScope }[] = [
	{ kind: "session-start", scope: "global" },
	{ kind: "session-start", scope: "project" },
	{ kind: "per-turn", scope: "global" },
	{ kind: "per-turn", scope: "project" },
];

/** The file a slot reads. Project files sit under `<cwd>/.pi/`, the cwd settings.ts gates. */
export function injectPath(kind: InjectKind, scope: InjectScope): string {
	const base = scope === "global" ? agentDir() : path.join(process.cwd(), ".pi");
	return path.join(base, INJECT_DIR, INJECT_FILES[kind]);
}

/** Paths whose read failed for a reason other than absence — named once on stderr, never per turn. */
const readFailed = new Set<string>();

/**
 * Read one slot verbatim. Null when the file is absent, blank, or the
 * project scope is not trusted. A read that fails for any other reason
 * (permissions, a directory in its place) is named ONCE on stderr —
 * silently injecting nothing from a file the user wrote is the wrong
 * kind of quiet.
 */
export function readInject(kind: InjectKind, scope: InjectScope): { path: string; text: string } | null {
	if (scope === "project" && !projectAllowed()) return null;
	const p = injectPath(kind, scope);
	let text: string;
	try {
		text = fs.readFileSync(p, "utf8");
	} catch (e) {
		const code = (e as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT" && code !== "ENOTDIR" && !readFailed.has(p)) {
			readFailed.add(p);
			console.error(`[war-dogs] inject: cannot read ${p} (${code ?? String(e)}) — nothing injected from it.`);
		}
		return null;
	}
	if (!text.trim()) return null;
	return { path: p, text };
}

/** `${sessionId}|${scope}` pairs whose transcript is KNOWN to carry a session-start injection. */
const startSeen = new Set<string>();

/** Whether this session's branch already carries a session-start injection of this scope. */
function startAlreadyInSession(ctx: unknown, scope: InjectScope): boolean {
	const sm = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as
		{ getSessionId?: () => string; getBranch?: () => unknown[]; getEntries?: () => unknown[] } | undefined;
	let sid = "";
	try {
		sid = String(sm?.getSessionId?.() ?? "");
	} catch {}
	const key = `${sid}|${scope}`;
	if (sid && startSeen.has(key)) return true;
	let found = false;
	try {
		const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
		for (const e of entries) {
			// Both persisted shapes, the brief's lesson (dev/internals/README.md ledger): on
			// disk a custom message is its OWN entry type with `details`
			// beside `customType`; the `.message`-wrapped shape is the
			// defensive second read.
			const entry = e as {
				type?: string;
				customType?: string;
				details?: Partial<InjectDetails>;
				message?: { role?: string; customType?: string; details?: Partial<InjectDetails> };
			};
			const m = entry?.message;
			const own =
				entry?.type === "custom_message" && entry?.customType === INJECT_TYPE
					? entry.details
					: m?.role === "custom" && m?.customType === INJECT_TYPE
						? m.details
						: undefined;
			if (own && own.kind === "session-start" && own.scope === scope) {
				found = true;
				break;
			}
		}
	} catch {}
	if (found && sid) startSeen.add(key);
	return found;
}

/** Build one slot's message for this turn, or undefined when nothing rides. */
export function injectMessage(
	ctx: unknown,
	kind: InjectKind,
	scope: InjectScope,
):
	| { customType: string; content: { type: "text"; text: string }[]; display: boolean; details: InjectDetails }
	| undefined {
	if (kind === "session-start" && startAlreadyInSession(ctx, scope)) return undefined;
	const got = readInject(kind, scope);
	if (!got) return undefined;
	return {
		customType: INJECT_TYPE,
		content: [{ type: "text", text: got.text }],
		display: true,
		details: { kind, scope, path: got.path },
	};
}

export function registerInject(pi: ExtensionAPI): void {
	// The renderer for pi's own scrollback (`pager:false`) — registered
	// here so a boot-off never has it (pi's stock custom box is the
	// documented fallback for transcripts that already carry one).
	pi.registerMessageRenderer(INJECT_TYPE, renderInjectMessage);
	// One handler per slot: pi takes ONE message per handler and keeps
	// registration order, so this is what puts four messages on one turn
	// in a fixed order (see the header).
	for (const { kind, scope } of SLOTS) {
		pi.on("before_agent_start", async (_event, ctx) => {
			const message = injectMessage(ctx, kind, scope);
			return message ? ({ message } as never) : undefined;
		});
	}
}
