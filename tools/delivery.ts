/**
 * ONE delivery queue for background results (2026-08-22, maintainer).
 *
 * A finished background job — bash or subagent — used to go straight out as
 * its own custom message, each one a steer (or, idle, a fresh turn): five jobs
 * finishing within a second meant five deliveries, and the model handled them
 * one by one although they belonged together (pi itself hands PARALLEL tool
 * results over as one batch). Now a finished job enters this queue and starts
 * a short window if none is running; when the window closes, everything
 * queued goes out as ONE message. Later arrivals never extend the window, so a
 * steady trickle cannot starve delivery — the bound on any job's latency is
 * the window, measured from the FIRST completion.
 *
 * One job still goes out in its own shape (`bash-result` / `subagent-result`,
 * unchanged); two or more become a `background-results` message whose body is
 * the single shapes stacked, each self-identifying by its sentence and its
 * `[run id: …]` — the model needs no new vocabulary. The provenance first
 * line names the count. The stamp is appended once, at the end.
 *
 * `WAR_DOGS_DELIVERY_WINDOW_MS` overrides the window (0 delivers at once —
 * the test hook). Session-scoped like the jobs themselves: a session switch
 * clears the queue (the `pi` handle a queued item would deliver through is
 * invalid after session_shutdown).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendStamp } from "../util/stamp.ts";

/**
 * A BATCH is capped as a whole (2026-08-28, the maintainer's ruling on
 * B5): every reply is capped alone at 200k, but five in one window were
 * more than a 256k window. Each section over its share of the batch cap
 * is cut to that share, the whole section saved to a temp file, and the
 * cut named in place — the bash rule.
 */
const BATCH_MAX_CHARS = 200_000;
function capSection(body: string, share: number, i: number): string {
	if (body.length <= share) return body;
	let saved: string | undefined;
	try {
		saved = path.join(os.tmpdir(), `wd-delivery-${Date.now()}-${i}.md`);
		fs.writeFileSync(saved, body);
	} catch {
		saved = undefined;
	}
	const head = body.slice(0, Math.max(0, share));
	return (
		`${head}\n\n[section truncated: first ${head.length} of ${body.length} characters, its share of a ${BATCH_MAX_CHARS}-character batch` +
		(saved ? `. The full section is saved at ${saved}; the rest starts at line ${head.split("\n").length}.]` : ".]")
	);
}

export const DELIVERY_WINDOW_MS = (() => {
	const v = Number(process.env.WAR_DOGS_DELIVERY_WINDOW_MS);
	return Number.isFinite(v) && v >= 0 ? v : 1500;
})();

/**
 * The first line of a batched delivery (N ≥ 2), composed from what the batch
 * HOLDS (2026-08-30, the maintainer: two agent replies read "2 jobs,
 * delivered by the bash and agent tools" — a fixed string from the day the
 * batch shipped). One noun per kind, one tool per kind that is present:
 *   [background results, 2 agent replies, delivered by the agent tool; …]
 *   [background results, 1 agent reply and 1 bash job, delivered by the agent and bash tools; …]
 */
export type BatchKind = "agent" | "bash" | "powershell";
export function batchDeliveryLine(kinds: BatchKind[]): string {
	const n = (k: BatchKind) => kinds.filter((x) => x === k).length;
	const nouns: string[] = [];
	const tools: string[] = [];
	for (const [k, noun] of [
		["agent", "agent repl"],
		["bash", "bash job"],
		["powershell", "powershell job"],
	] as const) {
		const c = n(k);
		if (!c) continue;
		nouns.push(`${c} ${noun}${k === "agent" ? (c === 1 ? "y" : "ies") : c === 1 ? "" : "s"}`);
		tools.push(k);
	}
	const list = (xs: string[]) =>
		xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
	return `[background results, ${list(nouns)}, delivered by the ${list(tools)} tool${tools.length === 1 ? "" : "s"}; not typed by the user]`;
}
/** The kind a queued item counts as in the batch line. */
export function batchKindOf(item: Delivery): BatchKind {
	if (item.customType === "agent-result") return "agent";
	return (item.details?.tool as BatchKind | undefined) === "powershell" ? "powershell" : "bash";
}

