/**
 * Where the station's run list comes from.
 *
 * An in-memory read of the agents index, never a disk scan: this is
 * called from the footer and station on the render path, and binding it
 * to a manifest scan put a readdir plus one readFile per run on every
 * frame.
 */

import { knownRuns } from "../../agents/run.ts";
import type { SubagentRun } from "../../agents/run.ts";

export function listRuns(): SubagentRun[] {
	return [...knownRuns.values()];
}
