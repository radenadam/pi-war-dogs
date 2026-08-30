/**
 * Colour and path helpers shared by renderers.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

/** Project-relative inside cwd, else ~-shortened. */
export function shortenPath(value: string, cwd: string): string {
	const abs = isAbsolute(value) ? value : resolvePath(cwd, value);
	const rel = relative(cwd, abs);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const home = homedir();
	return abs.startsWith(home) ? `~${abs.slice(home.length)}` : value;
}

/**
 * A directory shown as `~/…`, by pi's own rule (`formatCwdForFooter` in
 * modes/interactive/components/footer.js): the HUD's paths must read the
 * way pi's footer reads them.
 *
 * The boundary is the point. A bare `pwd.startsWith(home)` has none, so a
 * home SIBLING — `/home/adam2/project` — rendered as `~2/project`, a path
 * that does not exist. `relative()` answers "is this really inside home?"
 * and refuses the shortening when the answer escapes it. `USERPROFILE` is
 * pi's Windows fallback and is honoured here too.
 */
export function shortenHome(value: string, home = process.env.HOME || process.env.USERPROFILE || ""): string {
	if (!home) return value;
	const rel = relative(resolvePath(home), resolvePath(value));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return value;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Subagent IDENTITY colours — constant across all three themes by design
 * (the palette rationale): blue is identity
 * and running, green/red keep success/error semantics (semantics beat
 * branding). The hexes are the brief's verbatim values; canopy's blue is the same
 * family on purpose (harmonized, not clashing). Amber `#e3b566` is
 * reserved by the spec for attention/settling states — no run status
 * carries it yet, so it is deliberately not defined here.
 */
export const BLUE = (t: string) => `\x1b[1m\x1b[38;2;90;154;224m${t}\x1b[39m\x1b[22m`;
/** Settled-ok green for run trees / tallies. */
export const SUB_OK = (t: string) => `\x1b[38;2;127;190;109m${t}\x1b[39m`;
/** Failed red for run trees / tallies. */
export const SUB_FAILED = (t: string) => `\x1b[38;2;224;112;92m${t}\x1b[39m`;

/* ---- Lab shading (the mascot banner's theme-relative palette) ---------- */

type RGB = [number, number, number];

function srgbToLin(c: number): number {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linToSrgb(v: number): number {
	const c = Math.max(0, Math.min(1, v));
	return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
}

/** sRGB → CIELab (D65). */
export function rgbToLab([r8, g8, b8]: RGB): [number, number, number] {
	const r = srgbToLin(r8);
	const g = srgbToLin(g8);
	const b = srgbToLin(b8);
	const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
	const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
	const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELab (D65) → sRGB, channels clamped. */
export function labToRgb([L, a, b]: [number, number, number]): RGB {
	const fy = (L + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - b / 200;
	const g = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
	const x = 0.95047 * g(fx);
	const y = g(fy);
	const z = 1.08883 * g(fz);
	return [
		Math.round(linToSrgb(x * 3.2406 + y * -1.5372 + z * -0.4986)),
		Math.round(linToSrgb(x * -0.9689 + y * 1.8758 + z * 0.0415)),
		Math.round(linToSrgb(x * 0.0557 + y * -0.204 + z * 1.057)),
	];
}

/**
 * A darker SHADE of a colour: its L* scaled by `ratio`, its chroma eased
 * down with it (sqrt — a deep shade keeps some of the hue without leaving
 * the gamut). ratio 1 is the colour itself.
 */
export function shadeRgb(rgb: RGB, ratio: number): RGB {
	const [L, a, b] = rgbToLab(rgb);
	const k = Math.sqrt(Math.max(0, ratio));
	return labToRgb([L * ratio, a * k, b * k]);
}

/** The `R;G;B` of a truecolor SGR sequence (`\x1b[38;2;R;G;Bm`), or undefined for anything else. */
export function sgrRgb(seq: string): RGB | undefined {
	const m = /38;2;(\d+);(\d+);(\d+)/.exec(seq);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
