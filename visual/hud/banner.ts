/**
 * Startup header: the box-soldier mascot beside the WAR DOGS word art, with
 * two live lines filling the rows beside its face:
 * `v<war-dogs> (📦 Pi v<pi>) · Model: <model> (<effort>)` and
 * `Session: <id>` — `<id> (<name>)` once the session is named, `· not saved`
 * under --no-session (2026-08-23, maintainer; the cwd left this header — the
 * footer carries it).
 *
 * THEME-RELATIVE (2026-08-22, maintainer): the art is baked by ROLE, not by
 * colour — `{H}` helmet highlight, `{A}` helmet, `{C}` helmet edge, `{E}`
 * helmet shadow, `{L}` face highlight, `{B}` face, `{J}` face edge, `{G}`
 * face shadow, `{F}` face deep shadow, `{K}` eyes — and every render fills
 * the roles from the live theme: the helmet family from `accent` (the chrome
 * green on canopy, sand on dune, rust on oxide, chartreuse on cobalt), the
 * face family from `mdHeading` (the identity hue), each role a Lab shade of
 * its family colour at the ORIGINAL art's lightness ratio (util/paint.ts
 * shadeRgb). The word art rides the same roles (ink = H, mid = A, shadow =
 * G). A theme without truecolor sequences keeps the baked palette.
 *
 * Regenerate the template with dev/generators/banner/ (`python3 banner.py "WAR DOGS"`,
 * then dev/generators/banner/template.py) — the generator's palette RGBs become the
 * role tokens here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { shadeRgb, sgrRgb } from "../../util/paint.ts";

/** war-dogs' own version: package.json's `version`, read once at load. */
const WD_VERSION: string = (() => {
	try {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
		const v = JSON.parse(readFileSync(file, "utf8"))?.version;
		return typeof v === "string" && v ? v : "?";
	} catch {
		return "?";
	}
})();

/** The art, with `{ROLE}` where the generator's palette put an RGB. */
const TEMPLATE: string[] = [
	"\u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{C}m▄\u001b[0m\u001b[38;2;{A}m▄\u001b[38;2;{C};48;2;{H}m▀\u001b[38;2;{C};48;2;{H}m▀\u001b[38;2;{C};48;2;{A}m▀\u001b[38;2;{C};48;2;{A}m▀\u001b[0m\u001b[38;2;{E}m▄\u001b[0m\u001b[38;2;{C}m▄\u001b[0m \u001b[0m \u001b[0m\u001b[0m  \u001b[38;2;{H};48;2;{H}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[38;2;{H};48;2;{H}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[38;2;{H};48;2;{H}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[0m\u001b[38;2;{H}m▄\u001b[0m\u001b[38;2;{H}m▀\u001b[0m\u001b[38;2;{H}m▄\u001b[0m \u001b[38;2;{H};48;2;{H}m▀\u001b[38;2;{H};48;2;{G}m▀\u001b[0m\u001b[38;2;{H}m▄\u001b[0m \u001b[0m \u001b[0m \u001b[38;2;{H};48;2;{H}m▀\u001b[38;2;{H};48;2;{G}m▀\u001b[0m\u001b[38;2;{H}m▄\u001b[0m \u001b[0m\u001b[38;2;{H}m▄\u001b[0m\u001b[38;2;{H}m▀\u001b[0m\u001b[38;2;{H}m▄\u001b[0m \u001b[0m\u001b[38;2;{H}m▄\u001b[0m\u001b[38;2;{H}m▀\u001b[38;2;{H};48;2;{G}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[0m\u001b[38;2;{H}m▄\u001b[0m\u001b[38;2;{H}m▀\u001b[38;2;{H};48;2;{G}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[0m",
	"\u001b[0m\u001b[38;2;{C}m▄\u001b[38;2;{C};48;2;{C}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{H};48;2;{A}m▀\u001b[38;2;{H};48;2;{A}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{E};48;2;{E}m▀\u001b[38;2;{C};48;2;{C}m▀\u001b[0m\u001b[38;2;{C}m▄\u001b[0m\u001b[0m  \u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{A}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{A}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{G}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{A};48;2;{G}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{G};48;2;{G}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{A};48;2;{G}m▀\u001b[0m\u001b[38;2;{A}m▄\u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m \u001b[38;2;{A};48;2;{A}m▀\u001b[38;2;{G};48;2;{A}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{G}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{A}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{G}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[38;2;{G};48;2;{A}m▀\u001b[38;2;{A};48;2;{A}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[0m\u001b[38;2;{A}m▄\u001b[38;2;{G};48;2;{A}m▀\u001b[0m\u001b[38;2;{A}m▀\u001b[0m\u001b[38;2;{G}m▄\u001b[0m",
	"\u001b[0m\u001b[38;2;{C}m▀\u001b[38;2;{C};48;2;{J}m▀\u001b[38;2;{C};48;2;{L}m▀\u001b[38;2;{C};48;2;{L}m▀\u001b[38;2;{C};48;2;{B}m▀\u001b[38;2;{C};48;2;{B}m▀\u001b[38;2;{C};48;2;{B}m▀\u001b[38;2;{C};48;2;{B}m▀\u001b[38;2;{C};48;2;{B}m▀\u001b[38;2;{C};48;2;{G}m▀\u001b[38;2;{C};48;2;{J}m▀\u001b[0m\u001b[38;2;{C}m▀\u001b[0m\u001b[0m  \u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m \u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m\u001b[38;2;{G}m▀\u001b[0m\u001b[38;2;{G}m▀\u001b[0m \u001b[0m",
	"\u001b[0m \u001b[38;2;{J};48;2;{J}m▀\u001b[38;2;{L};48;2;{B}m▀\u001b[38;2;{B};48;2;{B}m▀\u001b[38;2;{K};48;2;{K}m▀\u001b[38;2;{B};48;2;{B}m▀\u001b[38;2;{B};48;2;{B}m▀\u001b[38;2;{K};48;2;{K}m▀\u001b[38;2;{B};48;2;{B}m▀\u001b[38;2;{G};48;2;{G}m▀\u001b[38;2;{J};48;2;{J}m▀\u001b[0m \u001b[0m\u001b[0m  ",
	"\u001b[0m \u001b[38;2;{J};48;2;{J}m▀\u001b[38;2;{B};48;2;{J}m▀\u001b[38;2;{B};48;2;{G}m▀\u001b[38;2;{B};48;2;{G}m▀\u001b[38;2;{B};48;2;{G}m▀\u001b[38;2;{B};48;2;{G}m▀\u001b[38;2;{B};48;2;{G}m▀\u001b[38;2;{B};48;2;{F}m▀\u001b[38;2;{G};48;2;{J}m▀\u001b[38;2;{J};48;2;{J}m▀\u001b[0m \u001b[0m\u001b[0m  ",
];

