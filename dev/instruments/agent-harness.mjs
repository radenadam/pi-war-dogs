#!/usr/bin/env node
// The agent tool driven IN-PROCESS, with exact timing — the instrument for
// interleavings the mock rig cannot script (a user-driven run-view turn, two
// waits on one run, a message landing in a turn's final moments). Everything
// war-dogs is loaded through pi's own jiti and wired the way index.ts wires
// it (child tool factory, skins, model registry, owner session); the MAIN
// conversation is a real pi AgentSession on the mock model, the tool is one
// of its custom tools, and deliveries go through a fake ExtensionAPI whose
// sendMessage is pi's own sendCustomMessage — so a delivery lands in main's
// transcript exactly as it does under pi. Ground truth is the transcripts.
//
//   node dev/instruments/mock-llm.mjs &                          (WORDS=60 INTERVAL=10 for speed)
//   PI_CODING_AGENT_DIR=/tmp/wd-agent-test/agent node dev/instruments/agent-harness.mjs <scenario> [args]
//
// Scenarios live in dev/instruments/agent-scenarios.mjs (one exported async function per
// name, receiving the harness handle below). `list` prints them.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WD = path.resolve(here, "..", "..");
const AG = process.env.PI_CODING_AGENT_DIR;
if (!AG) {
	console.error("PI_CODING_AGENT_DIR must name a private agent dir (never ~/.pi/agent)");
	process.exit(2);
}
const CWD = process.env.WD_CWD || "/tmp/wd-agent-cwd";
fs.mkdirSync(CWD, { recursive: true });
// Mirror production: pi's PROCESS cwd is the session cwd, and several child
// paths resolve process.cwd() (doRun's `cfg.cwd || process.cwd()`). Without
// this, children of a harness run worked in whatever directory the driver
// happened to run from (caught 2026-08-25, the doctrine A/B's first run).
process.chdir(CWD);
const PI = (() => {
	try {
		return (
			fs
				.realpathSync(execSync("which pi", { encoding: "utf8" }).trim())
				// 0.83 runs <pi>/dist/cli.js; 0.84.3's bin is the bundle, <pi>/dist/bundle/cli.js
				// (the 0.84.3 sweep: two dirname()s landed on <pi>/dist and jiti was not found).
				.replace(/[\\/]dist(?:[\\/]bundle)?[\\/]cli\.js$/, "")
		);
	} catch {
		return path.join(process.env.HOME ?? "", ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent");
	}
})();
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-tui": `${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
		"@earendil-works/pi-ai": `${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`,
		typebox: `${PI}/node_modules/typebox/build/index.mjs`,
	},
});
// piAiCompat() and the syntax palette locate pi from the running binary.
process.argv[1] = `${PI}/dist/cli.js`;

const pi = await jiti.import(`${PI}/dist/index.js`);
const smMod = await jiti.import(`${PI}/dist/core/session-manager.js`);
const A = await jiti.import(`${WD}/tools/agent.ts`);
const S = await jiti.import(`${WD}/agents/session.ts`);
const R = await jiti.import(`${WD}/agents/run.ts`);
const C = await jiti.import(`${WD}/agents/childtools.ts`);
const D = await jiti.import(`${WD}/tools/delivery.ts`);
const ST = await jiti.import(`${WD}/util/stamp.ts`);
const ASK = await jiti.import(`${WD}/agents/ask.ts`);
const BB = await jiti.import(`${WD}/tools/bash-background.ts`);
const I = await jiti.import(`${WD}/tools/interrupted.ts`);
const skins = {};
for (const t of ["read", "bash", "write", "edit"]) skins[t] = await jiti.import(`${WD}/tools/${t}.ts`);

// ---- wiring, mirrored from index.ts installOnce()/registerAgentTool() ----
C.setChildExtraToolsSource("skins", (childCwd) =>
	[
		skins.read.build(childCwd),
		skins.bash.build(childCwd, { child: true }),
		skins.write.build(childCwd),
		skins.edit.build(childCwd),
	].map((d) => ST.withStamp(d)),
);
S.setChildToolFactory((depth, parentId, owner) =>
	ST.withStamp(A.makeAgentTool({ inheritedDepth: depth, parentId, ownerSession: owner })),
);

