/**
 * scout — delegate fetch-and-judge work to a headless agent CLI.
 *
 * When WebFetch is called with `expect`, the URL(s) are handed to a scout:
 * a headless agent (pi or claude CLI) that fetches each page itself via the
 * WebFetch CLI, judges whether it substantively answers the caller's need,
 * and returns verdicts plus extracted content. The main session never sees
 * dud pages; only the scout's verdicts and extracts come back.
 *
 * Config lives in settings.json under "war-dogs"."expect":
 *
 *   "expect": {
 *     "profile": "pi-k3-low",
 *     "maxUrls": 10,
 *     "timeoutMs": 240000,
 *     "fetchCommand": "npm --prefix <extDir> run fetch -- <url> --content --full",  (default: self-resolved)
 *     "profiles": {
 *       "pi-k3-low":      { "cmd": "pi",     "args": [...], "env": {...}, "output": "pi-jsonl" },
 *       "claude-opus-low": { "cmd": "claude", "args": [...], "env": {...}, "output": "claude-json" }
 *     }
 *   }
 *
 * Scout isolation comes from CLI flags, not cwd: pi gets
 * --no-extensions/--no-skills/--no-context-files/etc., claude gets
 * --safe-mode, so global AGENTS.md/SYSTEM.md/customizations never leak
 * into the scout regardless of where it runs. The scout fetches via the
 * WebFetch CLI (bash only), so it cannot reach this extension's WebFetch
 * tool; expect-driven recursion is structurally impossible.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ScoutVerdict {
	url: string;
	verdict: string;
	reason?: string;
	evidence?: string;
}

export interface ScoutExtract {
	url: string;
	form?: string;
	text?: string;
}

export interface ScoutOutcome {
	ok: boolean;
	profile: string;
	results: ScoutVerdict[];
	extracts: ScoutExtract[];
	/** URLs the caller passed that were NOT evaluated (past maxUrls). Never silent. */
	skipped: string[];
	/** Configuration that was ignored because it was unusable. */
	configWarnings: string[];
	error?: string;
	durationMs: number;
}

interface ScoutProfile {
	cmd: string;
	args: string[];
	env?: Record<string, string>;
	output?: string; // "pi-jsonl" (default) | "claude-json" | "text"
}

interface ScoutConfig {
	profile: string;
	maxUrls: number;
	timeoutMs: number;
	fetchCommand: string;
	profiles: Record<string, ScoutProfile>;
}

/** Directory containing this extension (war-dogs/), derived from this file's location (tools/library/webfetch/). */
function extensionDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function defaultFetchCommand(): string {
	return `npm --prefix ${extensionDir()} run fetch -- <url> --content --full`;
}

/**
 * The pi the scout spawns is THE PI THIS CODE RUNS INSIDE — `process.execPath`
 * plus pi's own entry script (`process.argv[1]`, e.g. …/dist/cli.js) — not a
 * bare `pi` on PATH: that ran whichever pi was first on PATH (a 0.83 next to
 * a 0.84 host), needed pi on PATH at all, and broke under a rebranded binary.
 * A profile may still set its own `cmd`; when the host cannot be identified
 * (a probe running the library outside pi) the bare name is the fallback.
 */
const PI_ENTRY = (() => {
	const a1 = process.argv[1] ?? "";
	return /pi-coding-agent[\\/]dist[\\/]cli\.js$|[\\/]bin[\\/]pi$|[\\/]pi$/.test(a1) ? a1 : "";
})();
const PI_CMD = PI_ENTRY ? process.execPath : "pi";
const PI_PRE = PI_ENTRY ? [PI_ENTRY] : [];