/** The generator's own palette — the fallback when the theme is not truecolor. */
const BAKED: Record<string, [number, number, number]> = {
	C: [52, 96, 44],
	H: [89, 152, 73],
	A: [69, 122, 54],
	E: [41, 82, 31],
	J: [64, 116, 180],
	L: [92, 158, 224],
	B: [58, 124, 196],
	G: [36, 92, 160],
	F: [22, 62, 110],
	K: [0, 0, 0],
};
/** Each role's L* as a ratio of its family's brightest role (measured from BAKED). */
const HELMET: Record<string, number> = { H: 1, A: 0.809, C: 0.639, E: 0.541 };
const FACE: Record<string, number> = { L: 1, B: 0.805, J: 0.758, G: 0.612, F: 0.41 };
/** Columns the mascot and its gap occupy — where the status lines start. */
const STATUS_COL = 14;
const RESET = "\x1b[0m";

function seqOf(theme: any, key: string): string {
	try {
		return (theme.fg(key, "\0") as string).split("\0")[0];
	} catch {
		return "";
	}
}

/** The art rows with every role filled from the theme; cached per palette. */
let artCache: { key: string; rows: string[] } | null = null;
function artFor(theme: any): string[] {
	const accent = seqOf(theme, "accent");
	const identity = seqOf(theme, "mdHeading");
	const key = `${accent}|${identity}`;
	if (artCache && artCache.key === key) return artCache.rows;
	const helmetTop = sgrRgb(accent);
	const faceTop = sgrRgb(identity);
	const rgb: Record<string, string> = {};
	for (const role of Object.keys(BAKED)) {
		let v = BAKED[role];
		if (role in HELMET && helmetTop) v = shadeRgb(helmetTop, HELMET[role]);
		else if (role in FACE && faceTop) v = shadeRgb(faceTop, FACE[role]);
		rgb[role] = v.join(";");
	}
	const rows = TEMPLATE.map((r) => r.replace(/\{([A-L])\}/g, (_m, k: string) => rgb[k] ?? BAKED.K.join(";")));
	artCache = { key, rows };
	return rows;
}

