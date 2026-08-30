/**
 * The bundled MCP adapter — pi-mcp-adapter, shipped inside war-dogs and
 * installed only when war-dogs is on at boot (index.ts installOnce).
 *
 * war-dogs is self-contained: a user who wants MCP gets it by installing
 * war-dogs, and a user who turns war-dogs off gets stock pi with no MCP tool,
 * no `/mcp`, no footer status and no server processes — structurally, because
 * off is a boot that never calls register() (control is settings-only; see
 * mode.ts). What this module adds while ON is REACH: it records what the
 * adapter registers so the pager's toolmap renders MCP calls in a subagent
 * transcript and children are handed the adapter's tools.
 *
 * HOW: the adapter's factory is invoked with a FACADE of pi's ExtensionAPI
 * (`hostFor`) instead of the real one. The facade forwards everything to pi —
 * events, commands, flags, the active set — and RECORDS at two points:
 *
 *   registerTool      — remembers the tool names and definitions (the
 *                       direct-tool set is dynamic: `<server>_<tool>` names
 *                       appear after an async init) for the pager's toolmap,
 *                       the children and index.ts's canonical active order.
 *   setActiveTools    — the adapter's own intent for its tools (`wanted`):
 *                       what it wants active, never a tool it deactivated.
 *                       The write itself goes to pi untouched.
 *
 * The adapter receives pi's events directly (session_start, session_shutdown,
 * everything else), exactly as a standalone extension would; its
 * session_start handler was registered during load (installOnce), so it runs
 * BEFORE index.ts's own session_start handler, which then puts the custom
 * tools into the active set in canonical order (activateCustomTools).
 *
 * (The facade used to carry a live-off mode — a virtual active set, command
 * refusal, captured/dispatched events, skill parking. Control is settings-only
 * now, a boot-off never calls register(), and all of that was deleted.)
 *
 * ONE INSTANCE PER FACTORY INVOCATION. pi re-runs the factory on /new, /fork
 * and /resume against a fresh Extension object without re-importing the
 * module (only /reload and a cwd change re-import), so register() resets
 * every record before installing a new instance — exactly what a standalone
 * extension gets. See register().
 *
 * The `mcp-scripting` skill the adapter ships is offered to pi through
 * `resources_discover` (which follows session_start), so pi loads it with
 * its own loader and the system prompt carries it exactly once.
 *
 * A machine that already has pi-mcp-adapter installed as a pi PACKAGE
 * (`settings.packages`) must not get a second copy: pi keeps both loaded but
 * files a "Tool mcp conflicts with …" diagnostic and EXITS with code 1 in
 * every mode (main.js: any error diagnostic → process.exit(1)) — pi would not
 * start at all, with a message that names the conflict but not the fix. So
 * register() YIELDS: if any settings file lists a pi-mcp-adapter package, the
 * bundled copy is skipped, the user's own package keeps working exactly as
 * before (it is theirs, so it also stays on while war-dogs is off — "whatever
 * the user has with stock"), and a notice at session_start says how to switch
 * to the bundled one (`pi remove npm:pi-mcp-adapter`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSettings } from "../settings.ts";
import { findChromeOnPath } from "../util/chrome.ts";
import { withStamp } from "../util/stamp.ts";

/** Every tool the adapter has registered, by name (grows after async init). */
const toolNames = new Set<string>();
/** The latest definition the adapter registered under each name. */
const defs = new Map<string, any>();
/** The MCP tools the adapter wants ACTIVE (its own setActiveTools writes). */
const wanted = new Set<string>();

let onToolRegistered: ((def: any) => void) | null = null;
/** The settings.packages entry that made us yield, if any. */
let yieldedTo: string | null = null;
let noticed = false;

/** All MCP tool names, in first-registration order — index.ts's canonical active order and the subagent schema enum. */
export function allToolNames(): string[] {
	return [...toolNames];
}

/** The MCP tools the adapter wants active — the ones index.ts puts into the canonical active order. */
export function wantedToolNames(): string[] {
	return [...wanted];
}

/**
 * The MCP tool DEFINITIONS a child session should carry — what the adapter
 * currently wants active. Children load no extensions, so without this the
 * subagent schema offered `mcp` in its `tools` enum with no definition behind
 * the name (the same silent gap childtools.ts records for webfetch). The
 * adapter's execute reads only (id, params, signal) and its own in-process
 * state, so a child's call runs on the parent's servers.
 */
