#!/usr/bin/env node
// Builds dev/reference/agent-tool.html — the agent tool's reference,
// the way the maintainer reads it: (0) the base system prompt, (1) the
// description, (2) the parameters, (3) every text the tool returns, each
// with main beside child where they differ, then what else a reader must
// know. VERBATIM: the prompts, the descriptions and the schemas are read
// off the first request main and a child sent to the mock; the texts are
// collected from the transcripts of real runs (dev/instruments/agent-harness.mjs
// scenarios) and, for the sentences no scenario reaches, from the source
// templates (marked "from the source"). The runs themselves are an appendix.
//
//   node dev/reference/build-agent-reference.mjs            # every scenario (a few minutes)
//   node dev/reference/build-agent-reference.mjs smoke stops # a subset, for a quick look
//
// Needs: node >= 22.19, pi on PATH, a free port (18931). No real model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const OUT = path.join(ROOT, "dev/reference/agent-tool.html");
const PORT = Number(process.env.PORT || 18931);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PRE_CAP = 20_000;
const cap = (t) =>
	t.length <= PRE_CAP
		? t
		: `${t.slice(0, PRE_CAP)}\n\n[cut here for the page: ${PRE_CAP} of ${t.length} characters shown; the transcript on disk holds it whole]`;

const SCENARIOS = [
	["smoke", "run, the receipt, the reply delivered to main as its own turn"],
	["usersteer", "the user chats with a run from its view; the model's message joins that turn as a steer"],
	["queuedmsg", "a message to a run still queued behind the concurrency cap"],
	["leadrule", "a lead whose worker still works: status says it waits; one delivery when the team is idle"],
	["leadsteer", "a worker's reply lands while its lead streams: a steer read at the next tool boundary"],
	["stops", "the tool's stop from main: the stopped run's abort text, the receipt, the delivery"],
	["userstop", "the station's ✕ on a lead mid-wait: the wait, the worker's abort, main's delivery"],
	["idlekeys", "the keys on an idle lead whose worker still runs"],
	["interruptflow", "Esc in a run's view, then the user's follow-up"],
	["leadinterrupt", "Esc on a lead mid-wait, its worker finishing meanwhile"],
	["leadaltx", "alt+x on a lead: its team stopped, the reports parked"],
	["leadsessionend", "the session ends under a lead and its worker; the continued lead is told"],
	["bgsessionend", "a background bash job killed by the session end"],
	["timers", "a per-turn timeout on a queued run"],
	["reachself", "a child that waits on itself is refused"],
	["hygiene", "a named agent naming war-dogs as an extension; only the child append file rides"],
	["claims3", "two waits on one run, one interrupted"],
	["bigreply", "a reply over the 200k cap"],
	["batchline", "the batch line's four shapes"],
	["shellps", "the powershell skin: a child's set beside bash and as the shell"],
	[
		"provenance",
		"the provenance line's forms: main owning a turn, the user's own turn, main steering the user's turn, the user steering main's",
	],
];
const only = process.argv.slice(2);
const run = only.length ? SCENARIOS.filter(([n]) => only.includes(n)) : SCENARIOS;