function defaultProfiles(): Record<string, ScoutProfile> {
	const piArgs = (model: string[]): string[] => [
		"-p",
		"--no-session",
		"--mode",
		"json",
		...model,
		"--thinking",
		"low",
		"--tools",
		"bash",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--system-prompt",
		"{{system_prompt}}",
		// No {{prompt}}: the user prompt goes in on STDIN, not argv, so the
		// caller's question and candidate URLs are not on the process list for
		// every other user on the machine to read.
	];
	return {
		// The default names no model: it uses whatever model this machine is
		// configured with, which is what "Runtime requirements: a configured
		// model" in the README promises. Pinning k3-256k here made the default
		// scout fail on any box without a Kimi provider.
		"pi-default": { cmd: PI_CMD, args: [...PI_PRE, ...piArgs([])], output: "pi-jsonl" },
		"pi-k3-low-stdin": { cmd: PI_CMD, args: [...PI_PRE, ...piArgs(["--model", "k3-256k"])], output: "pi-jsonl" },
		"pi-k3-low": {
			cmd: PI_CMD,
			args: [
				...PI_PRE,
				"-p",
				"--no-session",
				"--mode",
				"json",
				"--model",
				"k3-256k",
				"--thinking",
				"low",
				"--tools",
				"bash",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--system-prompt",
				"{{system_prompt}}",
				"{{prompt}}",
			],
			output: "pi-jsonl",
		},
		"claude-opus-low": {
			cmd: "claude",
			args: [
				"-p",
				"{{prompt}}",
				"--system-prompt-file",
				"{{system_prompt_file}}",
				"--dangerously-skip-permissions",
				"--effort",
				"low",
				"--model",
				"claude-opus-4-8",
				"--tools",
				"Bash",
				"--safe-mode",
				"--no-session-persistence",
				"--output-format",
				"json",
			],
			env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
			output: "claude-json",
		},
	};
}

function defaultConfig(): ScoutConfig {
	return {
		profile: "pi-default",
		maxUrls: 10,
		timeoutMs: 240_000,
		fetchCommand: defaultFetchCommand(),
		profiles: defaultProfiles(),
	};
}

/**
 * The `war-dogs.expect` block is supplied by the CALLER (tools/webfetch.ts
 * reads it through settings.ts, which mirrors pi's project-trust rule). This
 * library must not read settings files itself: it once scanned
 * `<cwd>/.pi/settings.json` unconditionally, so an UNTRUSTED project could
 * define a scout profile whose `cmd` this module then spawned (demonstrated
 * by probe). With no block, the defaults apply.
 */
function loadConfig(block: unknown): ScoutConfig {
	const s = block && typeof block === "object" ? (block as Record<string, any>) : null;
	const base = defaultConfig();
	if (!s) return base;
	return {
		...base,
		...s,
		profiles: { ...base.profiles, ...(s.profiles ?? {}) },
	};
}

function loadSystemPrompt(fetchCommand: string): string {
	const tplPath = new URL("./scout-system-prompt.md", import.meta.url);
	const tpl = fs.readFileSync(tplPath, "utf8");
	return tpl.replaceAll("{{FETCH_COMMAND}}", fetchCommand);
}

function buildUserPrompt(urls: string[], expect: string, mode: "check" | "extract"): string {
	return [`looking_for: ${expect}`, `mode: ${mode}`, "urls:", ...urls.map((u, i) => `${i + 1}. ${u}`)].join("\n");
}

/** Pull a JSON object out of model output, tolerating ```json fences and prose padding. */
function extractJson(text: string): any | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** pi --mode json emits JSONL events; the answer is the last assistant text block. */
function parsePiJsonl(stdout: string): string | null {
	let last: string | null = null;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if ((e.type === "message_end" || e.type === "turn_end") && e.message?.role === "assistant") {
				for (const c of e.message.content ?? []) {
					if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) last = c.text;
				}
			}
		} catch {}
	}
	return last;
}

/** claude -p --output-format json emits one JSON object with a "result" string. */
function parseClaudeJson(stdout: string): string | null {
	try {
		const d = JSON.parse(stdout);
		if (typeof d?.result === "string") return d.result;
	} catch {}
	return null;
}