const runtime = await pi.ModelRuntime.create({
	authPath: path.join(AG, "auth.json"),
	modelsPath: path.join(AG, "models.json"),
});
const modelRegistry = new pi.ModelRegistry(runtime);
S.setModelRegistry(modelRegistry);
// index.ts: a continued run reads its dead agents' notice ahead of its turn (tools/interrupted.ts).
S.setContinueNotice((id) => I.noticeForRun(id));
// index.ts: the powershell skin reaches a child only where powershell is the shell (2026-08-30).
const PS = await jiti.import(`${WD}/tools/powershell.ts`);
const VB = await jiti.import(`${WD}/visual/tools/bash.ts`);
C.setChildExtraToolsSource("powershell", (cwd) =>
	C.isShellPowershell() ? [ST.withStamp(PS.build(cwd, { child: true }))] : [],
);

const sessionsDir = smMod.getDefaultSessionDir(CWD, AG);
const sm = pi.SessionManager.create(CWD, sessionsDir);
const ownerSession = sm.getSessionId();

/** Every delivery the tool made, in order, plus what pi did with it. */
export const deliveries = [];
let main;
const fakePi = {
	sendMessage(message, options) {
		const rec = { t: Date.now(), customType: message.customType, options, text: textOf(message.content) };
		deliveries.push(rec);
		log(`DELIVERY ${message.customType} ${options?.deliverAs ?? ""}${options?.triggerTurn ? "+turn" : ""}:`);
		for (const l of rec.text.split("\n").slice(0, 16)) console.log(`         │ ${l.slice(0, 150)}`);
		main.sendCustomMessage(message, options).catch((e) => log(`sendCustomMessage threw: ${e?.message ?? e}`));
	},
};
const env = {
	parentId: null,
	get ownerSession() {
		return ownerSession;
	},
	get canDeliver() {
		return true;
	},
	pi: fakePi,
};
A.setSchemaEnums({ agents: [], models: ["mock"], tools: [] });
const tool = ST.withStamp(A.makeAgentTool(env));
// The doctrine SHIPPED 2026-08-25 (dev/internals/README.md, behind the A/B
// this switch ran). WD_DOCTRINE=strip removes it from the built description
// — the A/B instrument inverted, so future A/Bs can rebuild the stock
// variant. Anchors are exact shipped sentences; a drifted one fails loudly.
if (process.env.WD_DOCTRINE === "1") {
	throw new Error("the doctrine is shipped; use WD_DOCTRINE=strip to build the stock variant");
}
if (process.env.WD_DOCTRINE === "strip") {
	// Ordered: the write-collision clause first, so the paragraph-block
	// removal's anchor then matches.
	const strips = [
		[" Two agents writing the same file lose work; give concurrent agents disjoint files.", ""],
		[
			"\n\nMost work needs no agent. Reach for agents when the problem outgrows one context. It outgrows one context when the work forks into parts that do not inform each other; when a part is better done by a mind that does not share your assumptions, such as an adversary, a checker, or a specialist composed for the purpose; and when the work would outlast your own window. Keep on your own desk what your next step depends on. Give each agent its own part of the work, and do not redo it yourself. Let the problem's shape set their number, one until it must be more, and a structured team when the work is vast.\n\nYou do not know what a working agent is doing or thinking until you look. You have status to show where it stands, ask to question it mid-work, and the directory to show what it has done. While they work, do what does not depend on them. Treat its replies and its answers alike as claims; verify against what it leaves behind. Steer early, because a message costs a turn and drift costs the run.",
			"",
		],
		[
			" Beyond what its tools can reach, your words are all it has. Tell it what it is, what the work is, what you know that it cannot, and how its reply must look.",
			"",
		],
		[
			" An agent that has worked for you is worth more than a fresh one. Re-task it, and it carries all it has learned. Since you last wrote to it, this conversation and the directory have moved on without it. Bring it up to date.",
			"",
		],
		[" Write the system prompt as who the work needs it to be. Give it a stance and standing rules, not a résumé.", ""],
	];
	let d = tool.description;
	for (const [from, to] of strips) {
		if (!d.includes(from)) throw new Error(`strip anchor missing: "${from.slice(0, 50)}…"`);
		d = d.replace(from, to);
	}
	tool.description = d;
	console.log(`[harness] stock (stripped) variant: description ${tool.description.length} chars`);
}

// WD_DESC_STYLE=triple: the maintainer's last-attempt experiment (2026-08-25) —
// wrap the description in the Kimi docs' triple-quote typography and let the
// transcription probe show what actually reaches the model.
if (process.env.WD_DESC_STYLE === "triple") {
	tool.description = `"""\n${tool.description}\n"""`;
	console.log(`[harness] triple-quoted description: ${tool.description.length} chars`);
}

