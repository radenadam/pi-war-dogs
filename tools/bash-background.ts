/**
 * Background bash — war-dogs' `background: true` on the bash tool.
 *
 * pi's bash has no background mode: a trailing `&` returns at once and the
 * child's output never comes back. This gives the model a real one, shaped
 * exactly like the background subagent: the tool returns a RECEIPT with a run
 * id immediately, the command runs detached from the turn (Esc does not kill
 * it), its output is captured, and when it exits the answer arrives as a
 * `bash-result` custom message through `pi.sendMessage(deliverAs:"steer",
 * triggerTurn:true)` — injected at the next tool boundary of a turn still
 * in flight (a followUp waited for the WHOLE turn; maintainer, 2026-08-20),
 * or starting a turn when main is idle.
 *
 * Jobs are SESSION-scoped: `session_shutdown` (quit, /new, /fork, /resume,
 * /reload) kills every running job, because the `pi` handle a job would
 * deliver through is invalidated by pi at session replacement — a message
 * from a job of the previous session has no receiver. The receipt says so.
 *
 * Output is capped for the model (OUT_MAX_LINES, head + tail) and the tail
 * of the text carries the standard trailer: a blank line, then `[run id: …]`.
 * The delivered result opens with BASH_DELIVERY — pi hands a custom message
 * to the model as a plain user message, so the text says it is a delivery.
 */

import { getPowerShellConfig, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { clearDeliveries, flushDeliveries, deliver } from "./delivery.ts";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { pidAlive, runsRoot } from "../agents/run.ts";

/**
 * A job's manifest on disk, beside the session's runs (`<runsRoot>/jobs/`):
 * written at spawn, removed when the job delivers, kept with `killed` when
 * the session ended under it (stopAllBackground) — so the next start of that
 * session can tell the model which jobs never delivered (tools/interrupted.ts;
 * 2026-08-29: a job killed by /reload was never mentioned again, and the
 * receipt had promised its output "in a separate message").
 */
export interface JobManifest {
	id: string;
	title: string;
	command: string;
	/** Which shell tool started it (absent on manifests before 2026-08-30: bash). */
	tool?: ShellTool;
	pid: number | undefined;
	startedAt: number;
	/** The stop cause, in the runs' grammar: "stopped by the session ending (/reload)" | "stopped by pi exiting". */
	killed?: string;
	killedAt?: number;
	reported?: boolean;
}
function jobsDir(): string {
	return joinPath(runsRoot(), "jobs");
}
function jobFile(id: string): string {
	return joinPath(jobsDir(), `${id}.json`);
}
function writeJob(m: JobManifest): void {
	try {
		mkdirSync(jobsDir(), { recursive: true });
		writeFileSync(jobFile(m.id), JSON.stringify(m));
	} catch {}
}
function readJobs(): JobManifest[] {
	const out: JobManifest[] = [];
	try {
		for (const f of readdirSync(jobsDir())) {
			if (!f.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(joinPath(jobsDir(), f), "utf8")) as JobManifest);
			} catch {}
		}
	} catch {}
	return out;
}
/**
 * The jobs of this session that never delivered and were never reported: killed
 * at a session end, or left behind by a crash (the pid is dead, or alive and
 * orphaned — it is stopped here, since nothing can receive its output).
 */
export function killedJobs(): JobManifest[] {
	const out: JobManifest[] = [];
	for (const m of readJobs()) {
		if (m.reported) continue;
		if (!m.killed) {
			if (jobs.has(m.id)) continue; // this process's own live job
			if (m.pid && pidAlive(m.pid)) {
				try {
					if (process.platform !== "win32") process.kill(-m.pid, "SIGTERM");
					else process.kill(m.pid, "SIGTERM");
				} catch {}
			}
			m.killed = "stopped by pi exiting";
			m.killedAt = Date.now();
			writeJob(m);
		}
		out.push(m);
	}
	return out;
}
export function markJobReported(m: JobManifest): void {
	m.reported = true;
	writeJob(m);
}

export const OUT_MAX_LINES = 200;
/** First line of a delivered result; visual/tools/bash.ts's parser skips it. */
export const BASH_DELIVERY = "[background bash result, delivered by the bash tool; not sent by the user]";
/** The same line for a job of the other shell (2026-08-30: powershell under the same contract). */
export type ShellTool = "bash" | "powershell";
export const deliveryLineFor = (tool: ShellTool) =>
	`[background ${tool} result, delivered by the ${tool} tool; not sent by the user]`;
const OUT_MAX_BYTES = 256 * 1024;

interface Job {
	id: string;
	title: string;
	command: string;
	tool: ShellTool;
	pid: number | undefined;
	startedAt: number;
	chunks: string[];
	bytes: number;
	done: boolean;
}

const jobs = new Map<string, Job>();
/** The live ExtensionAPI (re-bound per factory run — pi replaces it per session). */
let currentPi: ExtensionAPI | null = null;
let shellPath: string | undefined;
let commandPrefix: string | undefined;

export function bindBackgroundBash(pi: ExtensionAPI, opts?: { shellPath?: string; commandPrefix?: string }) {
	currentPi = pi;
	shellPath = opts?.shellPath;
	commandPrefix = opts?.commandPrefix;
}

export function newRunId(): string {
	return `bash_${randomBytes(9).toString("base64url")}`;
}