export interface Delivery {
	/** The single-delivery message type. */
	customType: "bash-result" | "agent-result";
	/** The single-delivery provenance line (BASH_DELIVERY / SUBAGENT_DELIVERY). */
	provenance: string;
	/** The section: its sentence, body and `[run id: …]` — no provenance, no stamp. */
	body: string;
	details: Record<string, unknown>;
}

let queue: { pi: ExtensionAPI; item: Delivery }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether main is idle right now (pi's own `ctx.isIdle()`, handed over at
 * session_start). THE DELIVERY-TURN RULE (2026-08-28, the stress report's
 * A1, verified on the wire): a custom message sent with `triggerTurn`
 * while main is idle starts a turn through pi's `_runAgentPrompt` directly,
 * which never emits `before_agent_start` — that turn ran on the previous
 * turn's stale prompt override and, after its first tool call, on pi's
 * stock prompt, with no memory rider and no per-turn injection. pi's
 * public `sendUserMessage` goes through `prompt()` and the hook, so an
 * IDLE-time delivery is sent as a user-role message carrying the same
 * provenance line and body; the pager recognises the provenance and
 * draws the same act (visual/pager/surface.ts ownResultKind). Mid-turn
 * deliveries stay custom messages (a steer joins a turn whose prompt is
 * live). Any approach was allowed as long as the reply renders and is fed
 * like any other tool result: on the wire both shapes are user-role.
 */
let idleSource: (() => boolean) | undefined;
export function setIdleSource(fn: (() => boolean) | undefined): void {
	idleSource = fn;
}
function mainIdle(): boolean {
	try {
		return idleSource ? idleSource() === true : false;
	} catch {
		return false;
	}
}

/**
 * A steered delivery is HELD until pi consumes it (2026-08-29, the
 * maintainer's question, verified): while main streams, a delivery rides
 * pi's steering queue, and pi's Esc handler clears every queue
 * (`restoreQueuedMessagesToEditor`) — typed text returns to the editor, a
 * custom message vanishes, and a worker's reply was simply gone. Each
 * steered delivery carries a nonce in `details`; `message_start` with that
 * nonce means pi consumed it; whatever is still held when the turn settles
 * is sent again — main is idle then, so it goes through the prompt path
 * and wakes a turn of its own.
 */
const held = new Map<string, { pi: ExtensionAPI; msg: DeliveryMessage }>();
let nonce = 0;
type DeliveryMessage = { customType: string; content: string; display: boolean; details?: Record<string, unknown> };

/**
 * THE USER'S ESC ON MAIN (2026-08-29, the maintainer's rule): after an
 * interrupted turn nothing wakes the model on its own. Every delivery that
 * arrives — the held steer re-sent at settle, a reply landing minutes later
 * — rides pi's `nextTurn` queue and is appended beside the user's next
 * prompt (agent-session.js prompt(): the pending messages follow the user
 * message, before the hook's). An aborted turn is read off `agent_end`: its
 * last assistant message carries `stopReason: "aborted"`. The state ends
 * when a turn starts again (`agent_start`), which is the user's prompt. The
 * first build (2026-08-29 morning) re-sent the held steer through the
 * prompt path, which woke a turn after the Esc.
 */
let mainInterrupted = false;
export function mainIsInterrupted(): boolean {
	return mainInterrupted;
}
/**
 * The user's Esc, seen by the pager (visual/pager/mod.ts) before pi acts
 * on it — the direct signal. The `agent_end` read below is the fallback for
 * an abort the pager never saw (rpc's abort command): a provider reports it
 * as `stopReason: "aborted"`, or as `"error"` with pi's own "This operation
 * was aborted" message (the openai-completions shape, demonstrated).
 */
export function markMainInterrupted(): void {
	mainInterrupted = true;
}

