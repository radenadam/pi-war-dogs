/**
 * `powershell` — pi's built-in (Windows: pi's own `getPowerShellConfig`
 * refuses to run it anywhere else), re-registered under the SAME contract
 * as the bash skin (2026-08-30, the maintainer: consistent, not identical):
 * our own self-contained description, the optional `description` sentence
 * the pager shows, `background` on main (the job runner speaks PowerShell
 * through pi's config), the child form without it, results stamped by the
 * registration choke point, and pi's abort text completed with WHO. pi's
 * execute is untouched; snippet and guidelines are pi's verbatim (the
 * prompt-parity check). No rg/fd line: that is bash's.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { abortedBy } from "../agents/run.ts";
import { reg } from "./register.ts";
import { startBackground } from "./bash-background.ts";
import { renderPowershellCall as renderCall } from "../visual/tools/bash.ts";

export function build(cwd: string, opts?: { child?: boolean }): ToolDefinition<any, any, any> {
	const stock = createPowerShellTool(cwd);
	const stockProps = ((stock.parameters as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<
		string,
		never
	>;
	const child = !!opts?.child;
	const stockExecute = (stock as any).execute as (...a: any[]) => Promise<any>;
	return {
		...(stock as object),
		description:
			"Execute a PowerShell command in the current working directory and return its stdout and stderr.\n\n" +
			"Output is capped at the last 2000 lines or 50 KB, whichever comes first; when it is cut, the full output is saved to a file and the result names it. An optional timeout in seconds stops the command when it expires.",
		parameters: Type.Object({
			...stockProps,
			description: Type.Optional(
				Type.String({
					description: "One short sentence naming what this command does; the UI shows it in place of the raw command.",
				}),
			),
			...(child
				? {}
				: {
						background: Type.Optional(
							Type.Boolean({
								description:
									"Run the command detached: the call returns a receipt with a run id, and the output and exit code arrive in a separate message as soon as the command exits.",
							}),
						),
					}),
		}),
		execute: async (toolCallId: string, params: any, ...rest: any[]) => {
			if (!child && params?.background === true) {
				const command = typeof params?.command === "string" ? params.command : "";
				const { text, runId } = startBackground(command, cwd, params?.description, "powershell");
				return {
					content: [{ type: "text", text }],
					details: { background: true, runId, command },
				};
			}
			try {
				return await stockExecute(toolCallId, params, ...rest);
			} catch (e) {
				const signal = rest[0] as AbortSignal | undefined;
				const msg = String((e as Error)?.message ?? e);
				if (signal?.aborted && /Command aborted$/.test(msg)) throw new Error(`${msg} by ${abortedBy(rest[2])}`);
				throw e;
			}
		},
		renderCall,
	} as never;
}

/** Registered beside bash; the job runner, its shutdown kill and the `bash-result` renderer are bash's (shared). */
export function register(pi: ExtensionAPI, cwd: string) {
	return reg(pi, build(cwd));
}
