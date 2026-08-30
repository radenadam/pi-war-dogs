/**
 * The alternate-screen sandwich.
 *
 * While the pager is open the terminal switches to the alt screen, so
 * pi's full redraws (and their scrollback wipes) land harmlessly — no
 * scrollback exists there to wipe, and the real scrollback plus
 * scrollbar are preserved for when the pager closes. pi's renderer state
 * is snapshotted on entry and restored on exit so the primary screen
 * resumes with incremental diffs instead of a wiping full redraw.
 */

import type { TUI } from "@earendil-works/pi-tui";

let altSnap: any = null;

/**
 * pi 0.84+ can own the alt screen itself (`--tui-mode fullscreen`, pi-tui's
 * TuiAltScreen, public `mode === "fullscreen"`). DECSET 1049 is not
 * reference-counted: our `?1049l` on close dropped pi out of ITS alt screen
 * for the rest of the session (demonstrated on 0.84.2). Then we write
 * neither sequence; the render-state snapshot still applies.
 */
export function piOwnsAlt(tui: TUI | null): boolean {
	return (tui as any)?.mode === "fullscreen";
}

export function enterAltScreen(tui: TUI) {
	const t = tui as any;
	altSnap = {
		previousLines: t.previousLines,
		cursorRow: t.cursorRow,
		hardwareCursorRow: t.hardwareCursorRow,
		previousViewportTop: t.previousViewportTop,
		previousWidth: t.previousWidth,
		previousHeight: t.previousHeight,
		maxLinesRendered: t.maxLinesRendered,
		previousKittyImageIds: t.previousKittyImageIds,
	};
	if (!piOwnsAlt(tui)) writeRaw(tui, "\x1b[?1049h");
	try {
		tui.requestRender(true);
	} catch {}
}

/**
 * Leave the alt screen. On a mode toggle pi's renderer state is restored so
 * the primary screen resumes with incremental diffs. On the PROCESS-EXIT path
 * (`final`) pi has already stopped its TUI: `?1049l` brings back the primary
 * screen holding pi's frame from the moment we entered, with the cursor where
 * it was then — the middle of that stale frame — and pi's "To resume this
 * session" line plus the shell prompt were written into it (demonstrated).
 * So park the cursor on a fresh line below the frame instead.
 */
export function exitAltScreen(tui: TUI | null, final = false) {
	if (!tui) return;
	const owned = piOwnsAlt(tui);
	if (!owned) writeRaw(tui, "\x1b[?1049l");
	const t = tui as any;
	if (final) {
		if (!owned) writeRaw(tui, parkBelowStaleFrame());
		altSnap = null;
		return;
	}
	try {
		if (altSnap && t.terminal?.columns === altSnap.previousWidth) {
			Object.assign(t, altSnap);
			tui.requestRender();
		} else {
			tui.requestRender(true);
		}
	} catch {}
	altSnap = null;
}

/**
 * The escape that moves the cursor to a fresh line BELOW pi's stale primary
 * frame after `?1049l` (the frame from the moment we entered; the restored
 * cursor sits somewhere inside it). Used on the process-exit path and on
 * suspend (ctrl+z), the two moments a shell prompt is about to be drawn.
 */
export function parkBelowStaleFrame(): string {
	try {
		const rows = Array.isArray(altSnap?.previousLines) ? altSnap.previousLines.length : 0;
		// The TERMINAL's cursor is the hardware cursor (pi parks it on the
		// editor line, above the footer), not the renderer's logical row.
		const hw = altSnap?.hardwareCursorRow;
		const cur = typeof hw === "number" ? hw : typeof altSnap?.cursorRow === "number" ? altSnap.cursorRow : rows;
		const down = Math.max(0, rows - 1 - cur);
		return `${down > 0 ? `\x1b[${down}B` : ""}\r\n`;
	} catch {
		return "\r\n";
	}
}

export function writeRaw(tui: TUI | null, seq: string) {
	try {
		const t = (tui as any)?.terminal;
		if (t && typeof t.write === "function") t.write(seq);
		else process.stdout.write(seq);
	} catch {
		/* never let a mode toggle take the app down */
	}
}
