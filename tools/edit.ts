/**
 * `edit` — pi's built-in, re-registered for our diff-stats renderer.
 * See tools/read.ts for why prompt metadata is re-declared.
 */

import { createEditTool, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult, renderShell } from "../visual/tools/edit.ts";
import { reg } from "./register.ts";

/** The edit skin for a given cwd — the parent registers it; a child is handed one built for ITS cwd. */
export function build(cwd: string): ToolDefinition<any, any, any> {
	const edit = createEditTool(cwd);
	const meta = createEditToolDefinition(cwd);
	return {
		...edit,
		// Our description (2026-08-21): the failure contract stated plainly;
		// pi's how-to-comply advice removed (zero direction). Behavior and
		// prompt metadata stay pi's.
		description:
			"Edit one file by exact text replacement.\n\n" +
			"Each edits[].oldText must match exactly one region of the current file, and regions must not overlap. Edits in one call apply together: if any oldText fails to match, none are applied. Every oldText is matched against the original file, never against the result of earlier edits in the same call.",
		promptSnippet: meta.promptSnippet,
		promptGuidelines: meta.promptGuidelines,
		// Batch rejections are atomic, but the stock error only names the failing
		// edit; an agent can miss that the good edits were also discarded. Say it.
		async execute(...args: any[]) {
			try {
				return await (edit.execute as any)(...args);
			} catch (e: any) {
				const params = args[1];
				const n = Array.isArray(params?.edits) ? params.edits.length : 1;
				if (n > 1) {
					throw new Error(
						`${e?.message ?? e}\n\nNo edits were applied: batches are atomic (0 of ${n}). Fix the failing oldText and resubmit the whole batch.`,
					);
				}
				throw e;
			}
		},
		renderShell,
		renderCall,
		renderResult,
	} as never;
}

export function register(pi: ExtensionAPI, cwd: string) {
	return reg(pi, build(cwd));
}
