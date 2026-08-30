/**
 * /ask — the user's out-of-band question (2026-08-24, maintainer: "it
 * is called ask, not btw — one semantic with the tool's ask action").
 *
 * `/ask <question>` asks the conversation the user is LOOKING AT: the
 * focused run view's agent, else this session's own model over its live
 * conversation snapshot. `/ask @<id> <question>` targets any agent or
 * session_… peer instead. The answer is a DISPLAY-ONLY entry (pi's
 * custom-entry mechanism, the same one `✸ Generated in Ns` uses): the
 * user sees the exchange in place, no model's context ever carries it.
 * `/ask!` additionally hands the Q&A to THIS session's model as a
 * HIDDEN message (`display: false` — the inverse of the entry: context
 * without pixels), queued so it rides the next turn rather than waking
 * one. The wrapper the answerer reads names the asker "your user" (its
 * own user, via the run view or this command) or the sending session.
 */

import { setAskProgress } from "../visual/hud/footer.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { askRun } from "../agents/ask.ts";
import { findRun, knownRuns } from "../agents/run.ts";
import { findPeer, listPeers, localPeerFrame, ownSessionId, sendToPeer } from "../agents/peers.ts";
import { getFocusedRun } from "../visual/pager/state.ts";
import { appendStamp } from "../util/stamp.ts";

interface AskEntry {
	target: string;
	q: string;
	a?: string;
	err?: string;
	shared?: boolean;
}

const SESSIONISH = /^(session_|[0-9a-f]{8}-[0-9a-f]{4}-)/i;

export function registerAskCommand(pi: ExtensionAPI) {
	pi.registerEntryRenderer("ask", (entry: any, _options: any, theme: any) => {
		const d = (entry?.data ?? {}) as AskEntry;
		const call = (t: string) => {
			try {
				return theme.fg("wdCall", t) as string;
			} catch {
				return theme.fg("toolOutput", t) as string;
			}
		};
		const mark = (t: string) => {
			try {
				return theme.bold(theme.fg("wdPrompt", t)) as string;
			} catch {
				return theme.bold(theme.fg("accent", t)) as string;
			}
		};
		const c = new Container();
		c.addChild(
			new Text(
				`${mark("?")} ${theme.bold(call("asked"))} ${call(`${d.target || "this session"} · ${d.q}`)}${d.shared ? theme.fg("dim", " · shared") : ""}`,
				0,
				0,
			),
		);
		const body = d.err ? d.err : (d.a ?? "…");
		const paint = d.err ? (t: string) => theme.fg("error", t) : (t: string) => theme.fg("toolOutput", t);
		const rows = body
			.split("\n")
			.map((l, i) => (i === 0 ? ` ${theme.fg("dim", "⎿")}  ${paint(l)}` : `    ${paint(l)}`));
		c.addChild(new Text(rows.join("\n"), 0, 0));
		return c;
	});

	const handler = (shared: boolean) => async (args: string, ctx: any) => {
		let q = args.trim();
		let target: string | undefined;
		if (q.startsWith("@")) {
			const sp = q.indexOf(" ");
			target = sp < 0 ? q.slice(1) : q.slice(1, sp);
			q = sp < 0 ? "" : q.slice(sp + 1).trim();
		}
		if (!q) {
			ctx.ui.notify("Usage: /ask [@agent_or_session_id] <question>", "warning");
			return;
		}
		// Default target: the conversation on screen — the focused run view's
		// agent, else this session itself.
		target ??= getFocusedRun() ?? "";
		// Progress lives in the FOOTER STATUS slot and clears itself — a
		// notify() became a status LINE in the transcript that outlived the
		// answer (the duplicate) and, being an info beat, split ask clusters
		// (maintainer's screenshot, 2026-08-24).
		const preview = q.length > 48 ? `${q.slice(0, 48)}…` : q;
		// The strip's living form, not a plain status line (maintainer,
		// 2026-08-27): the /ask progress renders as a strip row below the
		// footer, spinner and identity blue like the agents' and jobs' rows.
		const status = (t?: string) => {
			setAskProgress(t);
		};
		status(`asking ${target || "this session"} · ${preview}`);
		void (async () => {
			let label = "this session";
			try {
				let answer: string;
				if (!target || (ownSessionId() && (target === ownSessionId() || `session_${ownSessionId()}` === target))) {
					const res = await localPeerFrame({
						type: "ask",
						from: { session: ownSessionId() ?? "", by: "user", local: true },
						question: q,
					});
					if (!res?.ok) throw new Error(String(res?.reason ?? "no answer"));
					answer = String(res.answer ?? "(no answer)");
				} else if (SESSIONISH.test(target)) {
					const entry = findPeer(target);
					if (!entry)
						throw new Error(
							`No session matches "${target}". Sessions: ${
								listPeers()
									.map((p) => `session_${p.sessionId}`)
									.join(", ") || "(none)"
							}`,
						);
					label = `session_${entry.sessionId}${entry.name ? ` ("${entry.name}")` : ""}`;
					const res = await sendToPeer(
						entry,
						{ type: "ask", from: { session: ownSessionId() ?? "", cwd: process.cwd(), by: "user" }, question: q },
						120_000,
					);
					if (!res?.ok) throw new Error(String(res?.reason ?? "no answer"));
					answer = String(res.answer ?? "(no answer)");
				} else {
					// The USER's reach is the station's: any run it can see.
					const run = findRun(target) ?? knownRuns.get(target);
					if (!run) throw new Error(`No agent with id "${target}".`);
					label = `${run.agent} · ${run.title}`;
					answer = await askRun(run, q, "your user");
				}
				pi.appendEntry("ask", { target: label, q, a: answer, shared } satisfies AskEntry);
				if (shared) {
					// Context without pixels: the entry above is what the user
					// sees; this hidden message is what the model learns.
					pi.sendMessage(
						{
							customType: "ask-note",
							content: appendStamp(
								`[the user asked ${label} out of band with /ask; the exchange, for your context]\nQ: ${q}\nA: ${answer}`,
							),
							display: false,
						} as never,
						{ deliverAs: "steer" } as never,
					);
				}
			} catch (e) {
				pi.appendEntry("ask", { target: label, q, err: String((e as Error)?.message ?? e), shared } satisfies AskEntry);
			} finally {
				status(undefined);
			}
		})();
	};

	pi.registerCommand("ask", {
		description: "Ask the conversation you are looking at (or @id) out of band; the model never sees the exchange",
		handler: handler(false),
	});
	pi.registerCommand("ask!", {
		description: "Like /ask, but the Q&A is also handed to this session's model as context",
		handler: handler(true),
	});
}
