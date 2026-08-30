/**
 * `write` — pi's built-in, re-registered for our call/result split.
 * See tools/read.ts for why prompt metadata is re-declared.
 */

import { createWriteTool, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "../visual/tools/write.ts";
import { reg } from "./register.ts";

/** The write skin for a given cwd — the parent registers it; a child is handed one built for ITS cwd. */
export function build(cwd: string): ToolDefinition<any, any, any> {
	const write = createWriteTool(cwd);
	const meta = createWriteToolDefinition(cwd);
	return {
		...write,
		// Our description, in the one voice every tool shares (2026-08-21;
		// sanctioned model-facing change: descriptions are ours, behavior and
		// prompt metadata stay pi's).
		description:
			"Write content to a file.\n\n" +
			"Creates the file if it does not exist, overwrites it if it does, and creates missing parent directories. It replaces the whole file; do not use it to change part of one.",
		promptSnippet: meta.promptSnippet,
		promptGuidelines: meta.promptGuidelines,
		renderCall,
		renderResult,
	} as never;
}

export function register(pi: ExtensionAPI, cwd: string) {
	return reg(pi, build(cwd));
}
