/**
 * Which screen the pager is showing, and who wants to know.
 *
 * This replaces the __piSubagentView / __piSubagentOnStream globals.
 * They existed only because separately-loaded extensions could not
 * import each other; inside one extension this is an ordinary module.
 *
 * The focused run drives input routing: while a subagent chat view is
 * open, typed text goes to THAT agent instead of main. It must be
 * cleared on every teardown path — a stale value silently redirects the
 * main input bar into a view that is no longer on screen.
 */

let focusedRun: string | undefined;

export function setFocusedRun(id: string | undefined) {
	focusedRun = id ?? undefined;
}

export function getFocusedRun(): string | undefined {
	return focusedRun;
}

export function clearFocusedRun() {
	focusedRun = undefined;
}

/**
 * Open-a-run hook, registered by the ACTIVE PagerComponent.
 *
 * The click ranges the flatten produces are cached in flatten.ts's
 * compCache, which outlives a pager instance (a session switch tears one
 * down and session_start builds a new one; the module is not re-imported),
 * so a cached action must not close over the pager that
 * built it — it routes through here to whichever pager is live now. Same
 * pattern as agents/stream.ts onStream().
 */
let openRunHook: ((id: string) => void) | undefined;

export function setOpenRunHook(fn: ((id: string) => void) | undefined) {
	openRunHook = fn;
}

export function requestOpenRun(id: string) {
	try {
		openRunHook?.(id);
	} catch {}
}

/**
 * The interactive session that owns this pi process. The station's
 * family filter uses it to show only the runs this conversation
 * spawned; set once per session by the pager wiring.
 */
let currentSessionId: string | null = null;

export function setCurrentSessionId(id: string | null) {
	currentSessionId = id;
}

export function getCurrentSessionId(): string | null {
	return currentSessionId;
}
