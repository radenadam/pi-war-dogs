/**
 * Feature toggles, read from settings.json:
 *
 *   { "war-dogs": { "banner": false, "pager": true } }
 *
 * Everything defaults ON. Nothing here is hardcoded behaviour — this is
 * the seam that lets you drop a feature from the war-dogs bundle without
 * editing code. It is orthogonal to the MASTER switch (`war-dogs.enabled`,
 * read in mode.ts): `enabled` decides whether war-dogs mode boots on at all;
 * these keys decide what "on" includes.
 */

import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentDir } from "./agents/run.ts";

/**
 * Project trust, mirrored from pi. pi ignores `<cwd>/.pi/settings.json`
 * entirely unless the project is trusted (`setProjectTrusted(false)` blanks
 * it), so war-dogs must too — reading it regardless booted war-dogs OFF from
 * a project file pi had refused to load, and made the MCP adapter yield to a
 * `packages` entry pi never installed. Before pi tells us (session_start,
 * `ctx.isProjectTrusted()`), the decision store on disk is consulted; an
 * undecided project counts as untrusted, exactly as pi treats it until the
 * user answers its prompt.
 *
 * pi's TRUE is consent only when pi had something to decide (2026-08-28,
 * the inject wire test): main.js resolves `projectTrusted` as
 * `!hasTrustRequiringProjectResources(cwd) || store.get(cwd) === true`, so
 * a project with none of PI's trust-requiring resources is reported
 * trusted without a prompt and REGARDLESS of the store — an explicitly
 * refused project included (demonstrated: store `false`, `.pi/inject/`
 * files rode). pi's list does not know war-dogs' own project resources
 * (`.pi/inject/`, `.pi/memory/`, `.pi/subagents/`), so for those the
 * shortcut is not consent: a live TRUE counts when pi actually resolved
 * trust (its resources present — the prompt, a session-only answer, or
 * the store); otherwise the store alone decides, and a project pi never
 * asked about stays untrusted for war-dogs until the user says so
 * (`/trust` in pi writes the same store; `--approve` for one run).
 */
let projectTrusted: boolean | null = null;
/**
 * Trust is a BOOT state (pi's own /trust says "restart for this to take
 * effect"), and the gate is consulted by settings readers on hot paths, so
 * the two disk answers below are memoised per cwd and dropped when pi
 * hands us a fresh live answer at session_start.
 */
const trustMemo = new Map<string, boolean>();
export function setProjectTrusted(v: boolean) {
	projectTrusted = v;
	trustMemo.clear();
}
function memo(key: string, compute: () => boolean): boolean {
	const hit = trustMemo.get(key);
	if (hit !== undefined) return hit;
	const v = compute();
	trustMemo.set(key, v);
	return v;
}
/** pi's remembered decision for this cwd (nearest ancestor), `true` only when it says so. */
function storeTrusted(cwd: string): boolean {
	return memo(`store:${cwd}`, () => {
		try {
			return new ProjectTrustStore(agentDir()).get(cwd) === true;
		} catch {
			return false;
		}
	});
}
/** Whether pi itself would have resolved trust here (its own trust-requiring resources exist). */
function piHadSomethingToDecide(cwd: string): boolean {
	return memo(`pi:${cwd}`, () => {
		try {
			return hasTrustRequiringProjectResources(cwd) === true;
		} catch {
			return false;
		}
	});
}
export function projectAllowed(): boolean {
	// pi's CLI flags override its store and its prompt: --approve/-a trusts,
	// --no-approve/-na ignores project files for this run. Same precedence
	// here, and they win over the live answer too — they ARE the user's word.
	const argv = process.argv.slice(2);
	if (argv.includes("--no-approve") || argv.includes("-na")) return false;
	if (argv.includes("--approve") || argv.includes("-a")) return true;
	const cwd = process.cwd();
	if (projectTrusted === false) return false;
	if (projectTrusted === true && piHadSomethingToDecide(cwd)) return true;
	// pi's own order (core/project-trust.js): the store's decision, then the
	// user's global `defaultProjectTrust` (always | never | ask); "ask" with
	// nobody asked is not consent. Until 2026-08-30 the store alone decided
	// here, so a user whose policy was "always" saw war-dogs refuse the
	// project's inject/memory/subagents that pi itself had allowed.
	const stored = storeDecision(cwd);
	if (stored !== null) return stored;
	const policy = defaultProjectTrust();
	if (policy === "always") return true;
	return false;
}

