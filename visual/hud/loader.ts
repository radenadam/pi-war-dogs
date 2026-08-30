/**
 * The working row and the end-of-turn marker.
 *
 * Uses agent_settled, NOT agent_end: pi fires agent_end when a run
 * stops, but may still auto-retry, auto-compact, or drain follow-ups.
 * Stamping "Generated in" at agent_end printed a completion marker
 * mid-retry and billed the retry wait to the next turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fmtSecs } from "../../util/format.ts";

const FRAME_MS = 220;
const TICK_MS = 150; // wobble smoothness; elapsed text only changes per second anyway
const WORD_MS = 8000;

const PHRASES = [
	"Scanning",
	"Fuzzing",
	"Tracing",
	"Hunting",
	"Disassembling",
	"Sniffing",
	"Grepping",
	"Pivoting",
	"Extracting",
	"Decompiling",
	"Mapping",
	"Triaging",
	"Auditing",
	"Reconning",
];

/** Render `word` with a bright band sweeping across it (wobble/shimmer). */
function wobble(word: string, phase: number, theme: ExtensionContext["ui"]["theme"]): string {
	const width = 2; // band half-width
	const pos = (phase % (word.length + width * 2)) - width;
	let out = "";
	for (let i = 0; i < word.length; i++) {
		const d = Math.abs(i - pos);
		// The phrase IS blue (round 28, maintainer — not dim text that a blue
		// band visits); the sweep is a bright highlight passing over it.
		const token = d === 0 ? "text" : "customMessageLabel";
		out += theme.fg(token, word[i]);
	}
	return out;
}

/**
 * The spinner's eight frames. Round 23 experiment (maintainer): ONE hue —
 * the identity BLUE (`customMessageLabel`, blue-bright in every war-dogs
 * theme and a stock token, so it degrades safely) — instead of the old
 * green→amber→red→dim grenade arc; the final smoke frame drops the bold
 * as the fade. ONE builder for both consumers — the working indicator
 * (enable) and the shared working line below — so main and the pager's
 * subagent view can never drift apart byte-wise.
 */
function grenadeFrames(
	theme: ExtensionContext["ui"]["theme"],
	tone: "customMessageLabel" | "error" = "customMessageLabel",
): string[] {
	const b = (g: string) => theme.bold(theme.fg(tone, g));
	return [b("●"), b("◉"), b("●"), b("◉"), b("✺"), b("✹"), b("✸"), theme.fg(tone, "✶")];
}

/**
 * The working row, shared so the subagent chat view can render an
 * IDENTICAL one instead of approximating it. Same frames, same
 * shimmering phrase, same clock.
 */
let workingLineImpl: ((from: number) => string) | undefined;

export function workingLine(from: number): string | undefined {
	return workingLineImpl?.(from);
}

let startedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

// Whether this run produced an error. A turn that ended in a 429, a
// connection drop or an abort must NOT be stamped with a completion time —
// "Generated in 3s" under an error reads as if it succeeded.
let failed = false;

/**
 * Register the load-once wiring: the gen-time entry renderer and the turn
 * event handlers. Called only when war-dogs is on at boot (index.ts
 * installOnce), so a war-dogs-off session has none of this and behaves
 * exactly like stock (no grenade spinner, no "Generated in" markers). The
 * stateful setWorkingIndicator lives in enable().
 */
