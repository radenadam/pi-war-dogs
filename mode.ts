/**
 * The master on/off switch. war-dogs is all-or-nothing: ON loads every
 * surface (pager, station, subagents, re-skinned HUD, extra tools); OFF is
 * 1:1 stock pi. There is no partial state — a pager-off-but-war-dogs-on
 * world loses the station and other pager-only affordances, so it is not
 * offered.
 *
 * CONTROL IS SETTINGS-ONLY. `war-dogs.enabled` in settings.json is the one
 * state (`bootEnabled`); `/war-dogs on|off` WRITES it (`writeEnabledSetting`,
 * with `settings.theme` saved/restored beside it) and reloads, so every on
 * and every off is a clean boot — index.ts registers everything at load when
 * on and nothing when off. There is no in-memory flag and no live apply:
 * this module owns the settings read/write, the war-dogs palette (the
 * pager's `visor` sub-theme object and the theme-file install) and the
 * definition of "busy" that refuses the switch mid-flight.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { agentDir, registry } from "./agents/run.ts";
import { importPiModule } from "./pidist.ts";
import { warDogsBlock } from "./settings.ts";

/**
 * war-dogs' palettes live in `visual/theme/*.json`. The MAIN theme is pi's:
 * `/war-dogs on` writes `settings.theme` to the war-dogs palette and reloads
 * (writeEnabledSetting), so pi applies it to chrome AND content in one pass;
 * `installThemes` copies the files into `<agentDir>/themes` so that name
 * resolves and `/settings → Theme` lists them. Only the pager's `visor`
 * sub-theme (the subagent view's canvas) is still built in memory, with pi's
 * own JSON→Theme loader (`loadThemeFromPath` from
 * `dist/modes/interactive/theme/theme.js`, reached through pidist.ts — not
 * exported from pi's package index; Upgrade Contract), because it is scoped
 * to that view, not pi's global theme. An in-memory apply of the MAIN theme
 * was tried and retracted: it ran after pi's reload had already rendered the
 * transcript, leaving content stale-cached in the old palette (README,
 * load-bearing).
 */
const WD_THEME_NAMES = ["canopy", "canopy-cobalt", "dune", "oxide", "visor"];
let themeLoader: ((p: string) => unknown) | null | undefined;
const themeCache = new Map<string, unknown>();

/** Load pi's theme module once (async); index.ts installOnce awaits this before the pager needs visor. */
export async function ensureThemeLoader(): Promise<void> {
	if (themeLoader !== undefined) return;
	const m = await importPiModule("modes/interactive/theme/theme.js");
	themeLoader = typeof m?.loadThemeFromPath === "function" ? m.loadThemeFromPath : null;
}

/**
 * Copy war-dogs' theme JSONs into pi's user themes dir so they are PICKABLE
 * via `/settings → Theme` and listed in `[Themes]` while war-dogs is on — the
 * maintainer picks them there. Called from index.ts installOnce (only when
 * war-dogs turns on), so a boot-OFF process writes nothing. NON-DESTRUCTIVE:
 * a file is written only when the bytes differ, and NOTHING is ever deleted —
 * removing a file on the war-dogs side made `off` list fewer `[Themes]` than
 * stock (a new off≠stock). The files linger harmlessly when war-dogs is off
 * (stock pi reads the same dir); Uninstall lists them for a manual `rm`.
 * A lingering file is only *available* while off, never *applied*: off
 * restores the user's own `settings.theme` (writeEnabledSetting).
 */
export function installThemes(): void {
	try {
		const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "visual", "theme");
		const dst = path.join(agentDir(), "themes");
		fs.mkdirSync(dst, { recursive: true });
		for (const f of fs.readdirSync(src)) {
			if (!f.endsWith(".json")) continue;
			try {
				const bytes = fs.readFileSync(path.join(src, f));
				const target = path.join(dst, f);
				let same = false;
				try {
					same = fs.readFileSync(target).equals(bytes);
				} catch {}
				if (!same) {
					const tmp = `${target}.tmp-${process.pid}`;
					fs.writeFileSync(tmp, bytes);
					fs.renameSync(tmp, target);
				}
			} catch {
				/* one unwritable target must not abort the rest; silent — any
				   stderr line lands in pi's TUI pane */
			}
		}
	} catch {}
}