/** pi's remembered decision for this cwd (nearest ancestor): true, false, or null when never asked. */
function storeDecision(cwd: string): boolean | null {
	try {
		return new ProjectTrustStore(agentDir()).get(cwd);
	} catch {
		return null;
	}
}

/** The user's global fallback policy (`defaultProjectTrust`, global settings only, as pi reads it). */
export function defaultProjectTrust(): "ask" | "always" | "never" {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
		const v = raw?.defaultProjectTrust;
		return v === "always" || v === "never" ? v : "ask";
	} catch {
		return "ask";
	}
}

/**
 * war-dogs' OWN project resources that pi's trust prompt does not know
 * about, present under `<cwd>/.pi/` while the project is NOT allowed and
 * pi has recorded NO decision (an explicit refusal is the user's word and
 * is not nagged). index.ts names them once per session so the user knows
 * why they are not riding and what allows them (`/trust`).
 */
export function unconsentedProjectResources(): string[] {
	const cwd = process.cwd();
	if (projectAllowed()) return [];
	try {
		if (new ProjectTrustStore(agentDir()).get(cwd) !== null) return [];
	} catch {
		return [];
	}
	// A global "never" is the user's word too: refused by policy, not nagged.
	if (defaultProjectTrust() === "never") return [];
	return ["inject", "memory", "subagents"].filter((d) => {
		try {
			return fs.existsSync(path.join(cwd, ".pi", d));
		} catch {
			return false;
		}
	});
}

/**
 * Trust for a CHILD's cwd (2026-08-27, the child stress-test finding): a
 * fresh SettingsManager defaults projectTrusted TRUE, so child loaders
 * built without one loaded an UNTRUSTED project's .pi/SYSTEM.md and
 * .pi/settings.json — main gates these, children did not. The parent's
 * live answer covers its own cwd; any other cwd is decided by pi's trust
 * STORE alone (nearest ancestor), and undecided means untrusted, exactly
 * as pi treats it until the user answers its prompt.
 */
export function childProjectTrusted(cwd: string): boolean {
	try {
		if (path.resolve(cwd) === path.resolve(process.cwd())) return projectAllowed();
		return storeTrusted(cwd);
	} catch {
		return false;
	}
}

/** The settings files pi reads, project first — the project one only when trusted. */
export function settingsPaths(): string[] {
	const out: string[] = [];
	if (projectAllowed()) out.push(path.join(process.cwd(), ".pi", "settings.json"));
	out.push(path.join(agentDir(), "settings.json"));
	return out;
}

/**
 * The one settings.json reader. Project settings first (when trusted), then
 * the agent dir; the first file whose parse yields a defined pick wins —
 * right for a SINGLE key (`theme`, `packages` are collected separately).
 * Unreadable/unparsable files are skipped.
 */
export function findSettings<T>(pick: (cfg: Record<string, unknown>) => T | undefined): T | undefined {
	for (const p of settingsPaths()) {
		try {
			const v = pick(JSON.parse(fs.readFileSync(p, "utf8")));
			if (v !== undefined) return v;
		} catch {}
	}
	return undefined;
}

/** Like findSettings, but every file's defined pick, project first (for keys that ACCUMULATE, e.g. `packages`). */
export function collectSettings<T>(pick: (cfg: Record<string, unknown>) => T | undefined): T[] {
	const out: T[] = [];
	for (const p of settingsPaths()) {
		try {
			const v = pick(JSON.parse(fs.readFileSync(p, "utf8")));
			if (v !== undefined) out.push(v);
		} catch {}
	}
	return out;
}

/**
 * The `war-dogs` block as pi would see it: the agent-dir block with the
 * (trusted) project block merged over it PER KEY — pi deep-merges global and
 * project settings. The old "first file with a block wins" made a project
 * `{"loader": false}` erase the agent dir's `mcp:false`, `banner:false` and
 * even its `theme` (demonstrated), and let the master switch and the feature
 * keys resolve from DIFFERENT files.
 */
export function warDogsBlock(): Record<string, unknown> {
	const blocks = collectSettings((cfg) => {
		const f = cfg?.["war-dogs"];
		return f && typeof f === "object" ? (f as Record<string, unknown>) : undefined;
	});
	// collectSettings is project-first; merge so the project wins per key.
	const merged: Record<string, unknown> = {};
	for (const b of [...blocks].reverse()) Object.assign(merged, b);
	return merged;
}