/**
 * The session name, cached on the leaf id. pi's getSessionName() walks a
 * filtered COPY of every entry (O(entries) per call) and this runs once per
 * frame; every appended entry — a /name's session_info included — advances
 * the leaf id, so the leaf is an O(1) key that changes whenever the answer
 * can. Keyed on the manager object too: each session_start hands a fresh one.
 */
let nameCache: { sm: unknown; leaf: unknown; name: string | undefined } | null = null;
function sessionName(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	const leaf = sm.getLeafId();
	if (nameCache && nameCache.sm === sm && nameCache.leaf === leaf) return nameCache.name;
	const name = sm.getSessionName();
	nameCache = { sm, leaf, name };
	return name;
}

function statusLines(ctx: ExtensionContext, theme: any): [string, string] {
	const label = (s: string) => `\x1b[1m${seqOf(theme, "accent")}${s}${RESET}`;
	const value = (s: string) => `${seqOf(theme, "muted")}${s}${RESET}`;
	const note = (s: string) => `${seqOf(theme, "dim")}${s}${RESET}`;
	const sm = ctx.sessionManager;
	const name = sessionName(ctx);
	let session = value(name ? `${sm.getSessionId()} (${name})` : sm.getSessionId());
	// --no-session: the id exists but nothing is written, so /resume cannot
	// find it — say so rather than show an id that leads nowhere.
	if (!sm.getSessionFile()) session += note(" \u00b7 not saved");
	const sep = `${seqOf(theme, "dim")} \u00b7 ${RESET}`;
	// `v0.1.0 (📦 Pi v0.83.0) · Model: Kimi K3-256K (max)` (maintainer,
	// 2026-08-23): versions and the model's values muted, `Pi` in the
	// reading white, `Model:` the one accent label.
	const white = (s: string) => `${seqOf(theme, "text")}${s}${RESET}`;
	const model = (ctx.model as any)?.name ?? (ctx.model as any)?.id ?? "no-model";
	const effort = String(ctx.thinkingLevel ?? "off");
	const first =
		value(`v${WD_VERSION} (\u{1F4E6} `) +
		white("Pi") +
		value(` v${VERSION})`) +
		sep +
		label("Model:") +
		" " +
		value(`${model} (${effort})`);
	return [first, `${label("Session:")} ${session}`];
}

/**
 * Install the mascot header. Called by the orchestrator (index.ts activate)
 * at session_start while war-dogs is on. No session_start handler of its
 * own — the orchestrator owns when this applies; pi itself resets the header
 * before every session switch or reload. The theme argument is pi's live
 * proxy, so a palette change repaints on the next frame.
 */
export function enable(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	ctx.ui.setHeader((_tui: unknown, theme: any) => {
		const draw = (width: number): string[] => {
			const [version, session] = statusLines(ctx, theme);
			const rows = [...artFor(theme)];
			// Art rows 3-4 are mascot + gap only — the status lines fill the
			// space beside the mascot's face, at a fixed column.
			const at = (r: string) => r + " ".repeat(Math.max(0, STATUS_COL - visibleWidth(r)));
			rows[3] = at(rows[3]) + version;
			rows[4] = at(rows[4]) + session;
			return ["", ...rows, ""].map((r) => (visibleWidth(r) > width ? truncateToWidth(r, width) : r));
		};
		const component = {
			// Guarded: this runs inside pi's render loop, where an
			// exception takes down the whole TUI rather than just the
			// header.
			render(width: number): string[] {
				try {
					return draw(width);
				} catch {
					return [];
				}
			},
			invalidate() {},
			// The pager's render cache signs a generic component by its text;
			// this one has none and would sign as a constant — frozen at its
			// first frame, so a /name never reached it (surface.ts sigFor).
			// Everything the two lines read, O(1) and clockless.
			wdSignature(): string {
				const sm = ctx.sessionManager;
				const model = (ctx.model as any)?.id ?? "";
				return `${sm.getSessionId()}|${sessionName(ctx) ?? ""}|${sm.getSessionFile() ? 1 : 0}|${model}|${ctx.thinkingLevel ?? ""}`;
			},
		};
		return component as unknown as Component;
	});
}