export function childToolDefs(): any[] {
	return [...wanted].map((n) => defs.get(n)).filter(Boolean);
}

/** Forget the previous adapter instance's registrations. */
function resetInstance(): void {
	toolNames.clear();
	defs.clear();
	wanted.clear();
}

function isMcpName(name: string): boolean {
	return toolNames.has(name);
}

/**
 * The facade the adapter is installed with. A Proxy over the real API: every
 * member not listed here is the real one (bound, so `this` is never ours).
 */
function hostFor(pi: ExtensionAPI): ExtensionAPI {
	const overrides: Record<string, unknown> = {
		registerTool(def: any) {
			const name = String(def?.name ?? "");
			if (name) {
				toolNames.add(name);
				wanted.add(name);
				defs.set(name, def);
			}
			// Every adapter tool's results carry the [at …] stamp too (one wrap
			// point for the gateway, mcpScript and every direct tool).
			withStamp(def);
			pi.registerTool(def);
			try {
				onToolRegistered?.(def);
			} catch {}
		},
		setActiveTools(list: string[]) {
			const names = Array.isArray(list) ? list.map(String) : [];
			// The adapter's intent for its own tools; the write goes through untouched.
			for (const n of toolNames) if (!names.includes(n)) wanted.delete(n);
			for (const n of names) if (isMcpName(n)) wanted.add(n);
			pi.setActiveTools(names);
		},
	};
	// pi may grow an unregisterTool (the adapter already probes for one);
	// keep our sets honest if it does.
	if (typeof (pi as any).unregisterTool === "function") {
		overrides.unregisterTool = (name: string) => {
			const r = (pi as any).unregisterTool(name);
			if (r === true) {
				toolNames.delete(name);
				wanted.delete(name);
			}
			return r;
		};
	}
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop];
			const v = Reflect.get(target, prop, receiver);
			return typeof v === "function" ? v.bind(target) : v;
		},
	}) as ExtensionAPI;
}

/** The war-dogs folder (this file's parent), where node_modules lives. */
function packageRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The adapter's own skills dir (its `mcp-scripting` skill), if present. */
function skillsDir(): string | null {
	try {
		const dir = path.join(packageRoot(), "node_modules", "pi-mcp-adapter", "skills");
		return fs.existsSync(dir) ? dir : null;
	} catch {
		return null;
	}
}

/** The name the default browser server is registered under — the name a user's own entry replaces. */
export const DEFAULT_BROWSER_SERVER = "playwright";

/**
 * The default browser: `@playwright/mcp` (bundled, pinned in package.json,
 * run with the node that runs pi — no npx, no network, no `@latest` drift)
 * registered on the adapter at RUNTIME under the name `playwright`, never
 * written to any file. The adapter's `registerMcpServer` is what makes the
 * precedence structural: a configured `playwright` (any mcp.json, `/mcp
 * setup`) makes it THROW "already registered", so the user's entry is the one
 * that runs and this one is silently skipped; a runtime server is proxy-only
 * (reached through the `mcp` gateway, the same surface a file entry gets by
 * default since `directTools` defaults to off) and lazy (Chrome launches on
 * the model's first call, never at boot); and it dies with the adapter
 * instance, so off registers nothing and `/new`/`/fork`/`/resume` re-register
 * through register(). The alternatives were rejected on demonstration: a
 * programmatic `config` makes the adapter skip every config FILE and disables
 * `/mcp setup`, enable/disable and the panel; writing a default mcp.json is a
 * file the user cannot delete without it coming back.
 *
 * Chrome is the one war-dogs already assumes: the PATH probe WebFetch's
 * render tier uses (`--executable-path`), else Playwright's own `chrome`
 * channel lookup, which finds Chrome where it is not on PATH (macOS,
 * Windows). Nothing else is passed on purpose — playwright-mcp itself goes
 * headless when there is no display (demonstrated: Chrome's argv carries
 * `--headless --ozone-platform=headless` with DISPLAY unset, nothing with
 * it set), disables the Chrome sandbox by default (root in a container
 * works), and keeps a persistent profile under
 * `~/.cache/ms-playwright-mcp/` so logins survive.
 */
