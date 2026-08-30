/**
 * The SESSION BRIEF — dynamic, injected once at the session's first turn
 * (prompt/index.ts), never repeated per turn. Facts the model would
 * otherwise guess at: machine, runtime, references, model facts. Whole
 * lines (and fragments) vanish when their fact is unavailable; a fact we
 * did not set is a fact we do not state (the model-facts map). Stands
 * down with the base under a user SYSTEM.md — first turn is sufficient,
 * every turn is waste, and the user's context engineering is honored
 * whole (dev/internals/README.md; scratchpad v2, artifact 2).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocsPath, getExamplesPath, getReadmePath, getShellConfig, VERSION } from "@earendil-works/pi-coding-agent";
import { mainShells } from "../agents/childtools.ts";
import { agentDir } from "../agents/run.ts";
import { stockToolOptions } from "../settings.ts";

/** The extension folder (this file lives in prompt/). */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** war-dogs' own version: package.json's `version`, read once at load (the banner's pattern). */
const WD_VERSION: string = (() => {
	try {
		return String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))?.version ?? "");
	} catch {
		return "";
	}
})();

/**
 * Model facts we SET, keyed by model id. A model with no entry gets NO
 * model line at all — a fact we did not set is a fact we do not state.
 * Set today: k3 and k3-256k, knowledge cutoff early 2026 (scratchpad v2).
 */
const MODEL_FACTS: Record<string, { name: string; cutoff: string }> = {
	k3: { name: "Kimi K3", cutoff: "early 2026" },
	"k3-256k": { name: "Kimi K3", cutoff: "early 2026" },
};

/** OS name and version: /etc/os-release PRETTY_NAME on Linux, else type + release. */
function osName(): string {
	try {
		if (process.platform === "linux") {
			const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync("/etc/os-release", "utf8"));
			if (m) return m[1];
		}
	} catch {}
	try {
		return `${os.type()} ${os.release()}`;
	} catch {
		return "";
	}
}

/**
 * The shell fact (2026-08-30, the first Windows run): the shell tool(s) main
 * actually HAS (index.ts activateCustomTools publishes them: one per platform
 * unless the user chose), each with what it runs from pi's own resolver
 * (`getShellConfig` with the user's shellPath, the same call pi's bash
 * makes), never `$SHELL`. `$SHELL` is the user's login shell, which is not
 * what the tool runs, and Windows does not set it at all, so a Windows model
 * was told nothing about its shell. A bash on Windows (an explicit choice)
 * is a POSIX shell where the same folder reads /c/Users/..., and that is
 * said. A resolver that throws drops its part; nothing is guessed.
 */
function shellFact(): string {
	const parts: string[] = [];
	const have = mainShells();
	if (have.bash) {
		try {
			const shell = getShellConfig(stockToolOptions().bash.shellPath).shell;
			if (shell) {
				const posixOnWindows = process.platform === "win32" && /bash(?:\.exe)?$/i.test(shell);
				parts.push(
					`the bash tool runs ${shell}` +
						(posixOnWindows
							? " (a POSIX bash on Windows: inside it, Windows paths read /c/Users/..., not C:\\Users\\...)"
							: ""),
				);
			}
		} catch {}
	}
	if (have.powershell) parts.push("the powershell tool runs Windows PowerShell");
	return parts.length ? `Shell: ${parts.join("; ")}.` : "";
}

/** One cheap git read at brief build (the brief happens once), never per turn. */
function gitFacts(cwd: string): string {
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	try {
		const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
		const changed = run(["status", "--porcelain"]).split("\n").filter(Boolean).length;
		const tree = changed === 0 ? "clean" : `${changed} file${changed === 1 ? "" : "s"} changed`;
		return `a git repository on branch ${branch}, tree ${tree}`;
	} catch {
		return "not a git repository";
	}
}

/** Build the brief's text, or null when nothing useful can be stated. */
export function buildBriefText(ctx: unknown): string | null {
	try {
		const c = ctx as { cwd?: string; model?: { id?: string } } | undefined;
		const lines: string[] = ["[session brief: environment and runtime, injected once; facts, not instructions]"];

		const user = (() => {
			try {
				return os.userInfo().username;
			} catch {
				return "";
			}
		})();
		const home = (() => {
			try {
				return os.homedir();
			} catch {
				return "";
			}
		})();
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const tz = (() => {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
			} catch {
				return "";
			}
		})();
		const machineParts = [osName(), user && `user ${user}`, home && `home ${home}`].filter(Boolean);
		const dayParts = [date && `Today is ${date}`, tz && `timezone ${tz}`].filter(Boolean);
		if (machineParts.length || dayParts.length) {
			const head = machineParts.length ? `Machine: ${machineParts.join(", ")}.` : "";
			const day = dayParts.length ? `${dayParts.join(", ")}.` : "";
			lines.push([head, day].filter(Boolean).join(" "));
		}
		const shell = shellFact();
		if (shell) lines.push(shell);

		const cwd = String(c?.cwd ?? process.cwd());
		lines.push(`Working directory: ${cwd}, ${gitFacts(cwd)}.`);

		lines.push(
			`Runtime: Pi v${VERSION}, a terminal coding agent by earendil-works, is running this session. ` +
				`war-dogs v${WD_VERSION} is the extension it is running: this screen, the agent tool, webfetch and web search. ` +
				`It lives at ${ROOT}.`,
		);

		const ad = agentDir();
		lines.push(
			`References, when the user asks about setup. Point and read rather than guess: ` +
				`the user guide is README.md in that folder; settings are ${path.join(ad, "settings.json")}; ` +
				`named agents are markdown files in ${path.join(ad, "subagents")}/, body as the agent's system prompt, ` +
				`frontmatter as its configuration; maintainer depth is dev/internals/README.md and dev/.`,
		);
		// Pi's own docs (2026-08-27, maintainer: curated, never the stock
		// routing table — filenames describe themselves once the dir is
		// known). The getters are pi package exports; a missing one drops
		// its fragment, never guesses a path.
		try {
			const docs = [
				["the readme at", getReadmePath()],
				["docs at", getDocsPath()],
				["examples at", getExamplesPath()],
			].filter((x): x is [string, string] => typeof x[1] === "string" && !!x[1]);
			if (docs.length) {
				lines.push(
					`Pi's own docs, when the user asks about pi itself (extensions, themes, skills, the SDK): ` +
						docs.map(([k, v]) => `${k} ${v}`).join(", ") +
						`; read them rather than answer from memory. For war-dogs beyond the README, dev/internals/SYSTEM-PROMPT.md ` +
						`in that folder turns any capable model into its expert; the user can hand it to another LLM or a fresh session.`,
				);
			}
		} catch {}

		const id = String(c?.model?.id ?? "");
		const facts = MODEL_FACTS[id];
		if (facts) {
			lines.push(
				`Model: You are ${facts.name} (${id}). Your knowledge ends in ${facts.cutoff}; ` +
					`the world since then is unread, so check before you assert anything recent.`,
			);
		}

		return lines.join("\n");
	} catch {
		return null;
	}
}
