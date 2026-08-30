/**
 * Tool definitions by name, for rendering child transcripts.
 *
 * Replaces the __piToolDefs global. Passing `undefined` as the tool
 * definition makes pi fall back to "tool name + raw JSON args", which is
 * why subagent/webfetch/websearch calls inside a subagent view used to
 * look nothing like they do in main. Built-ins resolve their own
 * definition internally; extension tools and our read/edit/bash
 * overrides do not.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const defs = new Map<string, ToolDefinition<any, any, any>>();

export function registerToolDef(def: ToolDefinition<any, any, any>) {
	defs.set(def.name, def);
}

export const toolDefs = {
	get(name: string) {
		return defs.get(name);
	},
};