/** Title for a job: the model's description, else the command's first line. */
export function jobTitle(command: string, description?: unknown): string {
	const d = typeof description === "string" ? description.trim() : "";
	if (d) return d;
	const first = command.split("\n")[0].trim();
	return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

/**
 * Start a background job. Returns the receipt the tool hands the model.
 */
export function startBackground(
	command: string,
	cwd: string,
	description?: unknown,
	tool: ShellTool = "bash",
): { text: string; runId: string } {
	const id = newRunId();
	const title = jobTitle(command, description);
	// PowerShell through pi's own config (pi refuses it off Windows — the
	// same refusal its foreground tool gives, thrown to the caller).
	const cfg =
		tool === "powershell" ? { ...getPowerShellConfig(), commandTransport: "argv" as const } : getShellConfig(shellPath);
	const fromStdin = cfg.commandTransport === "stdin";
	// The user's `shellCommandPrefix` rides a background command exactly as
	// pi's bash rides it on a foreground one (`${prefix}\n${command}`, core/
	// tools/bash.js) — until 2026-08-30 a background job ran without it
	// (the pi-settings review).
	// pi's PowerShell ops prepend the UTF-8 output prefix; mirrored, so a
	// background job prints what a foreground one prints.
	const resolved =
		tool === "powershell"
			? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`
			: commandPrefix
				? `${commandPrefix}\n${command}`
				: command;
	const child = spawn(cfg.shell, fromStdin ? cfg.args : [...cfg.args, resolved], {
		cwd,
		detached: process.platform !== "win32",
		env: process.env,
		stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (fromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(resolved);
	}
	const job: Job = {
		id,
		title,
		command,
		tool,
		pid: child.pid,
		startedAt: Date.now(),
		chunks: [],
		bytes: 0,
		done: false,
	};
	jobs.set(id, job);
	writeJob({ id, title, command, tool, pid: child.pid, startedAt: job.startedAt });
	const onData = (b: Buffer) => {
		if (job.bytes >= OUT_MAX_BYTES) return;
		const s = b.toString("utf8");
		job.bytes += s.length;
		job.chunks.push(s);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	const finish = (exitCode: number | null, signal: NodeJS.Signals | null, err?: Error) => {
		if (job.done) return;
		job.done = true;
		jobs.delete(id);
		try {
			unlinkSync(jobFile(id));
		} catch {}
		const seconds = Math.round((Date.now() - job.startedAt) / 1000);
		const full = job.chunks.join("");
		const { text: out, savedPath } = capOutput(full, id);
		let state: string;
		if (err) state = `failed to start: ${err.message}`;
		else if (signal) state = `was stopped after ${seconds}s (${signal})`;
		else if (exitCode === 0) state = `finished in ${seconds}s (exit 0)`;
		else state = `failed in ${seconds}s (exit ${exitCode})`;
		void savedPath; // named in the omission notice inside `out` when the cap fired
		// Through the shared delivery queue (tools/delivery.ts): alone, the
		// same `bash-result` steer as before; with other jobs finishing in
		// the same window, one batched message.
		if (currentPi)
			deliver(currentPi, {
				customType: "bash-result",
				provenance: deliveryLineFor(tool),
				body: `Background ${tool} "${title}" ${state}:\n\n${out || "(no output)"}\n\n[run id: ${id}]`,
				details: { runId: id, title, command, tool, seconds, exitCode, signal, background: true },
			});
	};
	child.on("error", (e) => finish(null, null, e));
	child.on("close", (code, sig) => finish(code, sig));
	const text = `Started "${title}" in the background. The output and exit code will arrive in a separate message as soon as the command exits.\n\n[run id: ${id}]`;
	return { text, runId: id };
}

/**
 * Head + tail of a long output, so the model reads the start and the end —
 * and since 2026-08-21 the omitted middle is RECOVERABLE: the full output is
 * saved to a temp file (pi's own bash pattern) and the notice names it. It
 * used to exist nowhere (proposal §6: the one unrecoverable cut).
 */
function capOutput(s: string, id: string): { text: string; savedPath?: string } {
	const trimmed = s.replace(/\s+$/, "");
	const lines = trimmed.split("\n");
	if (lines.length <= OUT_MAX_LINES) return { text: trimmed };
	let savedPath: string | undefined;
	try {
		savedPath = joinPath(tmpdir(), `wd-bash-${id}.txt`);
		writeFileSync(savedPath, s);
	} catch {
		savedPath = undefined;
	}
	const head = Math.floor(OUT_MAX_LINES * 0.6);
	const tail = OUT_MAX_LINES - head;
	return {
		text: [
			...lines.slice(0, head),
			`… [${lines.length - OUT_MAX_LINES} lines omitted of ${lines.length}${savedPath ? `. Full output: ${savedPath}` : ""}]`,
			...lines.slice(lines.length - tail),
		].join("\n"),
		savedPath,
	};
}

/** Running job count (for anyone who wants to show it). */
export function runningJobs(): number {
	return jobs.size;
}

/** The running jobs, oldest first — what the footer strip shows beside the subagents. */
export function runningJobList(): { id: string; title: string; startedAt: number }[] {
	return [...jobs.values()].filter((j) => !j.done).map((j) => ({ id: j.id, title: j.title, startedAt: j.startedAt }));
}

/** Kill every running job (session shutdown); `cause` in the runs' grammar is kept on each job's manifest. */
export function stopAllBackground(cause = "stopped by pi exiting"): void {
	// The delivery queue goes with the session (its `pi` handle is about to
	// be invalidated) — jobs and subagent results alike.
	flushDeliveries();
	clearDeliveries();
	for (const job of jobs.values()) {
		if (job.done) continue;
		job.done = true;
		writeJob({
			id: job.id,
			title: job.title,
			command: job.command,
			tool: job.tool,
			pid: job.pid,
			startedAt: job.startedAt,
			killed: cause,
			killedAt: Date.now(),
		});
		if (!job.pid) continue;
		try {
			if (process.platform !== "win32") process.kill(-job.pid, "SIGTERM");
			else process.kill(job.pid, "SIGTERM");
		} catch {}
	}
	jobs.clear();
}
