/**
 * The child prompt's application rules (2026-08-27, revised the same day:
 * SYSTEM.md is MAIN's — the maintainer's ruling — and stopped flowing to
 * children entirely; the user's child default is SUBAGENT_SYSTEM.md).
 *
 * BASE precedence for an adhoc child (call systemPrompt and a named
 * agent's body are handled by the callers above this):
 *   <cwd>/.pi/SUBAGENT_SYSTEM.md   (only when that cwd is TRUSTED)
 *   <agentDir>/SUBAGENT_SYSTEM.md
 *   BASE_PROMPT                     (MAIN's base, verbatim)
 * Always returns a base while the `prompt` feature is on, which is what
 * keeps a SYSTEM.md discovered by the child's loader from becoming the
 * child's prompt; `prompt: false` returns undefined and pi's stock
 * behaviour (its own SYSTEM.md rules included) is back.
 *
 * A child gets MAIN's base verbatim (2026-08-30, the maintainer's ruling;
 * from 2026-08-27 until then it was a GENERATED regrounding, prompt/child.ts,
 * "principal" for "user", with a facts paragraph in the rider). One prose,
 * one voice; everything that is different about being a subagent lives in
 * THE EXCHANGE BLOCK (childExchangeRider), appended at child build to
 * WHICHEVER base wins, on every path — the memory pattern: the boundary
 * mechanics are exactly what must survive user context engineering, so
 * they live in no base and depend on no tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "../agents/run.ts";
import { childProjectTrusted, features, findSettings } from "../settings.ts";
import { BASE_PROMPT } from "./base.ts";

function readIf(file: string): string | undefined {
	try {
		const t = fs.readFileSync(file, "utf8").trim();
		return t || undefined;
	} catch {
		return undefined;
	}
}

export function childBasePrompt(cwd: string): string | undefined {
	try {
		if (!features().prompt) return undefined;
	} catch {
		return undefined;
	}
	if (childProjectTrusted(cwd)) {
		const p = readIf(path.join(cwd, ".pi", "SUBAGENT_SYSTEM.md"));
		if (p) return p;
	}
	const g = readIf(path.join(agentDir(), "SUBAGENT_SYSTEM.md"));
	if (g) return g;
	return BASE_PROMPT;
}

/**
 * The user's child APPEND: SUBAGENT_APPEND_SYSTEM.md, project (when that
 * cwd is trusted) then global, the SUBAGENT_SYSTEM.md rule for appends
 * (2026-08-28, the maintainer's ruling on the stress report's A4: pi's
 * APPEND_SYSTEM.md is main's, like SYSTEM.md, and never reaches a child;
 * both build paths pass an explicit append list so pi's own discovery of
 * APPEND_SYSTEM.md never runs for a child).
 */
export function childAppendPrompt(cwd: string): string | undefined {
	try {
		if (!features().prompt) return undefined;
	} catch {
		return undefined;
	}
	if (childProjectTrusted(cwd)) {
		const p = readIf(path.join(cwd, ".pi", "SUBAGENT_APPEND_SYSTEM.md"));
		if (p) return p;
	}
	return readIf(path.join(agentDir(), "SUBAGENT_APPEND_SYSTEM.md"));
}

/** The facts of a child's own that the exchange block is built from (both build paths and the ask rebuild read the same object). */
export interface RiderFacts {
	/** Levels of agents it may start in turn (0 = no agent tool). */
	depth: number;
	/** Agents it may have working at once. */
	concurrency: number;
	/** Seconds per turn, or none. */
	timeout_s?: number;
	/** Whom message, wait and stop reach. */
	reach: "team" | "session";
}

/** The facts from a run's resolved config. */
export function riderFactsOf(cfg: Partial<RiderFacts> | undefined): RiderFacts {
	return {
		depth: Math.max(0, Math.floor(cfg?.depth ?? 0)),
		concurrency: Math.max(1, Math.floor(cfg?.concurrency ?? 8)),
		timeout_s: cfg?.timeout_s,
		reach: cfg?.reach === "session" ? "session" : "team",
	};
}

