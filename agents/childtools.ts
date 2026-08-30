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
import { findSettings, warDogsBlock } from "../settings.ts";

/**
 * What a child must NOT have. Two lists in one answer, both riding
 * excludeTools on BOTH build paths, because a child session is built by
 * createAgentSession, which DEFINES pi's built-ins regardless of anything
 * main did to those names:
 *  - the stock nav tools (2026-08-27, the same switch as main's active set);
 *    `war-dogs.stockTools: true` restores them (enum included);
 *  - the shell main does not have (2026-08-30, the maintainer's rule: ONE
 *    shell per platform — powershell on Windows, bash elsewhere — unless the
 *    user chose explicitly; index.ts activateCustomTools decides and publishes
 *    `setMainShells`). The skins follow the same answer (index.ts keyed
 *    sources), so a child never carries a shell main claims not to have.
 */
export function stockTrimExclusions(): string[] {
	const nav = warDogsBlock().stockTools === true ? [] : ["grep", "find", "ls"];
	return [...nav, ...(shells.bash ? [] : ["bash"]), ...(shells.powershell ? [] : ["powershell"])];
}
export interface Shells {
	bash: boolean;
	powershell: boolean;
}
/**
 * The shell answer, decided from what is known at LOAD: the platform, and
 * the user's explicit choice through pi's own knobs (`--tools`/`-t`,
 * `--exclude-tools`/`-xt`, `--no-tools`, `--no-builtin-tools` on the command
 * line; `defaultTools` in a settings file). It must exist before any
 * session_start handler runs: installOnce registers the agent tool — whose
 * handler bakes the `tools` enum — before the handler that sets the active
 * set, so an answer published only there reached the enum one boot late
 * (the ConPTY rig's first agent run: the enum offered bash, refused
 * powershell, `1 failed`). activateCustomTools enforces this same answer on
 * pi's active set and re-publishes what it actually ended with.
 */
export function decideShells(): { shells: Shells; explicit: boolean } {
	const argv = process.argv;
	const listArg = (long: string, short: string): string[] | null => {
		const i = argv.findIndex((a) => a === long || a === short);
		return i >= 0 && argv[i + 1]
			? String(argv[i + 1])
					.split(",")
					.map((s) => s.trim())
			: null;
	};
	if (
		argv.includes("--no-tools") ||
		argv.includes("-nt") ||
		argv.includes("--no-builtin-tools") ||
		argv.includes("-nbt")
	)
		return { shells: { bash: false, powershell: false }, explicit: true };
	const chosen =
		listArg("--tools", "-t") ??
		findSettings((cfg) => (Array.isArray(cfg?.defaultTools) ? (cfg.defaultTools as string[]) : undefined)) ??
		null;
	const excluded = new Set(listArg("--exclude-tools", "-xt") ?? []);
	if (chosen) {
		return {
			shells: {
				bash: chosen.includes("bash") && !excluded.has("bash"),
				powershell: chosen.includes("powershell") && !excluded.has("powershell"),
			},
			explicit: true,
		};
	}
	const win = process.platform === "win32";
	return {
		shells: { bash: !win && !excluded.has("bash"), powershell: win && !excluded.has("powershell") },
		explicit: false,
	};
}
/** Before installOnce publishes: the platform's answer. */
let shells: Shells = decideShells().shells;
/** Set by index.ts after the active set is known: the shell tools main has. */
export function setMainShells(v: Shells): void {
	shells = { ...v };
}
export function mainShells(): Shells {
	return { ...shells };
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
	// powershell is not in this list: where main has it, the keyed child source
	// hands the skin and its name arrives through the extras below.
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
