/**
 * What died with a session, told once to whoever it belonged to.
 *
 * A session end — /reload, /new, /resume, /fork, quit, a terminal closing, a
 * crash — kills every working run and every background bash job of that
 * session. Each death is recorded where it can be read later (a run's
 * manifest, a job's manifest beside it), and this module turns the unreported
 * ones into ONE delivery-shaped message: for main at the next session_start
 * of that session (index.ts), and for a run that is continued after its
 * agents died with it (agents/session.ts, through the hook below — agents/
 * cannot import tools/). Each item is marked reported so it is told once.
 *
 * The sentences are the delivery grammar the renderers already read:
 *   Agent "title" (agent) was stopped by the session ending (/reload) after Ns:
 *   Background bash "title" was stopped by the session ending (/reload) after Ns:
 */

import { AGENT_DELIVERY } from "./agent.ts";
import { deliveryLineFor, killedJobs, markJobReported, type JobManifest } from "./bash-background.ts";
import { batchDeliveryLine } from "./delivery.ts";
import { appendStamp } from "../util/stamp.ts";
import { SESSION_END, descendantRuns, knownRuns, whoStopped, writeManifest, type SubagentRun } from "../agents/run.ts";

export type Notice = { customType: string; content: string; display: boolean; details: Record<string, unknown> };

// A worker under a lead dies through the linked signal first, so its cause
// is the wrapped one: `stopped with its principal (stopped by the session
// ending (/reload))` — read through the wrapper (whoStopped does the same).
// The pre-2026-08-29 "interrupted (session …)" manifests still count.
const isSessionDeath = (r: SubagentRun) =>
	(r.status === "stopped" || r.status === "error") && SESSION_END.test(r.error ?? "");

/** This session's runs that died with a session end and were never told to main. */
export function deadRunsForMain(owner: string | null): SubagentRun[] {
	if (!owner) return [];
	return [...knownRuns.values()].filter((r) => r.ownerSession === owner && isSessionDeath(r) && !r.reported);
}

/** A run's descendants that died with a session end and were never told to it. */
export function deadRunsForPrincipal(runId: string): SubagentRun[] {
	return descendantRuns(runId).filter((r) => isSessionDeath(r) && !r.reportedToPrincipal);
}

function runSection(r: SubagentRun, readerId: string | null): string {
	const secs = Math.max(0, Math.round(((r.endedAt ?? r.startedAt) - r.startedAt) / 1000));
	const who = whoStopped(r.error ?? "", r, { reader: "principal", readerId });
	return `Agent "${r.title}" (${r.agent}) was stopped by ${who} after ${secs}s:\n\nIts work up to then is in its transcript; message it to continue.\n\n[agent id: ${r.id}]`;
}

function jobSection(j: JobManifest): string {
	const secs = Math.max(0, Math.round(((j.killedAt ?? j.startedAt) - j.startedAt) / 1000));
	const who = whoStopped(j.killed ?? "stopped by pi exiting", undefined, { reader: "principal", readerId: null });
	return `Background ${j.tool ?? "bash"} "${j.title}" was stopped by ${who} after ${secs}s:\n\nIts output was not delivered.\n\n[run id: ${j.id}]`;
}

/**
 * One message for the runs and jobs given, marked reported as it is built:
 * `reported` (main's) or `reportedToPrincipal` (a continued run's) on each
 * run manifest, `reported` on each job manifest. undefined when nothing.
 */
export function interruptedNotice(
	runs: SubagentRun[],
	jobs: JobManifest[],
	readerId: string | null,
): Notice | undefined {
	const sections: string[] = [];
	for (const r of runs) {
		if (readerId === null) r.reported = true;
		else r.reportedToPrincipal = true;
		writeManifest(r);
		sections.push(runSection(r, readerId));
	}
	for (const j of jobs) {
		markJobReported(j);
		sections.push(jobSection(j));
	}
	if (!sections.length) return undefined;
	const single = sections.length === 1;
	const customType = single ? (runs.length ? "agent-result" : "bash-result") : "background-results";
	const provenance = single
		? runs.length
			? AGENT_DELIVERY
			: deliveryLineFor(jobs[0]?.tool ?? "bash")
		: batchDeliveryLine([
				...runs.map(() => "agent" as const),
				...jobs.map((j) => (j.tool === "powershell" ? ("powershell" as const) : ("bash" as const))),
			]);
	return {
		customType,
		content: appendStamp(`${provenance}\n\n${sections.join("\n\n")}`),
		display: true,
		details: { aborted: [...runs.map((r) => r.id), ...jobs.map((j) => j.id)] },
	};
}

/** Main's notice at a session start: the dead runs of this session plus its killed jobs. */
export function noticeForMain(owner: string | null): Notice | undefined {
	return interruptedNotice(deadRunsForMain(owner), owner ? killedJobs() : [], null);
}

/** A continued run's notice: its agents that died with the session, ahead of its next turn. */
export function noticeForRun(runId: string): Notice | undefined {
	return interruptedNotice(deadRunsForPrincipal(runId), [], runId);
}
