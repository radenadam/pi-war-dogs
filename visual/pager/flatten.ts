/**
 * The per-component render cache — the pager's performance core.
 *
 * LOAD-BEARING, not an optimisation. Folded tools are drawn via
 * setExpanded(true)/render/setExpanded(false), and setExpanded() calls
 * updateDisplay(), which tears the component's children down and rebuilds
 * them. Tool components can therefore NEVER hit pi's own internal
 * one-width cache. Measured on a 938-component session: one flatten with
 * this cache warm ~6ms, with it cleared ~2.7s.
 *
 * MODULE-SCOPED and weak on purpose: it survives pager open/close, so
 * reopening a long transcript is O(new components); weak keys let
 * components detached by compaction be collected.
 *
 * Staleness is handled by the per-component signature and by cacheGen
 * (theme changes) — NEVER by clearing.
 */

import type { LocalBlock, LocalRange } from "./surface.ts";

export interface CompCacheBeat {
	lines: string[];
	ranges: LocalRange[];
	blocks: LocalBlock[];
	/**
	 * The beat's head row (relative to `lines`) and its state glyph. The
	 * glyph is painted into the side pad by the render loop — it lives in
	 * the margin, not in the content, so content keeps its x-position.
	 */
	head?: { row: number; glyph: string };
	/** Fold handles: row (relative) + content-column span that highlights on hover. */
	handles?: { row: number; a: number; b: number }[];
	/** Informational beat: rendered without the side pad, aligned with the glyph column. */
	flushLeft?: boolean;
	/** Beat kind (clustering eligibility and box/info handling). */
	kind?: "prose" | "act" | "open" | "info" | "box";
	/** Extra gutter glyphs on rows WITHIN the beat (thinking's ◐ marks). */
	marks?: { row: number; glyph: string }[];
	/** Act metadata for clustering (tool name, error/running state; thinking carries its line count). */
	act?: { tool: string; err: boolean; running: boolean; lines?: number };
	/** Hover the beat's handle rows as ONE control (working thinking view). */
	groupHandles?: boolean;
	/**
	 * An OPEN panel's padding row — one empty row painted in the panel's own
	 * field, inserted above the head and below the last evidence row by the
	 * emitters (maintainer: breathing room inside the bg). Adjacent expanded
	 * cluster members share one row, never two.
	 */
	pad?: string;
}

export interface CompCacheEntry extends CompCacheBeat {
	w: number;
	gen: number;
	sig: string;
	/**
	 * A voice message's machinery PRELUDE (its leading thinking, round 24),
	 * emitted as its own beat so it clusters with the acts around it.
	 */
	pre?: CompCacheBeat;
}
export const compCache = new WeakMap<object, CompCacheEntry>();

/**
 * The cache generation, bumped when baked-in SGR colours go stale (theme
 * change). Read it through `getCacheGen()`, and NEVER re-export it as a
 * mutable binding.
 *
 * LOAD-BEARING (round 31 audit, demonstrated): pi loads this extension
 * through jiti, and jiti compiles `import { cacheGen }` to a SNAPSHOT of the
 * value at import time — not to the ES live binding. surface.ts therefore
 * compared a frozen `0` against a counter only this module could see, so
 * `invalidate()` retired nothing and the transcript kept the previous
 * palette after a live theme change. A function call crosses the module
 * boundary every time; `grep -rn "^export let"` finds any other instance.
 */
let gen = 0;

export function getCacheGen(): number {
	return gen;
}

export function bumpCacheGen() {
	gen++;
}
