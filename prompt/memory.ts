/**
 * MEMORY (dev/internals/README.md, FINAL 2026-08-25) — not a tool: a
 * prompt-block RIDER plus a per-turn index injection plus plain files.
 * The model keeps notes with the file tools it already has; the harness
 * contributes exactly three things: the block (memory-text.ts, verbatim
 * from the contract), the index injection with a HARNESS-computed gauge,
 * and the store scaffolding (reference.md + a legend-opened MEMORY.md —
 * the reference is OURS and is kept identical; an existing MEMORY.md is
 * the MODEL's and is never touched).
 *
 * ALL-OR-NOTHING, default ON: `memory.enabled: false` in settings turns it off (a top-level
 * `memory` block, the `agent` block's precedent), `WAR_DOGS_MEMORY` as
 * the per-invocation env override (the WAR_DOGS_ENABLED pattern). Off:
 * no block, no injection, nothing read — the gate is per turn, so
 * `/memory on|off` needs no reload. The rider SURVIVES a user SYSTEM.md
 * (the contract's requirement, the opposite of the base): prompt/index.ts
 * appends it to whichever prompt is in force. Per-turn appending is what
 * makes compaction re-injection free and keeps the index CURRENT as the
 * model writes notes mid-session.
 *
 * Stores: global `<agentDir>/memory/` always (when on); project
 * `<cwd>/.pi/memory/` only when the project is TRUSTED (settings.ts
 * projectAllowed — pi's rule for project-local resources).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../agents/run.ts";
import { findSettings, projectAllowed } from "../settings.ts";
import { MEMORY_BLOCK, MEMORY_LEGEND, MEMORY_REFERENCE } from "./memory-text.ts";

/** The top-level `memory` settings block (the `agent` block's precedent). */
function memBlock(): Record<string, unknown> {
	return (
		findSettings((cfg) => {
			const b = (cfg as Record<string, unknown>)?.memory;
			return b && typeof b === "object" ? (b as Record<string, unknown>) : undefined;
		}) ?? {}
	);
}

/** `WAR_DOGS_MEMORY`: 0/false forces off, 1/true on, anything else defers to settings. */
export function envMemoryOverride(): boolean | undefined {
	const v = process.env.WAR_DOGS_MEMORY;
	if (v === "0" || v === "false") return false;
	if (v === "1" || v === "true") return true;
	return undefined;
}

export function memoryEnabled(): boolean {
	return envMemoryOverride() ?? memBlock().enabled !== false;
}

/** The index cap in characters, per store (a borrowed number — settings, not truth). */
function indexBudget(): number {
	const v = Number(memBlock().indexBudget);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : 25000;
}

const globalStore = () => path.join(agentDir(), "memory");
const projectStore = () => path.join(process.cwd(), ".pi", "memory");

/**
 * Scaffold one store: the directory, OUR reference.md (kept byte-identical
 * — the contract: an identical generated copy in every store), and a
 * legend-opened MEMORY.md ONLY when missing (the index is the model's).
 */
function ensureStore(dir: string): void {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const ref = path.join(dir, "reference.md");
		const want = `${MEMORY_REFERENCE}\n`;
		let same = false;
		try {
			same = fs.readFileSync(ref, "utf8") === want;
		} catch {}
		if (!same) fs.writeFileSync(ref, want);
		const idx = path.join(dir, "MEMORY.md");
		if (!fs.existsSync(idx)) fs.writeFileSync(idx, `${MEMORY_LEGEND}\n`);
	} catch {
		/* an unwritable store degrades to no scaffolding; the rider still
		   reports what it can read, and a missing index injects nothing */
	}
}

function scaffold(): void {
	ensureStore(globalStore());
	if (projectAllowed()) ensureStore(projectStore());
}