/** Whether pi's compaction is on in the settings in force (pi's own default: on). */
export function compactionOn(): boolean {
	try {
		const v = findSettings((cfg) => {
			const c = (cfg as Record<string, unknown>)?.compaction as { enabled?: unknown } | undefined;
			return c && typeof c === "object" && typeof c.enabled === "boolean" ? c.enabled : undefined;
		});
		return v !== false;
	} catch {
		return true;
	}
}

/**
 * THE EXCHANGE BLOCK (2026-08-30, the maintainer's wording, verbatim):
 * what a subagent is, how the provenance line of every message reads
 * (agents/session.ts provenanceLine states the relay), and the one-way
 * rule. Wrapped in <agent-exchange> tags so its voice is the TOOL's,
 * discrete from whatever prompt it rides (2026-08-28). Two facts of the
 * child's own are substituted at build: the ask sentence rides only where
 * the child HAS the agent tool (depth > 0; a depth-0 child cannot ask and
 * must not be told to), and the reach sentences ride only where its reach
 * is the whole session (team: dropped). The child's numbers themselves —
 * depth, concurrency, timeout, reach — are in its agent tool's parameter
 * descriptions (tools/agent.ts buildParams), never in prose.
 */
const EXCHANGE_WHAT =
	"You are a subagent, not the agent the user talks to. An agent delegated you, and the user can also chat with you. The first line of every message names who sent it, in the form [from ...], and tells you whether the final output of this turn goes back to the agent that started you. A turn that agent started is relayed to it. A turn the user started is not. A steer or a stop from the user in the middle of a turn does not change who started that turn.";
const EXCHANGE_ONE_WAY =
	"Communication is one way. When you have a question or a blocker, name what you lack rather than guess, and put it in your final output.";
const EXCHANGE_ASK =
	"When it needs no decision from the user, use ask first, because it reaches another agent's context without disturbing its work, and then say in your final output that you did, so the agent that started you can weigh what you resolved on your own.";
const EXCHANGE_REACH =
	"The agent that started you has granted you reach over the whole session, and message, wait and stop reach every agent of this session and its main agent as well, not just the agents you started. It gave you that for a reason, so treat it accordingly. Ask is still your first choice unless the work needs you to take part in another agent's work.";

/** The block for a child with these facts; the pure text, for the instruments. */
export function exchangeBlockText(f: RiderFacts): string {
	const hasAgentTool = f.depth > 0;
	const second = [
		EXCHANGE_ONE_WAY,
		hasAgentTool ? EXCHANGE_ASK : "",
		hasAgentTool && f.reach === "session" ? EXCHANGE_REACH : "",
	]
		.filter(Boolean)
		.join(" ");
	return `<agent-exchange>\n${EXCHANGE_WHAT}\n\n${second}\n</agent-exchange>`;
}

/**
 * The block as appended: on by DEFAULT over every base (the 2026-08-28
 * ruling — C with a switch); `agent.exchange: false` (the agent settings
 * block; `subagent` still read) turns the append off, leaving a custom
 * base's author to own the exchange rules. Off with the `prompt` feature
 * like the rest.
 */
export function childExchangeRider(facts: RiderFacts): string | undefined {
	try {
		if (!features().prompt) return undefined;
		const off = findSettings((cfg) => {
			for (const key of ["agent", "subagent"]) {
				const block = (cfg as Record<string, unknown>)?.[key];
				if (block && typeof block === "object" && (block as Record<string, unknown>).exchange !== undefined)
					return (block as Record<string, unknown>).exchange === false;
			}
			return undefined;
		});
		if (off === true) return undefined;
		return exchangeBlockText(facts);
	} catch {
		return undefined;
	}
}
