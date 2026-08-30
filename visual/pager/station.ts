/**
 * The subagent station: every run this session spawned, at full depth.
 *
 * Reached only by alt+s, and always relative to the session you press it
 * in — from a subagent's chat view it shows what THAT agent spawned, not
 * main's family. A leaf therefore shows an empty station, which is the
 * honest answer rather than a one-row list of itself.
 *
 * Collapse state is module-scoped so it survives closing and reopening.
 * Absent = EXPANDED: the station renders the family in full by default
 * and collapsing is the user's move.
 *
 * Depth grows the tree HORIZONTALLY and is unbounded by design, so
 * shift+wheel scrolls that axis while a plain wheel always scrolls
 * vertically — the axis never depends on cursor position.
 */

import { getCurrentSessionId } from "./state.ts";
import { listRuns } from "./runsource.ts";
import type { SubagentRun as SubagentRunInfo } from "../../agents/run.ts";

export const stationCollapsed = new Set<string>();

export interface StationRow {
	run: SubagentRunInfo;
	depth: number;
	/** Box-drawing stem, already includes this row's ├─ / └─ elbow. */
	stem: string;
	hasKids: boolean;
	collapsed: boolean;
	/** Content column of the ▸/▾ hit target. */
	toggleAt: number;
	/** Content column of the ✕ abort target; -1 when not abortable. */
	abortAt: number;
}

/**
 * The canonical family filter: roots owned by this session plus every
 * descendant, read fresh from the in-memory index. This is THE one
 * implementation — surface.ts's subagentRuns() is the same set behind a
 * 250ms membership cache (status flips are visible through both, because
 * the run objects are shared by reference).
 */
export function familyRuns(): SubagentRunInfo[] {
	const all = listRuns();
	const owner = getCurrentSessionId();
	const keep = new Set<string>();
	for (const r of all) if (!r.parentId && (!owner || r.ownerSession === owner)) keep.add(r.id);
	let grew = true;
	while (grew) {
		grew = false;
		for (const r of all) {
			if (r.parentId && keep.has(r.parentId) && !keep.has(r.id)) {
				keep.add(r.id);
				grew = true;
			}
		}
	}
	return all.filter((r) => keep.has(r.id));
}

/** The station's run list — always fresh; the ✕/collapse UI must not lag. */
export function stationRuns(): SubagentRunInfo[] {
	return familyRuns();
}
