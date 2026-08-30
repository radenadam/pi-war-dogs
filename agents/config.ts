/**
 * Where a subagent's settings come from, and in what order.
 *
 *   invocation args  >  agents/*.md frontmatter  >  settings.json  >  default
 *
 * Every key is optional at every level. Nothing here is hardcoded: the
 * whole point of this file is that behaviour is configuration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { collectSettings, projectAllowed } from "../settings.ts";
import { agentDir } from "./run.ts";
import type { AgentDef, RunConfig } from "./run.ts";

/** Built-in fallbacks — the last resort in the precedence chain. */
export const DEFAULTS = {
	// 0 since 2026-08-24 (the agent contract): an agent cannot start agents
	// unless the caller hands it depth — fan-outs are flat unless a tree is
	// deliberate. The top level always has the tool; only grants are capped
	// (agent.maxDepth in settings, unset by default).
	depth: 0,
	/** Working agents per owner before further ones queue (agents/slots.ts). */
	concurrency: 8,
	// NO default timeout (maintainer, 2026-08-21): a silent 600s killed
	// long-horizon runs the user could watch and stop themselves (the
	// station's ✕, the run chat). A timeout exists only when asked for —
	// the call, an agent file, or settings — with settings.maxTimeout_s
	// still a ceiling on any asked value, and the ceiling alone (no ask)
	// bounding nothing.
} as const;

function readSettings(): Record<string, unknown> {
	// The block is `agent` since the tool's 2026-08-24 rename; `subagent`
	// is still read so an existing settings.json keeps working (`agent`
	// wins per key). MERGED per key, the agent dir under the (trusted)
	// project, the way pi and warDogsBlock read settings (2026-08-28, the
	// stress report's A7: first-file-wins let a project `{"agent": {"depth":
	// 1}}` erase every global ceiling).
	const blocks = collectSettings((cfg) => {
		const out: Record<string, unknown> = {};
		let any = false;
		for (const key of ["subagent", "agent"]) {
			const block = (cfg as Record<string, unknown>)?.[key];
			if (block && typeof block === "object") {
				Object.assign(out, block);
				any = true;
			}
		}
		return any ? out : undefined;
	});
	// collectSettings is project-first; merge so the project wins per key.
	const merged: Record<string, unknown> = {};
	for (const b of [...blocks].reverse()) Object.assign(merged, b);
	return merged;
}

