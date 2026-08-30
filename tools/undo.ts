/**
 * ESC TAKES THE PROMPT BACK (2026-08-30, the maintainer's ask: an accidental
 * Enter, then Esc, and the prompt is in the editor again as if never sent).
 *
 * pi's Esc aborts the turn and restores the QUEUED messages to the editor,
 * but the prompt that started the turn stays in the transcript — the only
 * way out was /tree. pi has the primitive: `navigateTree(id)` moves the leaf
 * to an earlier entry (what /tree does after its selector), rebuilds the
 * agent's context from the branch and emits `session_tree`, which the pager
 * already follows. So: the raw prompt (before the stamp and the attachment
 * transforms — this handler is registered first) and the leaf it was typed
 * at are remembered; when the turn that prompt started is ABORTED and the
 * branch after that leaf holds nothing but the prompt, war-dogs' own riders
 * (the session brief, injected files) and the aborted assistant message, the
 * leaf goes back and the raw text is prepended to the editor. The entries
 * stay in the file on the abandoned branch (/tree shows them); nothing is
 * destroyed.
 *
 * REFUSED, and the prompt kept, whenever the turn did anything real: a tool
 * ran (a result sits after the leaf), a delivery landed as a steer (an
 * agent's or a job's reply would be lost with the branch — the maintainer's
 * worry), or the aborted turn was not this prompt's. Background agents and
 * jobs are process state and never touched; their later replies append to
 * the new leaf like any other. A steer or follow-up typed while a turn ran
 * is pi's own to restore (alt+up, or Esc's restore), not this. Slash
 * commands and `!` commands are dispatched by pi and never recorded.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editorPrepend } from "./attachments.ts";

type Pending = { text: string; leafBefore: string | null; at: number };
/** The undo decided by agent_settled, waiting for the command context that can rewind. */
let armed: { target: string; text: string } | null = null;

/** `/war-dogs undo`: the rewind itself, with the command context's navigateTree. */
export async function performUndo(ctx: ExtensionCommandContext): Promise<void> {
	const a = armed;
	armed = null;
	if (!a) {
		status(ctx, "nothing to take back");
		return;
	}
	try {
		const r = await ctx.navigateTree(a.target, { summarize: false });
		if (r?.cancelled) return;
	} catch (e) {
		status(ctx, `prompt kept: ${String((e as Error)?.message ?? e)}`);
		return;
	}
	if (!editorPrepend(a.text)) {
		try {
			ctx.ui.setEditorText(a.text);
		} catch {}
	}
	status(ctx, "prompt taken back: it is in the editor again, and the model never read it");
}
/** Recorded at `input` (the user's own prompt), taken by the turn it starts. */
let pending: Pending | null = null;
/** The prompt that started the running turn, or null when a delivery or a continue did. */
let turn: Pending | null = null;
let turnAborted = false;

const textOf = (c: unknown): string =>
	typeof c === "string"
		? c
		: ((c as { type?: string; text?: string }[] | undefined) ?? [])
				.filter((b) => b?.type === "text")
				.map((b) => String(b.text ?? ""))
				.join("\n");

/** An entry the undo may leave behind: the prompt itself, war-dogs' riders on it, the cut assistant message. */
function restorable(e: any): boolean {
	if (e?.type === "custom_message") return e.customType === "session-brief" || e.customType === "inject";
	if (e?.type !== "message") return false;
	const m = e.message;
	if (m?.role === "user") return true;
	if (m?.role === "assistant")
		return m.stopReason === "aborted" || (m.stopReason === "error" && /\baborted\b/i.test(m.errorMessage ?? ""));
	return false;
}

function status(ctx: ExtensionContext, msg: string): void {
	try {
		ctx.ui.setStatus("wd-undo", msg);
		const t = setTimeout(() => {
			try {
				ctx.ui.setStatus("wd-undo", undefined);
			} catch {}
		}, 3000);
		(t as { unref?: () => void }).unref?.();
	} catch {}
}

export function registerUndo(pi: ExtensionAPI): void {
	pi.on("input", async (event: any, ctx: ExtensionContext) => {
		if (event?.source === "extension") return;
		const text = String(event?.text ?? "");
		const lead = text.trimStart();
		if (!lead) return;
		if (lead.startsWith("/") || lead.startsWith("!")) return;
		// A steer or a follow-up (typed while a turn ran) is pi's queue: pi's
		// own Esc and alt+up restore those.
		if (event?.streamingBehavior) return;
		let leaf: string | null = null;
		try {
			leaf = ctx.sessionManager.getLeafId();
		} catch {}
		pending = { text, leafBefore: leaf, at: Date.now() };
	});
	pi.on("agent_start", async () => {
		// The turn that follows the prompt is the prompt's; a delivery's or a
		// continue's turn finds nothing pending and owns no undo.
		turn = pending;
		pending = null;
		turnAborted = false;
	});
	pi.on("agent_end", async (ev: any) => {
		try {
			const msgs = (ev?.messages ?? []) as { role?: string; stopReason?: string; errorMessage?: string }[];
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]?.role !== "assistant") continue;
				const m = msgs[i];
				turnAborted =
					m.stopReason === "aborted" || (m.stopReason === "error" && /\baborted\b/i.test(m.errorMessage ?? ""));
				break;
			}
		} catch {}
	});
	pi.on("agent_settled", async (_e: any, ctx: ExtensionContext) => {
		const t = turn;
		turn = null;
		if (!t || !turnAborted) return;
		turnAborted = false;
		let branch: any[] = [];
		try {
			branch = ctx.sessionManager.getBranch() as any[];
		} catch {
			return;
		}
		const i = t.leafBefore ? branch.findIndex((e) => e?.id === t.leafBefore) : 0;
		if (i < 0) return;
		const after = branch.slice(i + 1);
		const prompt = after.find((e) => e?.type === "message" && e.message?.role === "user");
		if (!prompt || !textOf(prompt.message?.content).startsWith(t.text.slice(0, 24).trim())) return;
		if (!after.every(restorable)) {
			status(ctx, "prompt kept: the turn already ran a tool or received a reply (/tree rewinds by hand)");
			return;
		}
		// The target: the leaf the prompt was typed at, or the session's root
		// entry when it was the first prompt (pi resets the leaf there).
		const target = t.leafBefore ?? (branch[0]?.id as string | undefined);
		if (!target) return;
		// `navigateTree` lives on the COMMAND context only (pi hands it to
		// command handlers), so the rewind runs as `/war-dogs undo`, dispatched
		// by war-dogs itself: pi executes an extension command before anything
		// is persisted or any input event fires (agent-session.js prompt()).
		armed = { target, text: t.text };
		try {
			(pi as unknown as { sendUserMessage: (c: string, o: unknown) => void }).sendUserMessage("/war-dogs undo", {
				expandPromptTemplates: true,
			});
		} catch (e) {
			armed = null;
			status(ctx, `prompt kept: ${String((e as Error)?.message ?? e)}`);
		}
	});
	pi.on("session_shutdown", async () => {
		pending = null;
		turn = null;
		turnAborted = false;
		armed = null;
	});
}