/** One store's injectable head: entry lines cut at the budget, with an honest remainder and gauge facts. */
function readIndex(dir: string): { size: number; entries: string[]; cutNote: string; over: boolean } | null {
	let raw = "";
	try {
		raw = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	} catch {
		return null;
	}
	const budget = indexBudget();
	const all = raw.split("\n").filter((l) => l.startsWith("- "));
	const entries: string[] = [];
	let used = 0;
	for (const l of all) {
		if (used + l.length + 1 > budget) break;
		entries.push(l);
		used += l.length + 1;
	}
	const cut = all.length - entries.length;
	return {
		size: raw.length,
		entries,
		cutNote: cut > 0 ? `… ${cut} more entr${cut === 1 ? "y" : "ies"} not shown` : "",
		over: raw.length > budget,
	};
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/**
 * The rider appended to the system prompt every turn while memory is on:
 * the block, then the index injection with the harness-computed gauge.
 * Null when off — the all-or-nothing switch, read per turn.
 */
export function buildMemoryRider(): string | null {
	if (!memoryEnabled()) return null;
	scaffold();
	const g = readIndex(globalStore());
	const pDir = projectStore();
	const p = projectAllowed() && fs.existsSync(pDir) ? readIndex(pDir) : null;
	const budget = indexBudget();
	const size = (g?.size ?? 0) + (p?.size ?? 0);
	const nG = g?.entries.length ?? 0;
	const nP = p?.entries.length ?? 0;
	const over = g?.over || p?.over;
	const lines: string[] = [
		"Your memory — notes you wrote in earlier sessions; read a note's file when you need it. The format: <store>/reference.md.",
		`[memory index: ${fmtK(size)} of ${fmtK(budget)} chars · ${nG + nP} entr${nG + nP === 1 ? "y" : "ies"} · ${nG} global · ${nP} project${over ? " · over budget — consolidate" : ""}]`,
	];
	if (g) {
		lines.push(`(global: ${globalStore()}/)`);
		lines.push(...g.entries);
		if (g.cutNote) lines.push(g.cutNote);
	}
	if (p) {
		lines.push(`(project: .pi/memory/)`);
		lines.push(...p.entries);
		if (p.cutNote) lines.push(p.cutNote);
	}
	return `\n\n${MEMORY_BLOCK}\n\n${lines.join("\n")}`;
}

/** Write `memory.enabled` into the agent-dir settings.json (the writeEnabledSetting pattern). */
function writeMemoryEnabled(next: boolean): boolean {
	try {
		const file = path.join(agentDir(), "settings.json");
		let cfg: Record<string, unknown> = {};
		try {
			cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		const block = cfg.memory && typeof cfg.memory === "object" ? (cfg.memory as Record<string, unknown>) : {};
		block.enabled = next;
		cfg.memory = block;
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

function countNotes(dir: string): number {
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "reference.md").length;
	} catch {
		return -1;
	}
}

export function registerMemory(pi: ExtensionAPI): void {
	pi.registerCommand("memory", {
		description: "Show the memory store, or toggle it. Usage: /memory [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				const want = arg === "on";
				const pinned = envMemoryOverride();
				if (pinned !== undefined && pinned !== want) {
					ctx.ui.notify(
						`WAR_DOGS_MEMORY=${process.env.WAR_DOGS_MEMORY} pins memory ${pinned ? "on" : "off"} for this process — unset it to switch.`,
						"warning",
					);
					return;
				}
				if (!writeMemoryEnabled(want)) {
					ctx.ui.notify(`Couldn't write settings.json — set "memory": { "enabled": ${want} } yourself.`, "warning");
					return;
				}
				if (want) scaffold();
				// Per-turn gate: no reload — the block and index ride (or stop
				// riding) from the very next turn.
				ctx.ui.notify(
					`memory ${want ? "on — the block and index ride the next turn" : "off — nothing appended, nothing read"}`,
					"info",
				);
				return;
			}
			const on = memoryEnabled();
			const gN = countNotes(globalStore());
			const pTrusted = projectAllowed();
			const pExists = pTrusted && fs.existsSync(projectStore());
			const pN = pExists ? countNotes(projectStore()) : -1;
			const parts = [
				`memory is ${on ? "on" : "off"}${envMemoryOverride() !== undefined ? " (pinned by WAR_DOGS_MEMORY)" : ""}`,
				`global: ${globalStore()}/ (${gN >= 0 ? `${gN} note${gN === 1 ? "" : "s"}` : "not created yet"})`,
				pExists
					? `project: .pi/memory/ (${pN} note${pN === 1 ? "" : "s"})`
					: pTrusted
						? "project: .pi/memory/ (not created yet)"
						: "project: untrusted — no project store",
				`index budget ${fmtK(indexBudget())} chars/store · /memory on|off toggles`,
			];
			ctx.ui.notify(parts.join(" · "), "info");
		},
	});
	// The project store is created when the project is TRUSTED (the
	// contract; pi's rule for project-local resources) — trust is known at
	// session_start, so scaffold there while on.
	pi.on("session_start", async () => {
		if (memoryEnabled()) scaffold();
	});
}
