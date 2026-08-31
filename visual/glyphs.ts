/**
 * The run-status glyphs, decided ONCE and read by every surface that paints a
 * run's state (the subagent renderer's tree, the footer tally, the pager's
 * status marks) — one decision point, or the sites drift apart the day one is
 * edited.
 *
 * Defaults follow the TERMINAL, taste follows settings.json:
 *
 *  - Everywhere but Windows Terminal, the classic set (`✳ ✔`): the maintainer's
 *    look, proportionate in Linux font stacks.
 *  - Under Windows Terminal (`win32`, or `WT_SESSION` set — Windows Terminal
 *    exports it into WSL shells too, and a pi in WSL paints on the same
 *    renderer), the text-safe cousins (`✻ ✓`): Cascadia lacks the dingbats,
 *    DirectWrite falls back per codepoint, and any codepoint WITH an emoji
 *    form (`✳` U+2733, `✔` U+2714) comes back from Segoe UI Emoji as a colour
 *    picture — the green-square asterisk of the maintainer's screenshot —
 *    while VS15 is ignored, so no selector can prevent it (demonstrated,
 *    2026-08-30). `✻` U+273B and `✓` U+2713 have no emoji form anywhere.
 *
 * `war-dogs.glyphs` in settings.json overrides per key — `{"working": "✽"}` —
 * on any platform. An override must measure ONE column by pi-tui's count
 * (`visibleWidth`), or it is ignored for the default: the glyphs are painted
 * into fixed columns, and a two-column emoji would shear every row it sits on
 * (the ledger's emoji-width entry; a base+VS16 pair measures 2 and is
 * rejected by the same rule). Read at module load — like the theme, a change
 * applies on /reload.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { warDogsBlock } from "../settings.ts";

export type RunGlyphKey = "working" | "queued" | "idle" | "stopped" | "error";

const CLASSIC: Record<RunGlyphKey, string> = { working: "✳", queued: "◌", idle: "✔", stopped: "⊘", error: "✘" };
const TEXT_SAFE: Record<RunGlyphKey, string> = { working: "✻", queued: "◌", idle: "✓", stopped: "⊘", error: "✘" };

const onWindowsTerminal = process.platform === "win32" || !!process.env.WT_SESSION;

export const RUN_GLYPHS: Record<RunGlyphKey, string> = (() => {
	const out = { ...(onWindowsTerminal ? TEXT_SAFE : CLASSIC) };
	try {
		const block = (warDogsBlock().glyphs ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(out) as RunGlyphKey[]) {
			const v = block[key];
			if (typeof v === "string" && v.length > 0 && visibleWidth(v) === 1) out[key] = v;
		}
	} catch {
		/* a malformed settings block keeps the defaults */
	}
	return out;
})();

/** The pager's status mark for a run state; unknown states read as error. */
export function runGlyph(status: string): string {
	return RUN_GLYPHS[status as RunGlyphKey] ?? RUN_GLYPHS.error;
}
