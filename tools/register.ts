/**
 * Register a tool and hand its definition back.
 *
 * Why the return matters: the pager needs the real ToolDefinition to
 * render a tool inside a SUBAGENT transcript. Passing `undefined` there
 * makes pi fall back to "tool name + raw JSON args", which is why those
 * views used to look nothing like main. Built-in tools resolve their own
 * definition internally; extension tools and our read/edit/bash
 * overrides do not.
 *
 * The return is what matters, NOT a layering rule: a ToolDefinition carries
 * its own renderCall/renderResult, so `tools/*.ts` deliberately imports its
 * matching `visual/tools/*` renderer — the look travels with the tool (see
 * dev/internals/README.md's Layout section). What `tools/` must not import is the PAGER,
 * so the definition is handed back and index.ts — which sits above both —
 * publishes it into visual/pager/toolmap.
 *
 * (This comment used to claim `tools/` must not import `visual/` at all,
 * which every tool in the tree contradicts and dev/internals/README.md explicitly
 * allows.)
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withStamp } from "../util/stamp.ts";

export function reg(pi: ExtensionAPI, def: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	// Every result carries the [at …] time stamp (util/stamp.ts).
	withStamp(def);
	pi.registerTool(def as never);
	return def;
}