/** Register the hooks the hold and the interrupted state need; from installOnce (registerAgentTool). */
export function armRedelivery(pi: ExtensionAPI): void {
	pi.on("message_start", async (ev: any) => {
		const id = ev?.message?.details?.wdDelivery;
		if (typeof id === "string") held.delete(id);
	});
	pi.on("agent_start", async () => {
		mainInterrupted = false;
	});
	pi.on("agent_end", async (ev: any) => {
		try {
			const msgs = (ev?.messages ?? []) as { role?: string; stopReason?: string; errorMessage?: string }[];
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]?.role !== "assistant") continue;
				const m = msgs[i];
				if (m.stopReason === "aborted" || (m.stopReason === "error" && /\baborted\b/i.test(m.errorMessage ?? "")))
					mainInterrupted = true;
				break;
			}
		} catch {}
	});
	pi.on("agent_settled", async () => {
		if (!held.size) return;
		const again = [...held.values()];
		held.clear();
		for (const h of again) {
			try {
				sendDelivery(h.pi, h.msg);
			} catch {}
		}
	});
	pi.on("session_shutdown", async () => {
		held.clear();
		mainInterrupted = false;
	});
}

/** Send one delivery-shaped message: parked for the next prompt after the user's Esc; a user message through the hook when idle; a steering custom message otherwise. */
export function sendDelivery(pi: ExtensionAPI, msg: DeliveryMessage): void {
	if (mainInterrupted) {
		pi.sendMessage(msg as never, { deliverAs: "nextTurn" } as never);
		return;
	}
	if (mainIdle() && typeof (pi as { sendUserMessage?: unknown }).sendUserMessage === "function") {
		(pi as unknown as { sendUserMessage: (c: string, o: unknown) => void }).sendUserMessage(msg.content, {
			deliverAs: "steer",
		});
		return;
	}
	const id = `d${++nonce}-${Date.now()}`;
	const steered: DeliveryMessage = { ...msg, details: { ...(msg.details ?? {}), wdDelivery: id } };
	held.set(id, { pi, msg });
	pi.sendMessage(steered as never, { deliverAs: "steer", triggerTurn: true } as never);
}

/** Queue a finished job's result; the window delivers it alone or batched. */
export function deliver(pi: ExtensionAPI, item: Delivery): void {
	queue.push({ pi, item });
	if (DELIVERY_WINDOW_MS === 0) {
		flush();
		return;
	}
	if (!timer) {
		timer = setTimeout(flush, DELIVERY_WINDOW_MS);
		(timer as { unref?: () => void }).unref?.();
	}
}

/**
 * Flush whatever is queued RIGHT NOW — called at session_shutdown before
 * the clear, so a reply that landed inside the batching window in the
 * last moments of a session is written into ITS transcript (read on
 * resume) instead of vanishing (stress audit #14: a delivery <1.5s
 * before /new left no trace in either transcript).
 */
export function flushDeliveries(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	flush();
}

/** Drop whatever is queued — the session it would deliver into is gone. */
export function clearDeliveries(): void {
	queue = [];
	if (timer) clearTimeout(timer);
	timer = null;
}

function flush(): void {
	timer = null;
	const batch = queue;
	queue = [];
	if (!batch.length) return;
	// The latest handle: every item in one window belongs to one session.
	const pi = batch[batch.length - 1].pi;
	try {
		if (batch.length === 1) {
			const { item } = batch[0];
			sendDelivery(pi, {
				customType: item.customType,
				content: appendStamp(`${item.provenance}\n\n${item.body}`),
				display: true,
				details: item.details,
			});
			return;
		}
		const share = Math.floor(BATCH_MAX_CHARS / batch.length);
		sendDelivery(pi, {
			customType: "background-results",
			content: appendStamp(
				`${batchDeliveryLine(batch.map((b) => batchKindOf(b.item)))}\n\n${batch.map((b, i) => capSection(b.item.body, share, i)).join("\n\n")}`,
			),
			display: true,
			details: { background: true, jobs: batch.map((b) => ({ customType: b.item.customType, ...b.item.details })) },
		});
	} catch {
		/* session replaced: no receiver — background work is session-scoped */
	}
}
