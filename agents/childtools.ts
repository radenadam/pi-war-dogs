/**
 * Tools that every child session must be handed explicitly.
 *
 * Children are built with `noExtensions: true`, so war-dogs itself never
 * loads inside one. Anything war-dogs registers on the parent through
 * `pi.registerTool()` — webfetch, kimi-websearch — therefore does NOT
 * exist in a child unless it is passed as `customTools`.
 *
 * Before this, a subagent asked to report its own toolset correctly said
 * webfetch and kimi-websearch were "not available (only appears as an
 * allowlist option)": naming them in `tools` let them through the
 * allowlist but there was no definition behind the name.
 *
 * Set by index.ts. Read by BOTH child paths — tools/subagent.ts when a run
 * is spawned and agents/session.ts when one is rehydrated — because a
 * resumed run must come back with the same capabilities it had.
 *
 * Lives in agents/ rather than tools/ so agents/ never has to import
 * tools/; that would close the tools -> agents cycle the childToolFactory
 * indirection exists to avoid.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { warDogsBlock } from "../settings.ts";

/**
 * The stock nav tools trimmed from children (2026-08-27, the same switch as
 * main's active set): a child session is built by createAgentSession, which
 * DEFINES grep/find/ls regardless, so the trim must ride excludeTools on
 * BOTH build paths. `war-dogs.stockTools: true` restores them (enum included).
 * powershell follows main (index.ts activateCustomTools): where main has it
 * (Windows), a child is handed the powershell skin through the keyed source
 * and the name is not excluded; elsewhere it is excluded as the dead tool it
 * is off Windows.
 */
export function stockTrimExclusions(): string[] {
	if (warDogsBlock().stockTools === true) return [];
	return powershellAvailable ? ["grep", "find", "ls"] : ["grep", "find", "ls", "powershell"];
}
let powershellAvailable = false;
/** Set by index.ts after the active set is known: powershell is in main's active set (Windows). */
export function setPowershellAvailable(v: boolean): void {
	powershellAvailable = v;
}
export function isPowershellAvailable(): boolean {
	return powershellAvailable;
}

type Def = ToolDefinition<any, any, any>;

let extras: Def[] = [];
/**
 * LIVE sources, consulted at build time: the bundled MCP adapter's tool set
 * is dynamic (per-server direct tools appear after an async init, and the
 * adapter deactivates tools it no longer offers), so it cannot be a fixed
 * list — index.ts wires `() => mcp.childToolDefs()` here. Each source is a
 * function of the CHILD's cwd (2026-08-22): the built-in skins resolve
 * relative paths and run commands against the cwd they were built with, so
 * a child with its own `cwd` must get skins built for it — the parent's
 * read skin, handed over as-is, resolved a child's relative paths against
 * the PARENT's cwd. Sources that do not care (MCP) ignore the argument.
 */
const sources = new Map<string, (cwd: string) => Def[]>();

export function setChildExtraTools(defs: Def[]) {
	extras = defs;
}

/**
 * Keyed, so the factory re-running on /new, /fork, /resume (pi re-runs it
 * without re-importing the module) REPLACES a source instead of stacking a
 * new closure per session — an unkeyed push grew by one per switch.
 */
export function setChildExtraToolsSource(key: string, fn: (cwd: string) => Def[]) {
	sources.set(key, fn);
}

/** The static extras plus every live source built for the child's cwd, deduped by name (first wins). */
export function childExtraTools(cwd: string): Def[] {
	const out: Def[] = [];
	const seen = new Set<string>();
	for (const d of [...extras, ...[...sources.values()].flatMap((f) => safeCall(f, cwd))]) {
		if (!d?.name || seen.has(d.name)) continue;
		seen.add(d.name);
		out.push(d);
	}
	return out;
}

function safeCall(f: (cwd: string) => Def[], cwd: string): Def[] {
	try {
		return f(cwd) ?? [];
	} catch {
		return [];
	}
}

/**
 * Every tool name a CHILD can actually be given.
 *
 * Three sources, and only these three: pi's own built-ins (a child session
 * is built by createAgentSession, which defines read/bash/edit/write plus
 * grep/find/ls whatever the parent has done to those names), the extras
 * above, and the `subagent` tool — handed down only while depth budget
 * remains.
 *
 * It exists because the subagent schema's `tools` enum used to be
 * `pi.getAllTools()`: the PARENT's set, which offers the model names from
 * every other installed extension that a child can never receive. pi drops
 * an unknown allowlist name in silence, so the run came back looking like a
 * subagent that had chosen not to use its tools. The names are asked of pi
 * rather than hardcoded, so a renamed built-in cannot rot into a lie.
 */
export function childToolNames(cwd: string, withSubagent = true): string[] {
	const names = new Set<string>();
	const trimmed = new Set(stockTrimExclusions());
	for (const make of [
		createReadToolDefinition,
		createBashToolDefinition,
		createEditToolDefinition,
		createWriteToolDefinition,
		createGrepToolDefinition,
		createFindToolDefinition,
		createLsToolDefinition,
	]) {
		try {
			const def = (make as (c: string) => { name?: string })(cwd);
			if (def?.name && !trimmed.has(def.name)) names.add(def.name);
		} catch {}
	}
	for (const d of childExtraTools(cwd)) if (d?.name) names.add(d.name);
	if (withSubagent) names.add("agent");
	return [...names];
}