const loader = new pi.DefaultResourceLoader({
	cwd: CWD,
	agentDir: AG,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
});
await loader.reload();
const created = await pi.createAgentSession({
	cwd: CWD,
	agentDir: AG,
	modelRuntime: runtime,
	sessionManager: sm,
	resourceLoader: loader,
	customTools: [tool],
});
main = created.session;
R.setOwnerSession(ownerSession, sm.getSessionFile());
R.loadKnownRuns();

const ctx = {
	sessionManager: sm,
	modelRegistry,
	get model() {
		return main.model;
	},
	get thinkingLevel() {
		return main.thinkingLevel;
	},
	mode: "rpc",
	isProjectTrusted: () => false,
};

// ---- the handle a scenario receives ----
const t0 = Date.now();
export const log = (s) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(2)).padStart(6)}s] ${s}`);
export const textOf = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b?.type === "text")
				.map((b) => String(b.text ?? ""))
				.join("\n");
export const firstLine = (s) =>
	String(s ?? "")
		.split("\n")[0]
		.slice(0, 110);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let callN = 0;
/** One tool call, exactly as pi would make it; returns {text, error, details}. */
// WD_CALLS=<file>: every call and its FULL result as one JSON line — the
// agent-reference builder renders them (dev/reference/build-agent-reference.mjs), since
// main's transcript never shows what the harness itself called.
const CALLS = process.env.WD_CALLS || "";
function recordCall(rec) {
	if (!CALLS) return;
	try {
		fs.appendFileSync(CALLS, JSON.stringify({ t: Date.now(), ...rec }) + "\n");
	} catch {}
}
/** A text the scenario built itself (e.g. the session-end notice) — recorded for the reference page. */
export function note(label, text) {
	log(`NOTE ${label}: ${firstLine(text)}`);
	recordCall({ kind: "note", label, text });
}
export async function call(params, opts = {}) {
	const id = `call_${++callN}`;
	const ac = opts.controller ?? new AbortController();
	log(`CALL ${id} ${JSON.stringify(params).slice(0, 140)}`);
	try {
		const r = await tool.execute(id, params, ac.signal, opts.onUpdate, ctx);
		const text = textOf(r?.content);
		log(`RESULT ${id}: ${firstLine(text)}`);
		recordCall({ kind: "call", id, params, text, error: false });
		return { text, details: r?.details };
	} catch (e) {
		const msg = String(e?.message ?? e);
		log(`ERROR ${id}: ${firstLine(msg)}`);
		recordCall({ kind: "call", id, params, text: msg, error: true });
		return { text: msg, error: true };
	}
}
export const runIdOf = (res) => /\[agent id: (agent_[\w-]+)\]/.exec(res?.text ?? "")?.[1];
/** What the run view does on Enter (visual/pager/mod.ts): a user turn at a run, no delivery. */
export function userChat(runId, text) {
	log(`USERCHAT ${runId}: ${firstLine(text)}`);
	recordCall({ kind: "userchat", runId, text });
	// from the user, as the run view sends it (2026-08-29): a principal's
	// send ends an interrupt episode, a user's follow-up is what reports it.
	// The provenance line and the stamp are sendToRun's (2026-08-30).
	return S.promptRun(runId, text, undefined, { from: { kind: "user" } });
}
/** A turn of MAIN's own (the mock answers by keyword), e.g. "sleep 8" keeps main busy. */
export async function mainPrompt(text) {
	log(`MAIN PROMPT: ${text}`);
	await main.prompt(ST.appendStamp(text));
	log(`MAIN TURN DONE`);
}
export const rec = (runId) => R.registry.get(runId);
export const runOf = (runId) => R.knownRuns.get(runId);
export const state = (runId) => runOf(runId)?.status;
export async function untilState(runId, want, timeoutMs = 30_000) {
	const end = Date.now() + timeoutMs;
	const wants = Array.isArray(want) ? want : [want];
	while (!wants.includes(state(runId))) {
		if (Date.now() > end) throw new Error(`timeout waiting for ${runId} to be ${wants.join("|")} (is ${state(runId)})`);
		await sleep(25);
	}
}
export async function untilStreaming(runId, timeoutMs = 15_000) {
	const end = Date.now() + timeoutMs;
	while (!rec(runId)?.session?.isStreaming) {
		if (Date.now() > end) throw new Error(`timeout waiting for ${runId} to stream`);
		await sleep(15);
	}
}
/** Wait for the child's next tool_execution_start (the boundary a steer lands after). */
export function onceEvent(runId, type) {
	return new Promise((resolve) => {
		const un = rec(runId)?.session?.subscribe?.((ev) => {
			if (ev?.type === type) {
				un?.();
				resolve(ev);
			}
		});
	});
}
/** Transcript entries of a file: role/customType + first line, plus stop reasons. */
export function transcript(file) {
	const out = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type !== "message") {
			out.push({ type: e.type, role: e.customType ?? "", text: "" });
			continue;
		}
		const m = e.message;
		const kinds = Array.isArray(m.content)
			? m.content.map((b) =>
					b.type === "text"
						? "text"
						: b.type === "thinking"
							? `thinking(${b.thinking?.length ?? 0},sig=${b.thinkingSignature ? "y" : "n"})`
							: b.type === "toolCall"
								? `toolCall:${b.name}`
								: b.type,
				)
			: [typeof m.content];
		out.push({
			type: "message",
			role: m.role + (m.customType ? `/${m.customType}` : ""),
			kinds,
			stop: m.stopReason,
			err: m.errorMessage,
			text: firstLine(textOf(m.content)),
		});
	}
	return out;
}
export const mainFile = () => sm.getSessionFile();
export const childFile = (runId) => R.transcriptFor(runOf(runId));
export function dumpTranscript(label, file) {
	log(`--- transcript ${label}: ${file}`);
	if (!file || !fs.existsSync(file)) {
		console.log("    (no transcript file — the session never wrote a turn)");
		return;
	}
	for (const e of transcript(file)) {
		if (e.type !== "message") {
			console.log(`    <${e.type}${e.role ? ":" + e.role : ""}>`);
			continue;
		}
		console.log(
			`    ${e.role.padEnd(24)} ${(e.stop ?? "").padEnd(8)} ${e.kinds.join(",").padEnd(28)} ${e.text}${e.err ? `  ERR=${e.err}` : ""}`,
		);
	}
}
/**
 * The agent-result rows of MAIN's transcript. pi buffers a session until its
 * first ASSISTANT message (session-manager.js _persist, identical 0.83 to
 * 0.84.3), so a fresh main whose only traffic is a delivery has NO file until
 * the delivery turn's reply lands — wait for it, bounded (the 0.84.3 sweep:
 * flushrace read at 0.63 s, the file appeared at ~2 s).
 */
export async function agentResultsInMain(waitMs = 8000) {
	const file = mainFile();
	const t0 = Date.now();
	while (!fs.existsSync(file) && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 100));
	return transcript(file).filter((e) => /agent-result|background-results/.test(e.role));
}
export async function shutdown() {
	// index.ts session_shutdown: flush the delivery window, abort runs, settle.
	D.flushDeliveries();
	for (const r of R.registry.values()) {
		if (r.run.status === "working" || r.run.status === "queued") {
			try {
				r.controller.abort();
			} catch {}
			try {
				await r.session?.abort?.();
			} catch {}
			R.settle(r, "stopped", "stopped by the session ending (/new)");
		}
	}
	D.clearDeliveries();
}
export const mods = { A, S, R, C, D, ST, ASK, BB, I, PS, VB, pi };
export const handle = {
	call,
	runIdOf,
	firstLine,
	textOf,
	userChat,
	mainPrompt,
	rec,
	runOf,
	state,
	untilState,
	untilStreaming,
	onceEvent,
	transcript,
	mainFile,
	childFile,
	dumpTranscript,
	agentResultsInMain,
	deliveries,
	log,
	sleep,
	shutdown,
	note,
	/** The ExtensionContext the harness hands the tool (a scenario may call another skin's execute with it). */
	ctx: () => ctx,
	mods,
	main: () => main,
	ownerSession,
};

const scenarios = await import(`${WD}/dev/instruments/agent-scenarios.mjs`);
const name = process.argv[2] ?? "list";
if (name === "list" || !scenarios[name]) {
	console.log(Object.keys(scenarios).join("\n"));
	process.exit(name === "list" ? 0 : 2);
}
log(`scenario ${name}; main session ${ownerSession}; model ${main.model?.id}`);
try {
	await scenarios[name](handle, process.argv.slice(3));
} catch (e) {
	log(`SCENARIO THREW: ${e?.stack ?? e}`);
	process.exitCode = 1;
}
// Let the last deliveries' main turns finish before reading transcripts.
await sleep(Number(process.env.SETTLE_MS ?? 2500));
log(`deliveries: ${deliveries.length}`);
dumpTranscript("main", mainFile());
try {
	main.dispose();
} catch {}
process.exit(process.exitCode ?? 0);