export function register(pi: ExtensionAPI) {
	// End-of-turn summary line in the chat scrollback, flagged with the
	// grenade animation's boom frame. Only appended while on (below), so a
	// stock session never carries these entries to render.
	pi.registerEntryRenderer("gen-time", (entry, _options, theme) => {
		// OFF MUST BE STOCK. These entries are PERSISTED to the session file
		// (appendEntry below), and pi has no unregisterEntryRenderer — so a
		// war-dogs-off run that had this renderer would keep drawing
		// "✸ Generated in …" rows that `pi --no-extensions` does not draw (it
		// did, under the old live toggle; dev/instruments/acceptance-test.sh never caught
		// it because it boots a FRESH session). The guard is structural now:
		// off never registers the renderer, and pi's addCustomEntryToChat
		// bails on `if (!renderer) return` — the entry renders as nothing,
		// exactly stock. Do not register this unconditionally.
		//
		// Coerced, not trusted: the entry was written by whatever war-dogs
		// wrote this session file (or by nothing at all), so `seconds` may be
		// a string, null or missing. fmtSecs turns a non-finite number into
		// 0s rather than "NaNm NaNs".
		const seconds = Number((entry.data as { seconds?: unknown } | undefined)?.seconds ?? 0);
		// Uniformly DIM (round 30, maintainer — blue made the ✸ stand apart
		// from its own sentence): the settled marker is decoration.
		return new Text(theme.fg("dim", `✸ Generated in ${fmtSecs(seconds)}`), 1, 0);
	});

	pi.on("message_end", async (event, ctx) => {
		const m = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (m?.role !== "assistant") return;
		if (m.stopReason === "error" || m.stopReason === "aborted" || m.errorMessage) {
			failed = true;
			// The RETRY wait wears the same spinner in RED (maintainer,
			// 2026-08-20): pi has no retry event an extension can see, but an
			// assistant message ending in error while the clock is running IS
			// the moment pi backs off before retrying — agent_start of the
			// retry attempt restores the blue frames below.
			if (startedAt && ctx.mode === "tui") {
				try {
					ctx.ui.setWorkingIndicator({ frames: grenadeFrames(ctx.ui.theme, "error"), intervalMs: FRAME_MS });
				} catch {}
			}
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopTimer();
		failed = false;
		startedAt = Date.now();
		// Rebuild the frames from the LIVE theme. grenadeFrames() bakes finished
		// SGR strings and pi stores them verbatim, so the set installed by
		// enable() froze the palette that was active at mode-on: after a
		// /settings theme change the grenade kept the old hue until the next
		// boot. Everything else here re-reads ctx.ui.theme per tick (pi's
		// `theme` is a live Proxy), so this was the one stale surface.
		try {
			ctx.ui.setWorkingIndicator({ frames: grenadeFrames(ctx.ui.theme), intervalMs: FRAME_MS });
		} catch {}
		const tick = () => {
			try {
				const theme = ctx.ui.theme;
				const now = Date.now();
				const elapsed = (now - startedAt) / 1000;
				const word = PHRASES[Math.floor((now - startedAt) / WORD_MS) % PHRASES.length];
				const phase = Math.floor(now / TICK_MS);
				// The shimmer sweeps the whole label INCLUDING the dots.
				ctx.ui.setWorkingMessage(wobble(`${word}...`, phase, theme) + theme.fg("dim", ` ${fmtSecs(elapsed)}`));
			} catch {
				stopTimer(); // stale ctx after /reload
			}
		};
		tick();
		timer = setInterval(tick, TICK_MS);
	});

	// agent_settled, NOT agent_end: pi fires agent_end when a run stops, but
	// it may still auto-retry (connection errors), auto-compact and retry, or
	// drain queued follow-ups. Stamping "Generated in" at agent_end therefore
	// printed a completion marker mid-retry, and the retry wait got billed to
	// the next turn's clock. agent_settled means "pi will not continue on its
	// own".
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopTimer();
		ctx.ui.setWorkingMessage(); // restore pi's default
		if (startedAt) {
			const seconds = (Date.now() - startedAt) / 1000;
			const errored = failed;
			startedAt = 0;
			failed = false;
			if (!errored) pi.appendEntry("gen-time", { seconds });
		}
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}

/**
 * Swap in the grenade working indicator and publish the shared working line
 * (so the pager's subagent view can render a byte-identical one). Called by
 * the orchestrator at session_start while war-dogs is on.
 */
export function enable(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	const theme = ctx.ui.theme;
	// Single-cell grenade, bold for visual weight: green pulse → amber
	// prime/spark → red detonation → dim smoke fade. The frames carry no
	// lead; pi's Loader pads one column, and the pager slices that column
	// back off (deindentWorkingRow, round 20) so the grenade sits at the
	// terminal edge in the beat-glyph column, scanning as one more beat head.
	ctx.ui.setWorkingIndicator({ frames: grenadeFrames(theme), intervalMs: FRAME_MS });
	try {
		workingLineImpl = (from: number): string => {
			const th = ctx.ui.theme;
			const now = Date.now();
			const elapsed = (now - from) / 1000;
			const word = PHRASES[Math.floor((now - from) / WORD_MS) % PHRASES.length];
			const phase = Math.floor(now / TICK_MS);
			const frames = grenadeFrames(th);
			const frame = frames[Math.floor(now / FRAME_MS) % frames.length];
			return ` ${frame} ${wobble(`${word}...`, phase, th)}${th.fg("dim", ` ${fmtSecs(elapsed)}`)}`;
		};
	} catch {}
}
