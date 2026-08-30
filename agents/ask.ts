/**
 * The ask CORE: answer a question from an agent's transcript snapshot
 * without touching the run. Shared by the `agent` tool's ask action
 * (tools/agent.ts) and the user's /ask command (tools/ask.ts).
 *
 * The snapshot is the live session's messages plus the streaming partial
 * (agents/stream.ts holds it), or the transcript of a released run; the
 * completion is tool-less and never written anywhere. The wrapper's
 * third sentence is load-bearing: the snapshot serialises an in-flight
 * tool call with a synthetic empty result, and without it the model
 * reported the call as a failed attempt (demonstrated live, 2026-08-24).
 */

import { childBasePrompt, childExchangeRider, riderFactsOf } from "../prompt/child-base.ts";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { findSettings } from "../settings.ts";
import { registry, transcriptFor } from "./run.ts";
import type { SubagentRun } from "./run.ts";
import { getModelRegistry, piAiCompat, sharedModelRuntime } from "./session.ts";

/**
 * pi's OWN retry policy, read the way pi reads it (settings-manager.js
 * getRetrySettings: enabled ?? true, maxRetries ?? 3, baseDelayMs ??
 * 2000; delay = base × 2^(attempt−1)) — so /ask, the tool's ask and the
 * peer ask handler retry a transient failure exactly like the main
 * loop does (maintainer's screenshot, 2026-08-24: a bare completeSimple
 * returned "Connection error." with zero retries while the session's
 * settings said maxRetries 6). Retryability is pi-ai's own
 * isRetryableAssistantError, from the same compat module.
 */
function retrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
	const r =
		findSettings((cfg) =>
			cfg && typeof (cfg as Record<string, unknown>).retry === "object"
				? ((cfg as Record<string, unknown>).retry as Record<string, unknown>)
				: undefined,
		) ?? {};
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
	return {
		enabled: (r.enabled as boolean | undefined) ?? true,
		maxRetries: num(r.maxRetries, 3),
		baseDelayMs: num(r.baseDelayMs, 2000),
	};
}

/** completeSimple under pi's retry policy. Resolves with the final message (which may still carry stopReason "error"). */
export async function completeWithRetry(
	compat: any,
	model: any,
	context: unknown,
	options: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<any> {
	const rs = retrySettings();
	let attempt = 0;
	for (;;) {
		let msg: any;
		try {
			msg = await compat.completeSimple(model, context, options);
		} catch (e) {
			// A thrown transport error is classified the same way pi
			// classifies an errored assistant message.
			msg = { role: "assistant", content: [], stopReason: "error", errorMessage: String((e as Error)?.message ?? e) };
		}
		if (msg?.stopReason !== "error") return msg;
		const retryable = (() => {
			try {
				return compat.isRetryableAssistantError?.(msg) === true;
			} catch {
				return false;
			}
		})();
		if (!rs.enabled || !retryable || attempt >= rs.maxRetries || signal?.aborted) return msg;
		attempt++;
		const delay = rs.baseDelayMs * 2 ** (attempt - 1);
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, delay);
			(t as { unref?: () => void }).unref?.();
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
	}
}

export const askWrapper = (asker: string) =>
	`[A question from ${asker}, answered out of band: the work is not interrupted and this exchange is not part of the transcript. A tool call you see without a real result is still running, not failed. Answer from what you know so far.]`;

/** Ask a RUN's model over its snapshot. Throws with a one-line reason. */
export async function askRun(run: SubagentRun, question: string, asker: string, signal?: AbortSignal): Promise<string> {
	const rec = registry.get(run.id);
	let messages: any[] = [];
	let model: any;
	let systemPrompt: string | undefined;
	// The snapshot is pi's OWN context (2026-08-28, the stress report's A8):
	// a resident run's `session.messages` carry a `compactionSummary` role
	// that pi-ai's serialisers skip, so an ask after a fold forgot everything
	// before it; a released run's raw entries ignored the fold and the
	// branch. buildSessionContext applies both; convertToLlm turns the
	// summary into the user message the model reads.
	if (rec?.session) {
		messages = [...(rec.session.messages ?? [])];
		if (rec.streamMsg && messages[messages.length - 1] !== rec.streamMsg) messages.push(rec.streamMsg);
		model = rec.session.model;
		try {
			// A PROPERTY on AgentSession (getSystemPrompt is the extension
			// context's accessor — the old `?.()` silently yielded undefined and
			// every agent ask ran promptless; stress audit #4).
			systemPrompt = rec.session.systemPrompt ?? rec.session.getSystemPrompt?.();
		} catch {}
	} else {
		const file = transcriptFor(run);
		if (!file) throw new Error(`${run.agent} · ${run.title} has no transcript to answer from.`);
		try {
			messages = [...(SessionManager.open(file, run.sessionDir).buildSessionContext().messages ?? [])];
		} catch {}
	}
	// A released run's transcript has no system prompt (pi keeps it out);
	// rebuild the one the run carries: the call's own, else the named
	// agent's body (stress audit #4, the released half).
	if (!systemPrompt) {
		systemPrompt = (run.config as { systemPrompt?: string } | undefined)?.systemPrompt;
		if (!systemPrompt && run.agent && run.agent !== "adhoc") {
			try {
				const { loadAgents } = await import("./config.ts");
				systemPrompt = loadAgents().get(run.agent)?.systemPrompt;
			} catch {}
		}
		// The child base (prompt/child-base.ts): what ensureSession would
		// rebuild the run on — the snapshot's prompt must match the session's.
		if (!systemPrompt)
			systemPrompt = childBasePrompt((run.config as { cwd?: string } | undefined)?.cwd || process.cwd());
		// The session's real prompt carries the exchange rider (both build
		// paths append it); the rebuilt snapshot must match.
		const rider = childExchangeRider(riderFactsOf(run.config));
		if (systemPrompt && rider && !systemPrompt.includes("<agent-exchange>"))
			systemPrompt = `${systemPrompt}\n\n${rider}`;
	}
	if (!messages.length)
		throw new Error(`${run.agent} · ${run.title} has nothing in its transcript yet; ask again in a moment.`);

	const compat = await piAiCompat();
	const registryRef = getModelRegistry();
	if (!model) {
		const avail = registryRef?.getAvailable?.() ?? [];
		model = avail.find((m: any) => m.id === run.model) ?? avail[0];
	}
	if (!model) throw new Error("ask is unavailable: no model to answer with.");
	const runtime = sharedModelRuntime(registryRef) as any;
	const auth = await runtime?.getAuth?.(model).catch?.(() => undefined);
	const answerMsg = await completeWithRetry(
		compat,
		model,
		{
			...(systemPrompt ? { systemPrompt } : {}),
			messages: [
				...convertToLlm(messages as never),
				{
					role: "user",
					content: [{ type: "text", text: `${askWrapper(asker)}\n\n${question}` }],
					timestamp: Date.now(),
				},
			],
			tools: [],
		},
		{
			...(auth?.auth?.apiKey ? { apiKey: auth.auth.apiKey } : {}),
			...(auth?.auth?.headers ? { headers: auth.auth.headers } : {}),
			...(signal ? { signal } : {}),
		},
		signal,
	);
	if (answerMsg?.stopReason === "error") {
		throw new Error(`ask failed: ${answerMsg?.errorMessage ?? "the model provider returned an error"}`);
	}
	const answer = (answerMsg?.content ?? [])
		.filter((b: any) => b?.type === "text")
		.map((b: any) => String(b.text ?? ""))
		.join("\n")
		.trim();
	return answer || "(no answer)";
}