/** One of OUR themes by name, built from visual/theme/<name>.json; undefined if not ours or unloadable. */
export function warDogsTheme(name: string): unknown | undefined {
	if (!WD_THEME_NAMES.includes(name) || !themeLoader) return undefined;
	const hit = themeCache.get(name);
	if (hit) return hit;
	try {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "visual", "theme", `${name}.json`);
		const t = themeLoader(file);
		if (t) themeCache.set(name, t);
		return t;
	} catch (e) {
		console.error(`[war-dogs] theme ${name}: ${(e as any)?.message ?? e}`);
		return undefined;
	}
}

/**
 * The boot state IS the settings state, with ONE per-invocation override:
 * the `WAR_DOGS_ENABLED` environment variable (2026-08-25, maintainer —
 * scripts, cron and one-off `pi -p` runs need a switch that does not edit
 * settings.json). `0`/`false` forces off, `1`/`true` forces on, anything
 * else falls through to settings. An env override is still a clean BOOT
 * state — it is read here, at load, before anything registers — so
 * off=stock holds exactly as for the settings path; it is NOT a live
 * apply (`/war-dogs on|off` writes `war-dogs.enabled` and reloads —
 * index.ts warns when the env pins the state it is trying to change).
 * The live-apply design stays retired: it froze the pager (input wired at
 * session_start) and left off residuals (pi cannot unregister).
 */
export function envEnabledOverride(): boolean | undefined {
	const v = process.env.WAR_DOGS_ENABLED;
	if (v === "0" || v === "false") return false;
	if (v === "1" || v === "true") return true;
	return undefined;
}

export function bootEnabled(): boolean {
	return envEnabledOverride() ?? settingsEnabled();
}

/**
 * The pi versions war-dogs is verified against — BUMP AS PART OF EVERY
 * Upgrade Contract sweep (README). Min inclusive, max exclusive. 0.83 is
 * behaviourally verified; 0.84 presence pre-swept 2026-08-25 with its
 * known fixes pre-landed.
 */
const TESTED_PI_MIN = "0.83.0";
const TESTED_PI_MAX_EXCLUSIVE = "0.85.0";

const vnum = (v: string): number[] =>
	v
		.split(".")
		.slice(0, 3)
		.map((p) => Number.parseInt(p, 10) || 0);