export async function runScout(opts: {
	/** The `war-dogs.expect` settings block, resolved by the caller (see loadConfig). */
	settings?: unknown;
	urls: string[];
	expect: string;
	mode?: "check" | "extract";
	signal?: AbortSignal;
}): Promise<ScoutOutcome> {
	const started = Date.now();
	const cfg = loadConfig(opts.settings);
	const prof = cfg.profiles[cfg.profile];
	const configWarnings: string[] = [];
	let maxUrls = cfg.maxUrls;
	if (!Number.isFinite(maxUrls) || maxUrls < 1) {
		// A non-numeric maxUrls made `slice(0, maxUrls)` return NOTHING, and the
		// scout dutifully reported success with zero verdicts.
		configWarnings.push(`war-dogs.expect.maxUrls is ${JSON.stringify(cfg.maxUrls)} — not a positive number; using 10`);
		maxUrls = 10;
	}
	maxUrls = Math.floor(maxUrls);
	const skipped = opts.urls.slice(maxUrls);
	let timeoutMs = cfg.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
		// Same shape as maxUrls: a string (or 0) became a NaN/0 setTimeout that
		// killed the scout instantly and reported "timed out after NaNs".
		configWarnings.push(
			`war-dogs.expect.timeoutMs is ${JSON.stringify(cfg.timeoutMs)} — not a number of ms ≥ 1000; using 240000`,
		);
		timeoutMs = 240_000;
	}

	const fail = (error: string): ScoutOutcome => ({
		ok: false,
		profile: cfg.profile,
		results: [],
		extracts: [],
		skipped,
		configWarnings,
		error,
		durationMs: Date.now() - started,
	});

	if (!prof)
		return fail(
			`unknown scout profile "${cfg.profile}" (configured: ${Object.keys(cfg.profiles).join(", ") || "none"})`,
		);

	const urls = opts.urls.slice(0, maxUrls);
	const mode = opts.mode ?? "extract";
	const systemPrompt = loadSystemPrompt(cfg.fetchCommand);
	const userPrompt = buildUserPrompt(urls, opts.expect, mode);

	// Render the system prompt to a temp file (claude wants a path; pi wants a string).
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "war-dogs-scout-"));
	const sysFile = path.join(workDir, "system.md");
	fs.writeFileSync(sysFile, systemPrompt);

	const args = prof.args.map((a) =>
		a === "{{prompt}}"
			? userPrompt
			: a === "{{system_prompt}}"
				? systemPrompt
				: a === "{{system_prompt_file}}"
					? sysFile
					: a,
	);

	const env = { ...process.env, ...(prof.env ?? {}) };

	// If the profile did not ask for the prompt on the command line, it goes in
	// on stdin — argv is world-readable through `ps`.
	const promptOnStdin = !prof.args.includes("{{prompt}}");

	let stdout: string;
	try {
		stdout = await new Promise<string>((resolve, reject) => {
			const child = spawn(prof.cmd, args, { env, stdio: [promptOnStdin ? "pipe" : "ignore", "pipe", "pipe"] });
			if (promptOnStdin) {
				child.stdin?.on("error", () => {}); // the child may exit before we finish writing
				child.stdin?.end(userPrompt);
			}
			let out = "";
			let err = "";
			const killer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`scout timed out after ${timeoutMs / 1000}s`));
			}, timeoutMs);
			const onAbort = () => {
				child.kill("SIGKILL");
				reject(new Error("scout aborted"));
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", (e) => {
				clearTimeout(killer);
				reject(new Error(`failed to launch "${prof.cmd}": ${e.message}`));
			});
			child.on("close", (code) => {
				clearTimeout(killer);
				opts.signal?.removeEventListener("abort", onAbort);
				if (code === 0) resolve(out);
				else reject(new Error(`"${prof.cmd}" exited ${code}: ${err.slice(0, 300)}`));
			});
		});
	} catch (e: any) {
		return fail(e?.message ?? String(e));
	} finally {
		try {
			fs.rmSync(workDir, { recursive: true, force: true });
		} catch {}
	}

	const finalText =
		prof.output === "claude-json"
			? parseClaudeJson(stdout)
			: prof.output === "text"
				? stdout.trim()
				: parsePiJsonl(stdout);

	if (!finalText) return fail(`could not read the scout's answer from "${prof.cmd}" output`);

	const parsed = extractJson(finalText);
	if (!parsed || !Array.isArray(parsed.results)) {
		return fail(`the scout did not return the expected JSON (got ${finalText.length} chars of unparsable output)`);
	}

	return {
		ok: true,
		profile: cfg.profile,
		results: parsed.results.filter((r: any) => r && typeof r.url === "string"),
		extracts: Array.isArray(parsed.extracts) ? parsed.extracts.filter((x: any) => x && typeof x.url === "string") : [],
		skipped,
		configWarnings,
		durationMs: Date.now() - started,
	};
}