/**
 * The per-tool options pi hands its OWN built-ins (agent-session.js
 * `_buildRuntime` → `createAllToolDefinitions(cwd, {read, bash})`), read the
 * way pi reads them: `settings.shellPath` (tilde-expanded), `shellCommandPrefix`,
 * `images.autoResize` (default true). An extension tool REPLACES a built-in by
 * name, so a re-registration built without these silently ran the model's
 * commands in a different shell, without the user's prefix, and sent images
 * unresized — with the master switch on AND off (demonstrated: `--no-extensions`
 * → dash + prefix var set; war-dogs → bash, unset). Both re-registration paths
 * (the ON skins in tools/read|bash.ts and the OFF definitions in index.ts) call
 * this so they are byte-for-byte what stock builds.
 */
export function stockToolOptions(): {
	read: { autoResizeImages: boolean };
	bash: { commandPrefix?: string; shellPath?: string };
} {
	const shellPath = findSettings((cfg) => (typeof cfg?.shellPath === "string" ? (cfg.shellPath as string) : undefined));
	const commandPrefix = findSettings((cfg) =>
		typeof cfg?.shellCommandPrefix === "string" ? (cfg.shellCommandPrefix as string) : undefined,
	);
	const autoResize = findSettings((cfg) => {
		const v = (cfg?.images as any)?.autoResize;
		return typeof v === "boolean" ? v : undefined;
	});
	const home = process.env.HOME || os.homedir();
	const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
	return {
		read: { autoResizeImages: autoResize ?? true },
		bash: {
			...(shellPath ? { shellPath: expand(shellPath) } : {}),
			...(commandPrefix !== undefined ? { commandPrefix } : {}),
		},
	};
}

export interface Features {
	pager: boolean;
	subagent: boolean;
	tools: boolean;
	toolRenderers: boolean;
	banner: boolean;
	footer: boolean;
	loader: boolean;
	attachments: boolean;
	/** The war-dogs palette: `/war-dogs on` writes it into `settings.theme` (off restores yours); a string here names it. */
	theme: boolean;
	/** The bundled MCP adapter (pi-mcp-adapter): `mcp`/`mcpScript`/direct tools, `/mcp`, footer status. */
	mcp: boolean;
	/** The default browser: the bundled `@playwright/mcp`, registered at runtime as the MCP server `playwright` (rides `mcp`). Off: no default. A `playwright` server of your own in any mcp.json wins either way. */
	playwright: boolean;
	/** The inherent system prompt + first-turn session brief (prompt/). Off: pi's stock prompt, no brief. A user SYSTEM.md always wins either way. */
	prompt: boolean;
	/** The /canvas serve command (tools/canvas.ts). Off: no command; the pager's canvas act is pager-side sugar and rides `pager`. */
	canvas: boolean;
	/** The user's injected messages (prompt/inject.ts): `inject/SESSION_START.md` once per session, `inject/PER_TURN.md` every turn, global and trusted-project. Off: nothing read, nothing injected. */
	inject: boolean;
	/** Peer sessions (2026-08-25): the registry + socket that make this session addressable by other pi sessions, and its own reach to them. Off: no socket, not addressable, no Peers anywhere; agents unaffected. */
	peers: boolean;
}

export const DEFAULTS: Features = {
	pager: true,
	subagent: true,
	tools: true,
	toolRenderers: true,
	banner: true,
	footer: true,
	loader: true,
	attachments: true,
	theme: true,
	mcp: true,
	playwright: true,
	peers: true,
	prompt: true,
	canvas: true,
	inject: true,
};

export function features(): Features {
	const block = warDogsBlock();
	const out: Features = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS) as (keyof Features)[]) {
		const v = k === "attachments" && block.attachments === undefined ? block.paster : block[k];
		// Booleans toggle. `theme` doubles as the theme NAME (a string keeps
		// the feature on — see mode.ts warDogsThemeName); nothing else in the
		// block (`enabled`, `expect`, `theme` as a name) is a feature.
		if (typeof v === "boolean") out[k] = v;
		else if (k === "theme" && typeof v === "string") out.theme = true;
	}
	return out;
}