function num(v: unknown): number | undefined {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : undefined;
	return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function strList(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.map(String).filter(Boolean);
	if (typeof v === "string" && v.trim()) return v.split(/[,\s]+/).filter(Boolean);
	return undefined;
}

/** invocation > agent frontmatter > settings.json > built-in default */
export function resolveConfig(
	invocation: Record<string, unknown>,
	def: AgentDef | undefined,
	inheritedDepth: number | undefined,
): RunConfig {
	const settings = readSettings();
	// The CALL layer carries only the declared parameters (2026-08-28): pi
	// passes undeclared keys through validation, and reading every key
	// from the call let a model write `extensions: ["/tmp/x.ts"]` and load
	// arbitrary code into its child (demonstrated by probe). extensions is
	// the user's, from an agent file or settings, never the model's.
	const call: Record<string, unknown> = {};
	for (const k of CALL_KEYS) if (invocation[k] !== undefined) call[k] = invocation[k];
	const layers = [call, def?.config ?? {}, settings] as Record<string, unknown>[];
	const pick = <T>(key: string, read: (v: unknown) => T | undefined): T | undefined => {
		for (const layer of layers) {
			if (layer[key] === undefined || layer[key] === null) continue;
			const v = read(layer[key]);
			if (v !== undefined) return v;
		}
		return undefined;
	};
	// A child never gets more depth than its parent handed down, whatever
	// its own config says — otherwise the budget is a suggestion, not a bound.
	const asked = pick("depth", num) ?? DEFAULTS.depth;
	const capped = inheritedDepth === undefined ? asked : Math.min(asked, inheritedDepth);
	// CEILINGS, and they are settings-only on purpose: the layers above are
	// written by the model (invocation) or by whoever wrote an agent file,
	// and a bound either of those can raise is not a bound. Absent, nothing
	// changes. `depth` is what stops a delegation chain from fanning out
	// unattended, `timeout_s` what stops one run from holding a turn open
	// for an hour because the model typed 36000.
	const maxDepth = num(settings.maxDepth);
	const maxTimeout = num(settings.maxTimeout_s);
	const depth = maxDepth === undefined ? capped : Math.min(capped, maxDepth);
	const timeout = pick("timeout_s", num);
	const maxConc = num(settings.maxConcurrent);
	const conc = pick("concurrency", num) ?? DEFAULTS.concurrency;
	const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	return {
		depth: Math.max(0, Math.floor(depth)),
		model: pick("model", (v) => (typeof v === "string" && v ? v : undefined)),
		effort: pick("effort", (v) => (typeof v === "string" && v ? v : undefined)),
		tools: pick("tools", strList),
		excludeTools: pick("excludeTools", strList),
		extensions: pick("extensions", strList),
		timeout_s:
			timeout === undefined
				? undefined
				: Math.max(1, maxTimeout === undefined ? timeout : Math.min(timeout, maxTimeout)),
		cwd: pick("cwd", (v) => (typeof v === "string" && v ? v : undefined)),
		systemPrompt: pick("systemPrompt", str),
		appendSystemPrompt: pick("appendSystemPrompt", str),
		// Whom the agent may reach with message, wait and stop (2026-08-28,
		// the maintainer's reach ruling): its own team by default; the whole
		// session only when granted. The caller clamps a grant to its own.
		reach: pick("reach", (v) => (v === "team" || v === "session" ? v : undefined)) ?? "team",
		concurrency: Math.max(1, Math.floor(maxConc === undefined ? conc : Math.min(conc, maxConc))),
	};
}

/** What a CALL may set: the tool's declared run parameters, nothing else. */
export const CALL_KEYS = [
	"depth",
	"model",
	"effort",
	"tools",
	"excludeTools",
	"timeout_s",
	"cwd",
	"systemPrompt",
	"appendSystemPrompt",
	"concurrency",
	"reach",
] as const;

/** What an agent FILE or the settings block may set: the call keys plus the user-only ones. */
export const CONFIG_KEYS: readonly string[] = [...CALL_KEYS, "extensions"];

/**
 * Agent files that did NOT become an agent, from the last loadAgents().
 *
 * A `.md` with no body, or one that throws while being read, used to vanish
 * without a word: the file is there, the agent is not, and the only symptom
 * is `Unknown agent "reviewer"` — which reads as a typo in the CALL. The
 * reasons are recorded here, printed once at session_start, and named in
 * that error.
 */
export interface AgentDiagnostic {
	file: string;
	reason: string;
}

let diagnostics: AgentDiagnostic[] = [];

export function agentDiagnostics(): AgentDiagnostic[] {
	return diagnostics;
}

/** One line on stderr per bad file, once per distinct set. */
let reported = "";
export function reportAgentDiagnostics() {
	loadAgents();
	const all = [...diagnostics, ...warnings];
	const key = all.map((d) => `${d.file}:${d.reason}`).join("|");
	if (!key || key === reported) return;
	reported = key;
	for (const d of all) console.error(`[war-dogs] agents: ${d.file} — ${d.reason}`);
}

/** Warnings about files that DID become agents (stray frontmatter); stderr-only, never in the Unknown-agent error. */
let warnings: AgentDiagnostic[] = [];

export function loadAgents(): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	const bad: AgentDiagnostic[] = [];
	const warn: AgentDiagnostic[] = [];
	// The project's agents dir only when the project is trusted (pi's rule for
	// project-local resources; an agent file can name `extensions` to load).
	const dirs = [path.join(agentDir(), "subagents")];
	if (projectAllowed()) dirs.push(path.join(process.cwd(), ".pi", "subagents"));
	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) {
			const full = path.join(dir, file);
			try {
				const raw = fs.readFileSync(full, "utf8");
				const fm = (parseFrontmatter(raw)?.frontmatter ?? {}) as Record<string, unknown>;
				const systemPrompt = stripFrontmatter(raw).trim();
				if (!systemPrompt) {
					// The body IS the child's system prompt, so a file without
					// one defines nothing — but it looks like a working agent
					// in the directory listing.
					bad.push({ file: full, reason: "no body — the markdown body is the agent's system prompt" });
					continue;
				}
				const name = String(fm.name ?? file.replace(/\.md$/, "")).trim();
				const config: Record<string, unknown> = {};
				// The BODY is the system prompt; frontmatter systemPrompt used
				// to outrank it (true, silly, untaught — draft 10), and
				// appendSystemPrompt appended a file to its own body. Both are
				// ignored IN FILES with one named warning; they remain call
				// parameters and settings keys, where overriding a hire is real.
				for (const k of CONFIG_KEYS) {
					if (k === "systemPrompt" || k === "appendSystemPrompt") {
						if (fm[k] !== undefined)
							warn.push({ file: full, reason: `frontmatter ${k} ignored — the markdown body is the system prompt` });
						continue;
					}
					if (fm[k] !== undefined) config[k] = fm[k];
				}
				// `thinking` is accepted as an alias for `effort`.
				if (config.effort === undefined && fm.thinking !== undefined) config.effort = fm.thinking;
				agents.set(name, {
					name,
					description: String(fm.description ?? ""),
					systemPrompt,
					config: config as Partial<RunConfig>,
				});
			} catch (e) {
				/* one bad file must not break the tool — but it is not a secret */
				// First line only: a YAML parse error carries the offending
				// snippet and a caret over several lines, and this reason is
				// printed one-per-line and pasted into a tool error.
				bad.push({
					file: full,
					reason: String((e as Error)?.message ?? e)
						.split("\n")[0]
						.trim(),
				});
			}
		}
	}
	diagnostics = bad;
	warnings = warn;
	return agents;
}