const vcmp = (a: string, b: string): number => {
	const x = vnum(a);
	const y = vnum(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
};

/**
 * One honest stderr line when the running pi is outside the tested range —
 * war-dogs reaches into pi internals that move between releases, and the
 * failure mode of an unverified pi is SILENT (the screen goes subtly
 * wrong, nothing errors). Warn-only by design: never refuse, never change
 * behaviour. Printed from installOnce, so a boot-off says nothing (stock
 * pi prints no such line — off stays stock on stderr too). The version
 * parameter exists for probing; the default is the running pi's.
 */
export function piVersionWarning(v: string = VERSION): string | null {
	if (!/^\d+\.\d+\.\d+/.test(v)) return null;
	if (vcmp(v, TESTED_PI_MIN) >= 0 && vcmp(v, TESTED_PI_MAX_EXCLUSIVE) < 0) return null;
	return (
		`[war-dogs] verified against pi ${TESTED_PI_MIN} up to (not including) ${TESTED_PI_MAX_EXCLUSIVE}; ` +
		`you are running ${v} — if anything looks off, this is why. See dev/internals/README.md's Upgrade Contract.`
	);
}

/**
 * Write `war-dogs.enabled` into the agent-dir `settings.json`, preserving
 * everything else. Returns false if it could not be written (the command then
 * tells the user to edit it and `/reload`). Agent-dir, not project: a project
 * settings.json is only read when trusted, and this is the global switch.
 */
export function writeEnabledSetting(next: boolean): boolean {
	try {
		const file = path.join(agentDir(), "settings.json");
		let cfg: Record<string, unknown> = {};
		try {
			cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		const block =
			cfg["war-dogs"] && typeof cfg["war-dogs"] === "object" ? (cfg["war-dogs"] as Record<string, unknown>) : {};
		block.enabled = next;
		// The theme is PI'S to own: setting `settings.theme` and reloading makes
		// pi apply the war-dogs palette to chrome AND content consistently, with
		// no in-memory race (war-dogs applying a Theme object after pi's reload
		// had already rendered the transcript in the old theme left the content
		// stale-cached in the wrong palette — demonstrated). On: save the user's
		// theme under `_prevTheme` and set `settings.theme` to the war-dogs
		// palette. Off: restore it (delete when there was none) and drop the
		// marker — off is exactly the theme the user had, no leak.
		if (next) {
			if (!("_prevTheme" in block)) block._prevTheme = typeof cfg.theme === "string" ? cfg.theme : null;
			cfg.theme = warDogsThemeName();
		} else {
			const prev = block._prevTheme;
			if (typeof prev === "string") cfg.theme = prev;
			else delete cfg.theme;
			delete block._prevTheme;
		}
		cfg["war-dogs"] = block;
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Boot default: war-dogs is OFF unless `settings.json` opts in with
 * `"war-dogs": { "enabled": true }` (maintainer, 2026-08-18: activation is an
 * explicit choice, and OFF-at-boot means the extension registers NOTHING —
 * index.ts installOnce — so it is byte-for-byte stock pi, not stock-by-
 * emulation). Reads project settings first, then the agent dir. Absent = OFF.
 */
export function settingsEnabled(): boolean {
	return warDogsBlock().enabled === true;
}

/**
 * The palette war-dogs shows while ON — `war-dogs.theme` (a string; `true`/
 * `false` there is the feature toggle), else the flagship canopy — NOT the
 * user's `settings.theme`, which is what off restores. The key is resolved
 * through the merged `war-dogs` block (the old reader took it from whichever
 * file first had a block, so a project block hid the agent dir's theme —
 * demonstrated). `/war-dogs on` writes this name into `settings.theme`
 * (writeEnabledSetting). The retired army-* names alias to their successors.
 */
const LEGACY_THEMES: Record<string, string> = {
	"army-green": "canopy",
	"army-sand": "dune",
	"army-slate": "oxide",
	// forge was replaced outright in round 9 (rust+steel "oxide").
	forge: "oxide",
};

export function warDogsThemeName(): string {
	// `war-dogs.theme`, else canopy — NOT `settings.theme`: that is the user's
	// pi theme, what "off" restores; the on palette is war-dogs' own.
	const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	const name = pick(warDogsBlock().theme) ?? "canopy";
	return LEGACY_THEMES[name] ?? name;
}

/**
 * Compaction is invisible to the extension context: a manual `/compact`
 * summarises with `isIdle` reporting true, so `ctx.isIdle()` alone cannot see
 * it. index.ts mirrors the state from session_before_compact / session_compact
 * so the busy check below can refuse a toggle mid-compaction.
 */
let compacting = false;
let compactingSince = 0;
/** Longer than any real compaction; a flag older than this is a failure pi never reported. */
const COMPACTING_STALE_MS = 10 * 60_000;
export function setCompacting(v: boolean) {
	compacting = v;
	compactingSince = v ? Date.now() : 0;
}
export function isCompacting(): boolean {
	// pi emits session_compact only on success and aborts only on Esc; a
	// summariser failure fires neither, so the flag also expires on age.
	if (compacting && Date.now() - compactingSince > COMPACTING_STALE_MS) compacting = false;
	return compacting;
}

export interface BusyState {
	busy: boolean;
	why?: string;
}

/**
 * Whether flipping the mode right now would land in an incoherent state.
 * Mid-flight is exactly where those states live, so the command refuses and
 * changes nothing until quiescence.
 *
 * "Busy" is every place work can still move on its own:
 *  - the agent is streaming, retrying, auto-compacting, or draining a
 *    queued follow-up (all covered by `!isIdle`);
 *  - a steering / follow-up message is queued (`hasPendingMessages`);
 *  - a compaction is summarising (`compacting`, mirrored from events);
 *  - any subagent run at any depth is unsettled (`registry` — the host
 *    cannot see these; war-dogs tracks them itself).
 *
 * Not observable through the context, and accepted as low-risk gaps: a user
 * `!bash` (blocks the editor anyway) and next-turn "aside" messages (they
 * carry no active work, only queued context).
 */
export function busyState(ctx: any): BusyState {
	try {
		if (ctx?.isIdle && !ctx.isIdle()) return { busy: true, why: "the agent is working" };
	} catch {}
	try {
		if (ctx?.hasPendingMessages?.()) return { busy: true, why: "a message is queued" };
	} catch {}
	if (isCompacting()) return { busy: true, why: "a compaction is running" };
	for (const rec of registry.values()) {
		if (rec.run.status === "working" || rec.run.status === "queued") return { busy: true, why: "an agent is working" };
	}
	return { busy: false };
}