function registerDefaultBrowser(host: ExtensionAPI, mod: any): void {
	const cli = path.join(packageRoot(), "node_modules", "@playwright", "mcp", "cli.js");
	if (!fs.existsSync(cli)) {
		console.error(
			"[war-dogs] mcp: no default browser server — @playwright/mcp is missing from war-dogs/node_modules (run `npm install` in the war-dogs folder).",
		);
		return;
	}
	const chrome = findChromeOnPath();
	const args = chrome ? [cli, "--browser", "chromium", "--executable-path", chrome] : [cli, "--browser", "chrome"];
	try {
		mod.registerMcpServer({
			pi: host,
			name: DEFAULT_BROWSER_SERVER,
			definition: { command: process.execPath, args },
		});
	} catch (e: any) {
		// "already registered": the user has a `playwright` server of their own — theirs runs.
		if (!/already registered/.test(String(e?.message ?? e)))
			console.error("[war-dogs] mcp: default browser server not registered:", e?.message ?? e);
	}
}

/**
 * Load-once: import the adapter and install it against the facade. Async so a
 * broken or missing dependency degrades to "war-dogs without MCP" (reported
 * on stderr) instead of taking the whole extension down.
 */
export async function register(
	pi: ExtensionAPI,
	opts?: { onToolRegistered?: (def: any) => void; playwright?: boolean },
): Promise<void> {
	// pi re-runs every extension factory on /new, /fork and /resume with a
	// FRESH Extension object (new tools/commands/flags/handlers maps) but,
	// unlike /reload, WITHOUT re-importing the module — so this function runs
	// again with the module's state intact. The previous adapter instance was
	// already shut down by pi's session_shutdown and its handlers live on the
	// discarded object; a standalone extension gets a brand-new instance here
	// too. Start clean: the old facade once kept captured handlers across
	// this and dispatched session_start to N instances, and a stale forwarding
	// set left the new object with NO shutdown forwarder, so servers outlived
	// pi (demonstrated: fake stdio server SIGHUP'd by tmux after pi had exited).
	resetInstance();
	onToolRegistered = opts?.onToolRegistered ?? null;
	yieldedTo = foreignAdapterPackage();
	if (yieldedTo) {
		console.error(`[war-dogs] mcp: skipping the bundled MCP adapter — \`${yieldedTo}\` is installed as a pi package.`);
		return;
	}
	const mod: any = await import("pi-mcp-adapter");
	const factory = typeof mod?.default === "function" ? mod.default : mod?.createMcpAdapter?.();
	if (typeof factory !== "function") throw new Error("pi-mcp-adapter exports no factory");
	const host = hostFor(pi);
	factory(host);
	// The default browser rides the same instance: the registrar is keyed on
	// the object the factory was installed with, so it must be `host`.
	if (opts?.playwright !== false) registerDefaultBrowser(host, mod);
	// The adapter's `mcp-scripting` skill, offered to pi's own loader
	// (resources_discover follows session_start), so the system prompt
	// carries it exactly once.
	pi.on("resources_discover", async () => {
		const dir = skillsDir();
		return dir ? { skillPaths: [dir] } : {};
	});
}

/** Once per process, in the TUI: why the bundled adapter is not the one running (index.ts activate). */
export function noticeIfYielded(ctx: ExtensionContext): void {
	if (!yieldedTo || noticed) return;
	noticed = true;
	try {
		if ((ctx as any)?.hasUI)
			ctx.ui.notify(
				`war-dogs bundles the MCP adapter, but \`${yieldedTo}\` is installed as a package, so the bundled one is skipped. ` +
					"To use the bundled copy (and have MCP follow /war-dogs on|off): `pi remove npm:pi-mcp-adapter`.",
				"warning",
			);
	} catch {}
}

/**
 * A pi-mcp-adapter package in either settings file (`npm:pi-mcp-adapter`,
 * `npm:pi-mcp-adapter@2.25.0`, a git URL or a local path to a checkout — the
 * name is matched as a substring). Returns the entry, or null.
 */
function foreignAdapterPackage(): string | null {
	for (const list of collectSettings((cfg) =>
		Array.isArray(cfg?.packages) ? (cfg.packages as unknown[]) : undefined,
	)) {
		for (const entry of list) {
			const spec = typeof entry === "string" ? entry : ((entry as any)?.source ?? "");
			if (typeof spec === "string" && /pi-mcp-adapter/.test(spec)) return spec;
		}
	}
	return null;
}