// ---------------- rig ----------------
function portFree(p) {
	return new Promise((res) => {
		const s = net.createServer();
		s.once("error", () => res(false));
		s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
	});
}
const RIGS = [];
function rig(name, opts = {}) {
	const R = fs.mkdtempSync(path.join(os.tmpdir(), `wd-ref-${name}-`));
	const AG = path.join(R, "agent");
	fs.mkdirSync(path.join(AG, "extensions"), { recursive: true });
	fs.symlinkSync(ROOT, path.join(AG, "extensions", "war-dogs"));
	fs.writeFileSync(path.join(AG, "auth.json"), "{}");
	fs.writeFileSync(
		path.join(AG, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${PORT}/v1`,
					api: "openai-completions",
					apiKey: "x",
					models: [
						{
							id: "mock",
							name: "Mock",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		}),
	);
	const settings = { defaultProvider: "mock", defaultModel: "mock", "war-dogs": { enabled: true } };
	if (opts.concurrency) settings.agent = { concurrency: opts.concurrency };
	fs.writeFileSync(path.join(AG, "settings.json"), JSON.stringify(settings));
	if (opts.hygiene) {
		fs.mkdirSync(path.join(AG, "subagents"), { recursive: true });
		fs.writeFileSync(
			path.join(AG, "subagents", "wd.md"),
			'---\ndescription: probe\nextensions: ["war-dogs"]\n---\nYou are a probe agent. Answer briefly.\n',
		);
		fs.writeFileSync(path.join(AG, "APPEND_SYSTEM.md"), "MAIN-APPEND-MARK\n");
		fs.writeFileSync(path.join(AG, "SUBAGENT_APPEND_SYSTEM.md"), "CHILD-APPEND-MARK\n");
	}
	const CWD = path.join(R, "cwd");
	fs.mkdirSync(CWD);
	RIGS.push({ R, AG, CWD });
	return { R, AG, CWD };
}
async function withMock(dump, words, interval, fn) {
	if (!(await portFree(PORT))) throw new Error(`port ${PORT} busy — a stray mock? kill it by pid`);
	const mock = spawn("node", [path.join(ROOT, "dev/instruments/mock-llm.mjs")], {
		env: { ...process.env, PORT: String(PORT), WORDS: String(words), INTERVAL: String(interval), DUMP: dump },
		stdio: ["ignore", "ignore", "ignore"],
	});
	for (let i = 0; i < 50 && (await portFree(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
	try {
		return await fn();
	} finally {
		mock.kill("SIGTERM");
		await new Promise((r) => mock.once("exit", r));
	}
}
function jsonl(file) {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}
function collect(AG) {
	const files = fs.existsSync(path.join(AG, "sessions")) ? walk(path.join(AG, "sessions")) : [];
	const mains = files.filter((f) => f.endsWith(".jsonl") && !f.includes("/subagents/"));
	const runs = files
		.filter((f) => f.endsWith("run.json"))
		.map((f) => {
			const run = JSON.parse(fs.readFileSync(f, "utf8"));
			const dir = path.dirname(f);
			const tr = fs.readdirSync(dir).find((n) => n.endsWith(".jsonl"));
			return { run, entries: tr ? jsonl(path.join(dir, tr)) : [] };
		})
		.sort((a, b) => a.run.startedAt - b.run.startedAt);
	return { mains: mains.map((f) => jsonl(f)), runs };
}
const textOf = (c) =>
	typeof c === "string"
		? c
		: (c ?? [])
				.filter((b) => b?.type === "text")
				.map((b) => b.text)
				.join("\n");
// The system prompt on the wire: a `system` field, or the first message with
// role system (or developer — pi-ai's openai-completions shape for a
// reasoning model, which the mock is).
const sysOf = (b) => {
	const s =
		typeof b.system === "string"
			? b.system
			: (b.messages?.find((m) => m.role === "system" || m.role === "developer")?.content ?? "");
	return typeof s === "string" ? s : textOf(s);
};
const reqKind = (b) => (/<agent-exchange>/.test(sysOf(b)) ? "child" : "main");
const agentToolOf = (b) => (b.tools ?? []).map((t) => t.function ?? t).find((t) => t?.name === "agent");

// ---------------- the texts: collected by category, with reader and situation ----------------
// Each category: [name, head regex, one line on when it is read].
const CATEGORIES = [
	["run: the receipt", /^(Started "|Queued ")/, "the result of a run call"],
	[
		"run: refused",
		/^(run needs |Unknown agent|Ambiguous run id|note: (?:extension|unknown|model))/,
		"a run call that could not start, or started with a note",
	],
	["message: the receipt", /^Delivered to /, "the result of a message call"],
	[
		"ask",
		/^(Ask aborted|.* was not asked)/,
		"the result of an ask call when it did not complete (a completed ask returns the agent's answer)",
	],
	[
		"wait",
		/^(Wait aborted|Agent "[^"]*" \([^)]*\) (?:finished|was stopped|timed out|errored|was interrupted)[^:]*(?:\(earlier\))?:)/,
		"one section per id in a wait's result",
	],
	[
		"status",
		/^(Agent [^"(]+ \(agent_[^)]+\): |This session |\(no working agents\)|last tools:|reply so far:)/,
		"a status call, one section per agent; bare status leads with the session's own window",
	],
	[
		"stop",
		/^(Stopped |.* was already |.* is owned by another pi process|.* is a session with its own user|stop needs |wait needs )/,
		"the result of a stop call",
	],
	["list", /^(Your agents:|Peers:|\(no agents\)|agent_\S+ · |session_\S+ · )/, "the result of a list call"],
	[
		"reach and self",
		/^(agent_\S+ is you\.|agent_\S+ started you|.* is outside your reach|Your session's main agent is outside)/,
		"a refusal a child gets when it targets itself, its principal, or an agent outside its reach",
	],
	[
		"delivery: an agent's reply",
		/^(\[agent result|Agent "[^"]*" \([^)]*\) (?:finished in|was stopped by|timed out after|errored after|was interrupted by)[^:]*:)/,
		"the message that carries an agent's reply to whoever started it: the provenance line, the sentence, the body, the notes, the trailer",
	],
	[
		"delivery: a batch",
		/^\[background results, /,
		"several results finishing inside one window, stacked under one line",
	],
	[
		"delivery: a background job",
		/^(\[background (?:bash|powershell) result|Background (?:bash|powershell) ")/,
		"a background bash or powershell job's output, delivered when it exits, or the notice when the session killed it",
	],
	[
		"notes on a reply",
		/^(\[the user |note: |\(stopped by |\(interrupted by |\(timed out |\(cut off |\[reply truncated|\[section truncated)/,
		"lines added to a reply or a delivery when they are true",
	],
	["the trailer", /^(\[agent stats: |\[agent id: |\[run id: )/, "the last lines of every reply, receipt and delivery"],
	[
		"the sender line",
		/^(\[from |\[message from )/,
		"the first line of every message after the task, naming its sender",
	],
	["aborts", /^(Command aborted|Fetch aborted|Search aborted)/, "a tool call cut mid-flight, with who cut it"],
	["a session end", /^(Its work up to then|Its output was not delivered)/, "the body under a session-end notice"],
];
const HEADS = new RegExp(CATEGORIES.map(([, re]) => re.source).join("|"));
function mask(line) {
	return line
		.replace(/agent_[A-Za-z0-9_-]{12}/g, "agent_…")
		.replace(/bash_[A-Za-z0-9_-]{12}/g, "bash_…")
		.replace(/session_[0-9a-f-]{36}/g, "session_…")
		.replace(/\d+m \d+s|\d+h \d+m|\d+(\.\d+)?s\b/g, "Ns")
		.replace(/\d+(\.\d+)?k\b/g, "Nk")
		.replace(/\d+(\.\d+)?%/g, "N%")
		.replace(/\[timestamp: [^\]]+\]/g, "[timestamp: …]")
		.replace(/\/tmp\/[^\s)]+/g, "/tmp/…")
		.replace(/"[^"]{1,40}" \((adhoc|[a-z-]+)\)/g, '"<title>" ($1)')
		.replace(/\b\d+\b/g, "N");
}
/** masked line -> { example, readers:Set(main|child), scenarios:Set } */
const seen = new Map();
function note(line, reader, scenario) {
	const l = line.trim();
	if (!l || !HEADS.test(l)) return;
	const key = mask(l);
	const hit = seen.get(key) ?? { example: l, readers: new Set(), scenarios: new Set() };
	hit.readers.add(reader);
	hit.scenarios.add(scenario);
	seen.set(key, hit);
}
function harvest(scenario, entries, reader) {
	for (const e of entries) {
		const texts = [];
		if (e.type === "custom_message") texts.push(textOf(e.content));
		else if (e.type === "message") {
			const m = e.message;
			if (m.role === "toolResult" && /^(agent|bash|powershell|webfetch|kimi-websearch)$/.test(m.toolName ?? ""))
				texts.push(textOf(m.content));
			if (m.role === "user" || m.role === "custom") texts.push(textOf(m.content));
		}
		for (const t of texts) for (const line of t.split("\n")) note(line, reader, scenario);
	}
}
function harvestCalls(scenario, calls) {
	for (const c of calls) {
		if (c.kind === "call" || c.kind === "note")
			for (const line of String(c.text).split("\n")) note(line, "main", scenario);
	}
}
// The sentences no scenario reaches, from the source: template and string
// literals whose first characters match a category head. Marked as such.
function sourceTexts() {
	const out = new Map();
	for (const f of [
		"tools/agent.ts",
		"tools/interrupted.ts",
		"tools/bash-background.ts",
		"tools/webfetch.ts",
		"tools/websearch.ts",
		"agents/peers.ts",
		"agents/run.ts",
	]) {
		const src = fs.readFileSync(path.join(ROOT, f), "utf8");
		for (const m of src.matchAll(/`((?:\\`|[^`])*)`|"((?:\\"|[^"\n])*)"/g)) {
			const raw = (m[1] ?? m[2] ?? "").replace(/\\n/g, "\n").replace(/\\`/g, "`").replace(/\\"/g, '"');
			for (const line of raw.split("\n")) {
				const l = line.trim();
				if (!l || !HEADS.test(l)) continue;
				if (!out.has(l)) out.set(l, f);
			}
		}
	}
	return out;
}

