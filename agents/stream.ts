/**
 * Capture of the assistant message currently streaming inside a child
 * session.
 *
 * Partial content NEVER appears in session.messages — it exists only as
 * message_update events — so without this a chat view can only redraw
 * once a turn has fully finalised. The captured message is deliberately
 * NOT dropped at message_end: the renderer hands off to the persisted
 * entry once that entry exists, which avoids a frame where neither copy
 * is on screen (the "flicker to my prompt" bug).
 */

import type { RunRecord } from "./run.ts";

type StreamListener = (runId: string) => void;
let listener: StreamListener | undefined;

/**
 * Repaint hook. The view registers here so redraws are driven by the
 * token stream itself; a fixed timer can only sample it, which is what
 * made the subagent view step in chunks while main looked smooth.
 */
export function onStream(fn: StreamListener | undefined) {
	listener = fn;
}

function notifyStream(runId: string) {
	try {
		listener?.(runId);
	} catch {}
}

export function attachStream(rec: RunRecord, session: any) {
	try {
		rec.unstream?.();
	} catch {}
	rec.unstream = session?.subscribe?.((ev: any) => {
		try {
			if (ev?.type === "message_update" && ev.message?.role === "assistant") {
				rec.streamMsg = ev.message;
				// Drive the repaint from the token stream itself. A fixed
				// timer can only sample it, which is what made the subagent
				// view step in chunks while main — repainted per update —
				// looked smooth.
				notifyStream(rec.run.id);
			} else if (ev?.type === "tool_execution_start") {
				// status's "last tools" across EVERY turn, not just the first
				// (stress audit #10): the spawn path's own subscriber used to be
				// the only writer and it unsubscribes at the first turn's end.
				rec.activity.push(`⚙ ${ev.toolName ?? "tool"}`);
				if (rec.activity.length > 32) rec.activity.splice(0, rec.activity.length - 32);
			} else if (ev?.type === "tool_execution_end") {
				// A tool's result the moment it exists. pi appends a batch's
				// results to the agent's state only after the slowest call, and
				// a child session forwards no tool-result message event — only
				// this one (probed 2026-08-29) — so the view merges these, in
				// the state's own message shape, ahead of the state and drops
				// each once the state carries it (surface.ts childKids).
				const id = String(ev.toolCallId ?? "");
				if (id) {
					(rec.liveToolResults ??= new Map()).set(id, {
						role: "toolResult",
						toolCallId: id,
						toolName: ev.toolName,
						content: ev.result?.content ?? [],
						details: ev.result?.details,
						isError: !!ev.isError,
						timestamp: Date.now(),
					});
					notifyStream(rec.run.id);
				}
			} else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
				// Keep the finalised message here rather than dropping it.
				// The renderer hands off to the persisted entry only once
				// that entry actually exists, which avoids a frame where
				// neither copy is on screen.
				rec.streamMsg = ev.message;
			}
			// NOT cleared on agent_settled. The renderer decides when to let
			// go, by checking whether the persisted entry has caught up —
			// clearing it here raced the pager's refresh and reopened the
			// handoff gap. It is reset at the start of the next turn instead.
		} catch {}
	});
}
