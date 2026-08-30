/**
 * `bash` — pi's built-in, re-registered for syntax highlighting and two
 * schema additions: an OPTIONAL `description` param, and `background`
 * (tools/bash-background.ts — pi's bash has no background mode). The model may supply a short sentence describing what the
 * command does; the pager shows that sentence as the collapsed beat instead
 * of the raw command head. The renderer always has a derived fallback, so
 * the sentence is never load-bearing — and because a boot with war-dogs off
 * never registers this skin, the extra params are absent from the model's
 * schema when war-dogs is off (self-containment).
 *
 * createBashTool() is the one factory in that family that DOES carry
 * prompt metadata, so a plain spread covers snippet + guidelines.
 */

import { abortedBy, agentDir } from "../agents/run.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Capability-truth (the canDeliver-variant pattern, 2026-08-27): the
 * description names rg/fd only when they are actually installed — a
 * conditional "if available" makes the model spend a probe or risk a
 * failed command. Probed once per process; `where` on Windows, and a
 * missing prober degrades to silence, never to a guess. Two places count
 * (2026-08-30, the first Windows run): the process PATH, and pi's own
 * `<agentDir>/bin`, where pi downloads rg and fd when they are not on PATH
 * and which its shell tools put FIRST on the command's PATH (`getShellEnv`,
 * dist/utils/shell.js). A PATH-only probe stayed silent on a machine where
 * every command the model ran had both.
 */
const MODERN_TOOLS: string = (() => {
	const has = (bin: string): boolean => {
		try {
			execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
			return true;
		} catch {}
		try {
			return fs.existsSync(path.join(agentDir(), "bin", bin + (process.platform === "win32" ? ".exe" : "")));
		} catch {
			return false;
		}
	};
	const rg = has("rg");
	const fd = has("fd");
	if (rg && fd) return "\n\nrg and fd are installed; prefer them over grep and find.";
	if (rg) return "\n\nrg is installed; prefer it over grep.";
	if (fd) return "\n\nfd is installed; prefer it over find.";
	return "";
})();

import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCall, renderResultMessage } from "../visual/tools/bash.ts";
import { reg } from "./register.ts";
import { stockToolOptions } from "../settings.ts";
import { bindBackgroundBash, startBackground, stopAllBackground } from "./bash-background.ts";

/**
 * The bash skin for a given cwd. `child: true` builds the CHILD form
 * (2026-08-22): the same description and `description` param, no
 * `background` at all — a child always runs foreground, and a background
 * job's result delivers through the parent's ExtensionAPI, which a child
 * session does not have (the ledger's reason children were stock until now).
 * A parameter inert for its reader is omitted, not documented as inert.
 */
export function build(cwd: string, opts?: { child?: boolean }): ToolDefinition<any, any, any> {
	// The same options pi hands its own bash tool: settings.shellPath and
	// shellCommandPrefix — without them the model's commands ran in a
	// different shell than stock, with the master switch on or off.
	const shell = stockToolOptions().bash;
	const stock = createBashTool(cwd, shell);
	const stockProps = ((stock.parameters as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<
		string,
		never
	>;
	const child = !!opts?.child;
	const stockExecute = (stock as any).execute as (...a: any[]) => Promise<any>;
	return {
		...stock,
		// Our description (2026-08-21), one voice with the other tools; the
		// numbers restate pi's own caps (truncate.js defaults), behavior pi's.
		description:
			"Execute a bash command in the current working directory and return its stdout and stderr.\n\n" +
			"Output is capped at the last 2000 lines or 50 KB, whichever comes first; when it is cut, the full output is saved to a file and the result names it. An optional timeout in seconds stops the command when it expires." +
			MODERN_TOOLS,
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
		// One of the three sanctioned model-facing changes to a built-in skin
		// (README, load-bearing): background is OUR path; everything else is
		// pi's own execute, untouched.
		execute: async (toolCallId: string, params: any, ...rest: any[]) => {
			if (!child && params?.background === true) {
				const command = typeof params?.command === "string" ? params.command : "";
				const { text, runId } = startBackground(command, cwd, params?.description);
				return {
					content: [{ type: "text", text }],
					details: { background: true, runId, command },
				};
			}
			// pi's abort text completed with WHO aborted (agents/run.ts abortedBy):
			// "Command aborted by the user" / "…by the agent that started it".
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

export function register(pi: ExtensionAPI, cwd: string) {
	// Background jobs deliver through the LIVE ExtensionAPI and are killed
	// with the session (see tools/bash-background.ts).
	bindBackgroundBash(pi, {
		shellPath: stockToolOptions().bash.shellPath,
		commandPrefix: stockToolOptions().bash.commandPrefix,
	});
	pi.on("session_shutdown", async (e: any) =>
		stopAllBackground(
			e?.reason && e.reason !== "quit" ? `stopped by the session ending (/${e.reason})` : "stopped by pi exiting",
		),
	);
	// A job's delivered output (`bash-result`) renders as a machinery beat; a
	// boot with war-dogs off never registers this renderer, so pi draws its
	// stock box.
	pi.registerMessageRenderer("bash-result", renderResultMessage);
	return reg(pi, build(cwd));
}