/** The bad-file lines to append to an "Unknown agent" error, if any. */
export function describeAgentDiagnostics(): string {
	if (!diagnostics.length) return "";
	return `\nIgnored agent files:\n${diagnostics.map((d) => `${d.file} — ${d.reason}`).join("\n")}`;
}

export function describeAgents(agents: Map<string, AgentDef>): string {
	// A bullet list, blank line above and below (house list style), each agent
	// with the configuration its file sets, so the model is not guessing what
	// a named agent already is. The precedence sentence is stated once here:
	// call parameters override the agent's own configuration.
	const cfgLine = (a: AgentDef) => {
		const c = a.config as Record<string, unknown>;
		const parts: string[] = [];
		for (const k of ["model", "effort", "depth", "timeout_s", "cwd"]) {
			if (c?.[k] !== undefined) parts.push(`${k}: ${String(c[k])}`);
		}
		if (Array.isArray(c?.tools) && c.tools.length) parts.push(`tools: ${(c.tools as string[]).join("/")}`);
		return parts.length ? ` (${parts.join(", ")})` : "";
	};
	const rows = [...agents.values()].map(
		(a) => `- "${a.name}"${a.description ? `: ${a.description}` : ""}${cfgLine(a)}`,
	);
	// The heading is the contract's (dev/internals/README.md, draft 10):
	// ALWAYS present — the save-as-hire doctrine needs the file shape known
	// before any agent exists — with real paths interpolated. With agents
	// the last sentence ends in a colon and the bullets follow; with none
	// it ends in a period and nothing follows.
	const head =
		`Named agents, global and project. A named agent is a markdown file in ` +
		`${path.join(agentDir(), "subagents")} or ${path.join(process.cwd(), ".pi", "subagents")}, ` +
		`the body its system prompt, the frontmatter any run parameter except title, message, and agent, ` +
		`plus name, description, and extensions. The description is all a chooser reads, so write it for ` +
		`the choosing: the work to hand it, the edge it carries, and the work to keep from it. ` +
		`A file saved or edited while this session runs is live on your next call; this list refreshes when the session starts. ` +
		`Save one and it appears here`;
	return rows.length ? `\n\n${head}:\n\n${rows.join("\n")}` : `\n\n${head}.`;
}

/**
 * The resolved defaults and ceilings a schema can state as numbers (the
 * settings layer of resolveConfig, read the same way), so the parameter
 * descriptions never claim a default the user's settings have overridden.
 */
export function configFacts(): {
	defaultDepth: number;
	maxDepth?: number;
	defaultTimeout?: number;
	maxTimeout?: number;
	settingsModel?: string;
	settingsEffort?: string;
	defaultConcurrency: number;
	/** Whether $ figures appear in model-facing trailers (maintainer 2026-08-27: cost helps no goal; opt-in). */
	discloseCost: boolean;
	/** Whether token counts appear in model-facing trailers (maintainer 2026-08-28: cost awareness, not the goal; opt-in). */
	discloseTokens: boolean;
} {
	const settings = readSettings();
	const md = num(settings.maxDepth);
	const mt = num(settings.maxTimeout_s);
	const t = num(settings.timeout_s);
	const d = num(settings.depth) ?? DEFAULTS.depth;
	const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	const mc = num(settings.maxConcurrent);
	const c = num(settings.concurrency) ?? DEFAULTS.concurrency;
	return {
		defaultDepth: md === undefined ? d : Math.min(d, md),
		maxDepth: md,
		defaultTimeout: t === undefined ? undefined : mt === undefined ? t : Math.min(t, mt),
		maxTimeout: mt,
		settingsModel: str(settings.model),
		settingsEffort: str(settings.effort),
		defaultConcurrency: Math.max(1, Math.floor(mc === undefined ? c : Math.min(c, mc))),
		discloseCost: settings.discloseCost === true,
		discloseTokens: settings.discloseTokens === true,
	};
}