// ---------------- render helpers ----------------
const pre = (t, cls = "") => `<pre class="${cls}">${esc(cap(t))}</pre>`;
function sentences(s) {
	return s.split(/(?<=\.)\s+(?=[A-Z\[])/);
}
function diffDesc(a, b) {
	// Paragraph breaks kept (the description is paragraphs of sentences; the
	// .desc box is pre-wrap), sentences compared within them.
	const paras = (s) => s.split(/\n\n+/);
	const A = paras(a)
		.flatMap((p) => [...sentences(p), "\n\n"])
		.slice(0, -1);
	const B = paras(b)
		.flatMap((p) => [...sentences(p), "\n\n"])
		.slice(0, -1);
	const inB = new Set(B),
		inA = new Set(A);
	const render = (xs, other, cls) =>
		xs
			.map((x) => (x === "\n\n" ? "\n\n" : other.has(x) ? esc(x) : `<mark class="${cls}">${esc(x)}</mark>`))
			.join(" ")
			.replace(/ \n\n /g, "\n\n");
	return { left: render(A, inB, "a"), right: render(B, inA, "b") };
}
function paramRows(tool) {
	const props = tool?.parameters?.properties ?? tool?.input_schema?.properties ?? {};
	return Object.entries(props).map(([k, v]) => {
		const type = v.enum
			? `enum: ${v.enum.join(" · ")}`
			: v.type === "array"
				? `array of ${v.items?.enum ? "enum" : (v.items?.type ?? "")}`
				: (v.type ?? (v.anyOf ? "anyOf" : ""));
		return [k, type, v.description ?? ""];
	});
}
function paramTable(main, child) {
	const M = new Map(paramRows(main).map((r) => [r[0], r]));
	const C = new Map(paramRows(child).map((r) => [r[0], r]));
	const keys = [...new Set([...M.keys(), ...C.keys()])];
	const rows = keys.map((k) => {
		const m = M.get(k),
			c = C.get(k);
		const same = m && c && m[1] === c[1] && m[2] === c[2];
		const cell = (r, cls) =>
			r
				? `<td class="${cls}"><div class="type">${esc(r[1])}</div>${esc(r[2])}</td>`
				: `<td class="${cls} none">not in this reader's schema</td>`;
		return `<tr class="${same ? "same" : "differs"}"><td><code>${esc(k)}</code></td>${same ? `<td colspan="2"><div class="type">${esc(m[1])}</div>${esc(m[2])}</td>` : cell(m, "a") + cell(c, "b")}</tr>`;
	});
	return `<table><tr><th>parameter</th><th>main</th><th>child</th></tr>${rows.join("")}</table>`;
}
function renderEntry(e) {
	if (e.type === "custom_message")
		return `<div class="msg"><div class="who">custom message · ${esc(e.customType)}</div>${pre(textOf(e.content))}</div>`;
	if (e.type !== "message") return "";
	const m = e.message;
	if (m.role === "user") return `<div class="msg"><div class="who">user</div>${pre(textOf(m.content))}</div>`;
	if (m.role === "custom")
		return `<div class="msg"><div class="who">custom · ${esc(m.customType ?? "")}</div>${pre(textOf(m.content))}</div>`;
	if (m.role === "toolResult")
		return `<div class="msg"><div class="who">tool result · ${esc(m.toolName)}${m.isError ? " · error" : ""}</div>${pre(textOf(m.content))}</div>`;
	if (m.role === "assistant") {
		const parts = [];
		for (const b of m.content ?? []) {
			if (b.type === "thinking") parts.push(pre(b.thinking ?? "", "dim"));
			else if (b.type === "text") parts.push(pre(b.text));
			else if (b.type === "toolCall") parts.push(pre(`→ ${b.name} ${JSON.stringify(b.arguments, null, 2)}`, "dim"));
		}
		const stop =
			m.stopReason && m.stopReason !== "stop"
				? ` · ${esc(m.stopReason)}${m.errorMessage ? ` ${esc(m.errorMessage)}` : ""}`
				: "";
		return `<div class="msg"><div class="who">assistant${stop}</div>${parts.join("")}</div>`;
	}
	return "";
}

// ---------------- build ----------------
const appendix = [];
let firstMain = null,
	firstChild = null;
for (const [name, what] of run) {
	process.stdout.write(`── ${name} `);
	const r = rig(name, { concurrency: name === "timers" ? 1 : undefined, hygiene: name === "hygiene" });
	const dump = path.join(r.R, "dump.jsonl");
	const calls = path.join(r.R, "calls.jsonl");
	const extra = name === "flushrace" ? { WAR_DOGS_DELIVERY_WINDOW_MS: "8000" } : {};
	const log = await withMock(dump, name === "bigreply" ? 40000 : 60, name === "bigreply" ? 0 : 10, async () => {
		const p = spawnSync("node", [path.join(ROOT, "dev/instruments/agent-harness.mjs"), name], {
			env: { ...process.env, ...extra, PI_CODING_AGENT_DIR: r.AG, WD_CWD: r.CWD, SETTLE_MS: "1500", WD_CALLS: calls },
			encoding: "utf8",
			timeout: 240_000,
		});
		return (p.stdout ?? "") + (p.stderr ?? "");
	});
	const { mains, runs } = collect(r.AG);
	const reqs = fs.existsSync(dump) ? jsonl(dump) : [];
	const madeCalls = fs.existsSync(calls) ? jsonl(calls) : [];
	for (const b of reqs) {
		const k = reqKind(b.body);
		if (k === "main" && !firstMain && agentToolOf(b.body)) firstMain = b.body;
		if (k === "child" && !firstChild && agentToolOf(b.body)) firstChild = b.body;
	}
	for (const m of mains) harvest(name, m, "main");
	for (const c of runs) harvest(name, c.entries, "child");
	harvestCalls(name, madeCalls);
	const threw = /SCENARIO THREW/.test(log);
	const parts = [
		`<h3 id="s-${name}">${esc(name)}${threw ? " (the scenario threw)" : ""}</h3><p class="what">${esc(what)}</p>`,
	];
	if (madeCalls.length)
		parts.push(
			`<details><summary>what main did (the harness in main's chair, ${madeCalls.length} steps)</summary>${madeCalls
				.map((c) =>
					c.kind === "note"
						? `<div class="msg"><div class="who">${esc(c.label)}</div>${pre(c.text)}</div>`
						: c.kind === "userchat"
							? `<div class="msg"><div class="who">the user types at ${esc(c.runId)}</div>${pre(c.text)}</div>`
							: `<div class="msg"><div class="who">main calls agent · ${esc(c.id)}</div>${pre(`→ agent ${JSON.stringify(c.params, null, 2)}`, "dim")}</div><div class="msg"><div class="who">tool result · agent${c.error ? " · error" : ""}</div>${pre(c.text)}</div>`,
				)
				.join("")}</details>`,
		);
	mains.forEach((m, i) =>
		parts.push(
			`<details><summary>main's transcript${mains.length > 1 ? ` (session ${i + 1})` : ""}</summary>${m.map(renderEntry).join("")}</details>`,
		),
	);
	for (const c of runs)
		parts.push(
			`<details><summary>agent "${esc(c.run.title)}" (${esc(c.run.agent)}) · ${esc(c.run.id)} · ${esc(c.run.status)}${c.run.error ? ` · ${esc(c.run.error)}` : ""}${c.run.parentId ? ` · started by ${esc(c.run.parentId)}` : " · started by main"}</summary>${c.entries.map(renderEntry).join("")}</details>`,
		);
	appendix.push(parts.join("\n"));
	console.log(threw ? "THREW" : `ok (${mains.length} main, ${runs.length} agents, ${reqs.length} requests)`);
	fs.rmSync(r.R, { recursive: true, force: true });
}

// MAIN as a real boot sees it: the harness builds main straight from pi's
// SDK, so its system prompt is pi's stock one and its agent tool the
// harness's; a real `pi -p` from a rig dir goes through installOnce and the
// prompt hook, which is what the maintainer's main gets.
process.stdout.write("── main, from a real pi boot ");
{
	const r = rig("realmain");
	const dump = path.join(r.R, "dump.jsonl");
	await withMock(dump, 3, 1, async () => {
		spawnSync("pi", ["-p", "hello"], {
			cwd: r.CWD,
			env: { ...process.env, PI_CODING_AGENT_DIR: r.AG },
			encoding: "utf8",
			timeout: 120_000,
			stdio: ["ignore", "ignore", "ignore"],
		});
	});
	const reqs = fs.existsSync(dump) ? jsonl(dump) : [];
	const real = reqs.map((x) => x.body).find((b) => agentToolOf(b));
	if (real) {
		firstMain = real;
		console.log("ok");
	} else console.log("MISSING (the harness's main stands in)");
	fs.rmSync(r.R, { recursive: true, force: true });
}

const mainTool = firstMain ? agentToolOf(firstMain) : null;
const childTool = firstChild ? agentToolOf(firstChild) : null;
const mainSys = firstMain ? sysOf(firstMain) : "(no main request captured)";
const childSys = firstChild ? sysOf(firstChild) : "(no child request captured)";
const exchange = (/<agent-exchange>[\s\S]*?<\/agent-exchange>/.exec(childSys) ?? [""])[0];
const childBaseOnly = childSys.replace(exchange, "").trim();
const mainBaseOnly = mainSys.trim();
const d = mainTool && childTool ? diffDesc(mainTool.description, childTool.description) : null;

// section 3
const src = sourceTexts();
const seenMasks = [...seen.keys()];
const catBlocks = CATEGORIES.map(([cat, re, when]) => {
	const fromRuns = [...seen.entries()].filter(([, v]) => re.test(v.example));
	const fromSource = [...src.entries()].filter(
		([l]) => re.test(l) && !seenMasks.includes(mask(l)) && !fromRuns.some(([, v]) => mask(v.example) === mask(l)),
	);
	if (!fromRuns.length && !fromSource.length) return "";
	const rows = fromRuns
		.sort((a, b) => a[1].example.localeCompare(b[1].example))
		.map(([, v]) => {
			const readers = [...v.readers].sort().join(" and ");
			return `<tr><td>${pre(v.example)}</td><td class="meta">read by ${readers}<br>${[...v.scenarios].map((s) => `<a href="#s-${s}">${s}</a>`).join(" ")}</td></tr>`;
		});
	const srows = fromSource
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(
			([l, f]) =>
				`<tr class="src"><td>${pre(l)}</td><td class="meta">from the source (${esc(f)}); no scenario reaches it</td></tr>`,
		);
	return `<h3>${esc(cat)}</h3><p class="what">${esc(when)}</p><table class="texts">${rows.join("")}${srows.join("")}</table>`;
}).join("\n");

const toc = `<nav>
<a href="#s0">0 · the base system prompt</a>
<a href="#s1">1 · the description</a>
<a href="#s2">2 · the parameters</a>
<a href="#s3">3 · every text the tool returns</a>
${CATEGORIES.map(([c]) => `<a class="sub" href="#c-${c.replace(/[^a-z]+/gi, "-")}">${esc(c)}</a>`).join("")}
<a href="#s4">4 · other things to know</a>
<a href="#s5">appendix · the runs</a>
</nav>`;

const html = `<!doctype html><meta charset="utf-8"><title>war-dogs · the agent tool</title>
<style>
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#ddd;background:#111}
nav{position:fixed;left:0;top:0;bottom:0;width:250px;overflow:auto;padding:16px;background:#161616;border-right:1px solid #2a2a2a}
nav a{display:block;color:#bcd;text-decoration:none;padding:4px 0}nav a.sub{padding-left:14px;color:#9ab;font-size:13px}
main{margin-left:280px;padding:24px 48px;max-width:1080px}
h1{font-size:22px;font-weight:600}h2{font-size:19px;margin-top:48px;border-bottom:1px solid #2a2a2a;padding-bottom:6px}h3{font-size:16px;margin-top:30px;color:#eee}
p.what{color:#9a9a9a;margin:4px 0 12px}
pre{white-space:pre-wrap;word-break:break-word;background:#181818;border:1px solid #262626;padding:10px 12px;margin:6px 0 10px;font:14px/1.5 ui-monospace,monospace;color:#e6e6e6}
pre.dim{color:#8a8a8a}
.msg{margin:8px 0 12px}.who{font-size:13px;color:#9a9a9a}
table{border-collapse:collapse;margin:8px 0;width:100%}td,th{border:1px solid #2a2a2a;padding:8px 10px;vertical-align:top;text-align:left;font-size:14px}th{color:#bbb;font-weight:600}
td.meta{color:#9a9a9a;font-size:13px;width:220px}td.meta a{color:#bcd;text-decoration:none;margin-right:6px}
table.texts td pre{margin:0}
tr.differs td.a{background:#1d1a14}tr.differs td.b{background:#141a1d}td.none{color:#777;font-style:italic}.type{color:#9a9a9a;font-size:12.5px;margin-bottom:2px}
mark.a{background:#3a2a12;color:#f3d9a8}mark.b{background:#12303a;color:#a8def3}
.desc{background:#181818;border:1px solid #262626;padding:12px;white-space:pre-wrap;font:14px/1.6 ui-monospace,monospace}
details{margin:8px 0}summary{cursor:pointer;color:#bcd}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.two h4{margin:8px 0 4px;color:#bbb;font-weight:600}
tr.src td{opacity:.85}
</style>
${toc}
<main>
<h1>war-dogs · the agent tool</h1>
<p class="what">Built ${new Date().toISOString().slice(0, 16).replace("T", " ")}. Every prompt, description, schema and returned text below is verbatim: read off the requests the mock received and the transcripts real runs wrote. Where main and a child differ, both are shown and the difference is marked. Sentences no run reached come from the source, marked as such.</p>

<h2 id="s0">0 · the base system prompt</h2>
<p class="what">What each reader is given as its system prompt, from the first request each sent: main from a real pi boot with war-dogs on (its base as pi assembles it; the session brief rides the first turn as a message, not here), a child from the runs (the child base, then the &lt;agent-exchange&gt; block, then SUBAGENT_APPEND_SYSTEM.md when one exists). The block is shown apart, since it is the whole of the difference once the child base is main's.</p>
<div class="two"><div><h4>main</h4>${pre(mainBaseOnly)}</div><div><h4>child (the block below removed)</h4>${pre(childBaseOnly)}</div></div>
<h3>the &lt;agent-exchange&gt; block (child only)</h3>${pre(exchange || "(none captured)")}

<h2 id="s1">1 · the description</h2>
<p class="what">The tool's description in the request's tool list. Sentences only in one reader's text are marked: <mark class="a">main only</mark>, <mark class="b">child only</mark>.</p>
<div class="two"><div><h4>main</h4><div class="desc">${d ? d.left : esc(mainTool?.description ?? "(none)")}</div></div><div><h4>child</h4><div class="desc">${d ? d.right : esc(childTool?.description ?? "(none)")}</div></div></div>

<h2 id="s2">2 · the parameters</h2>
<p class="what">The JSON schema's properties and their descriptions, main beside child; a row is merged when both readers get the same words, split and tinted when they differ.</p>
${paramTable(mainTool, childTool)}
<p class="what">Every tool main is given: <code>${(firstMain?.tools ?? []).map((t) => esc((t.function ?? t).name)).join("</code>, <code>")}</code>. Every tool a child is given: <code>${(firstChild?.tools ?? []).map((t) => esc((t.function ?? t).name)).join("</code>, <code>")}</code>.</p>

<h2 id="s3">3 · every text the tool returns</h2>
<p class="what">Grouped by what produced it. Each row is one distinct sentence shape (ids, numbers, titles and stamps masked for the grouping; the example is verbatim), with who read it and the run it was read in. Where main and a child are told a thing differently, both rows are here (a wait's "arrives with the next user prompt" for main, "is read at your next turn" for a child; a stop's "by you" for the stopper, "by the agent that started it" for the stopped).</p>
${catBlocks.replace(/<h3>([^<]*)<\/h3>/g, (m, c) => `<h3 id="c-${c.replace(/[^a-z]+/gi, "-")}">${c}</h3>`)}

<h2 id="s4">4 · other things to know</h2>
<ul>
<li><b>A reply is delivered, never returned.</b> run and message return a receipt at once; the reply arrives later as a message of its own: to main as a user-role message when main is idle (so pi's prompt hook runs), as a steering message when main is mid-turn, parked until the next prompt after the user's Esc; to the agent that started the run the same way. Several finishing within 1.5 s arrive as one batch.</li>
<li><b>The lead rule.</b> A run's reply leaves only when its turn ends and none of the agents it started is still working; meanwhile status says "waiting on N agents of its own" and their replies wake it.</li>
<li><b>Reach.</b> message, wait and stop reach the agents the caller started (reach: team, the default) or every agent of the session and its main agent (reach: session, never wider than the granter's); ask, status and list reach everyone; a child never targets itself or its principal.</li>
<li><b>The user's hand.</b> Esc in a run's view interrupts the turn: the run stays idle, its principal is not told, the user's follow-up becomes the reply, ten minutes without one brings a transparency notice. alt+x also stops its team. ctrl+alt+x and the station's ✕ stop the run and report at once. Every abort names who.</li>
<li><b>A session end</b> (/reload, /new, quit, a crash) stops every working run and background job with the reason; main is told once at the next start of that session, a continued lead ahead of its next turn.</li>
<li><b>Stamps and provenance.</b> Every result, receipt, delivery and prompt ends with a [timestamp: …] line (the model's clock; the screen hides it); every message after a child's task opens with its sender; a delivery's first line says what it is. The screen shows none of these; ctrl+click shows the wire.</li>
<li><b>Caps.</b> A reply over 200k characters is cut and saved to a file the note names; a batch is capped as a whole; status shows the first ~600 characters of the latest output.</li>
<li><b>What a child gets.</b> The parent's model and thinking level, the four skins (read, bash or powershell, edit, write) in their child form, webfetch, the search, the MCP tools main has, and the agent tool while depth remains; no skills, no prompt templates, no extensions; the project's context files. SUBAGENT_SYSTEM.md and SUBAGENT_APPEND_SYSTEM.md are the user's child-side files; SYSTEM.md and APPEND_SYSTEM.md are main's.</li>
<li><b>Peers.</b> Other pi sessions on this machine appear in list as session_…; message delivers into their conversation, ask is answered by their own model; stop is refused.</li>
</ul>

<h2 id="s5">appendix · the runs</h2>
<p class="what">The evidence: each scenario's steps and transcripts, collapsed. Open one when a row above needs its context.</p>
${appendix.join("\n")}
</main>`;
// GENERIC PATHS ONLY: the captured requests carry this machine's real paths
// (each rig's temp agent dir and cwd, and the war-dogs dir in the main boot's
// skills-block location). Substitute them to the doctrine's own placeholders,
// HTML-escaped so they display as <cwd> etc., longest first so a nested path
// wins over its parent (2026-08-30, the release cleanup).
const subs = [];
for (const { R, AG, CWD } of RIGS) {
	subs.push([CWD, "&lt;cwd&gt;"], [AG, "&lt;agentDir&gt;"], [R, "&lt;tmp&gt;"]);
}
subs.push([ROOT, "&lt;war-dogs&gt;"]);
subs.sort((a, b) => b[0].length - a[0].length);
let outHtml = html;
for (const [real, ph] of subs) outHtml = outHtml.split(real).join(ph);
fs.writeFileSync(OUT, outHtml);
console.log(
	`wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB, ${seen.size} distinct texts from runs, ${src.size} source lines scanned)`,
);
