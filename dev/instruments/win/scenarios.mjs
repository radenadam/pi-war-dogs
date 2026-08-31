// The Windows acceptance suite, driven through the ConPTY rig (rig.mjs).
// `npm install` in this folder, build the private agent dirs (`node setup.mjs`), then:
//
//   node scenarios.mjs                                      # everything
//   node scenarios.mjs exit_quit off_is_stock agent_enum    # the token-free ones
//
// Token-free: exit_quit, exit_ctrl_d, exit_ctrl_c2, off_is_stock, ctrl_g, switch, agent_enum.
// The rest drive the configured model (a request or two each). Each scenario boots its own
// pi from the scratch agent dir and quits it; the summary at the end is the verdict.
import { launch, show, modesRestored, sleep, SCRATCH, AGENT, AGENT_OFF, HERE } from "./rig.mjs";
import fs from "node:fs";
import path from "node:path";
const SESS = (agent) => path.join(agent, "sessions");
const newestJsonl = (dir, exclude = new Set()) => {
	let best = null;
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl") && !exclude.has(p)) {
				const st = fs.statSync(p);
				if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs };
			}
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return best?.p ?? null;
};
const allJsonl = (dir) => {
	const out = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
};
const entries = (file) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
const toolCalls = (file) => {
	const out = [];
	for (const e of entries(file)) {
		const m = e.message ?? e;
		if (e.type === "message" && m.role === "assistant")
			for (const c of m.content ?? []) if (c.type === "toolCall") out.push({ name: c.name, args: c.arguments });
	}
	return out;
};
const lastAssistantText = (file) => {
	let t = "";
	for (const e of entries(file)) {
		const m = e.message ?? e;
		if (e.type === "message" && m.role === "assistant") {
			const s = (m.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (s) t = s;
		}
	}
	return t;
};
const sessionFileFor = async (agent, id, ms = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		for (const f of allJsonl(SESS(agent))) if (f.includes(id)) return f;
		await sleep(300);
	}
	throw new Error("no session file for " + id);
};
const sessionId = (pi) => {
	const m = /Session: ([0-9a-f-]{36})/.exec(pi.text());
	return m?.[1];
};
async function waitToolCall(file, name, ms = 120000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (fs.existsSync(file) && toolCalls(file).some((c) => c.name === name)) return toolCalls(file);
		await sleep(500);
	}
	throw new Error(
		"no " +
			name +
			" tool call within " +
			ms +
			"ms; calls: " +
			JSON.stringify(fs.existsSync(file) ? toolCalls(file).map((c) => c.name) : null),
	);
}
async function idle(pi, ms = 180000) {
	await pi.waitFor(/Generated in \d+/, ms, "the turn to settle");
	await sleep(800);
}
const quit = async (pi) => {
	pi.key("ctrl-c");
	await sleep(1500);
	pi.send("/quit\r");
	return pi.waitExit(20000);
};
const wlog = (n) => {
	const f = SCRATCH + "\\tui-" + n + ".log";
	try {
		fs.unlinkSync(f);
	} catch {}
	return f;
};
const ok = (c, msg) => {
	if (!c) throw new Error("ASSERT: " + msg);
	console.log("  ok  " + msg);
};

export const scenarios = {
	async task_provenance() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		const before = new Set(allJsonl(SESS(AGENT)));
		pi.send(
			"Start one agent with the task: reply with the single word ready. Wait for it, then tell me what it said.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "agent");
		await idle(pi, 240000);
		const child = newestJsonl(SESS(AGENT), new Set([file, ...before]));
		ok(!!child, "child transcript: " + path.basename(child));
		const first = entries(child).find((e) => e.type === "message" && e.message?.role === "user");
		const text = (first.message.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		const firstLine = text.split("\n")[0];
		console.log("  task first line: " + firstLine.slice(0, 140));
		ok(/^\[from [^\]\n]+\]$/.test(firstLine), "the TASK opens with a provenance line");
		ok(/goes back/.test(firstLine), "and it states where the output goes");
		const body = text.split("\n").slice(1).join("\n").trim();
		ok(body.length > 20, "a task body follows the line (" + body.length + " chars)");
		await quit(pi);
	},
	async wait_nodup() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.send(
			"Stress drill, follow exactly: FIRST start three agents in one batch of tool calls, each with a task like: run Start-Sleep -Seconds N through your shell tool, then reply with the single word done-N. Use N = 3, 8 and 13. THEN, in your very next tool call, use the agent action wait with all three ids at once in to. When the wait returns, reply with one line: how many replies the wait carried in full versus pointed elsewhere. Do not use status.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "agent");
		await idle(pi, 300000);
		const es = entries(file);
		// every agent id the wait reported
		const waitResults = es.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult" && JSON.stringify(e).includes('"wait"'),
		);
		const bodyText = (e) => {
			const c = e.message?.content ?? e.content ?? [];
			if (typeof c === "string") return c;
			return c
				.filter((x) => x.type === "text")
				.map((x) => x.text)
				.join("");
		};
		const waitText = waitResults.map(bodyText).join("\n");
		const delivered = es.filter((e) => e.type === "custom_message" && e.customType === "agent-result");
		const batches = es.filter((e) => e.type === "custom_message" && e.customType === "background-results");
		console.log(
			"  deliveries: " +
				delivered.length +
				" single + " +
				batches.length +
				" batched; wait sections: " +
				(waitText.match(/Agent "/g) || []).length,
		);
		for (const d of [...delivered, ...batches]) {
			const dt = bodyText(d);
			const dids = [...dt.matchAll(/agent id: (agent_[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
			for (const did of dids) {
				const dupBody = waitText.includes("agent id: " + did) && !waitText.includes("not repeated here");
				ok(!dupBody, "a delivered reply (" + did + ") is not ALSO carried in full by the wait");
			}
		}
		// the strong assertion: no reply body appears twice anywhere
		const doneWords = ["done-3", "done-8", "done-13"];
		for (const w of doneWords) {
			const n = es.filter(
				(e) => (e.type === "custom_message" || e.message?.role === "toolResult") && bodyText(e).includes(w),
			).length;
			ok(n <= 1, w + " reaches the model at most once (saw " + n + ")");
		}
		await quit(pi);
	},
	async wait_after_delivery() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.send(
			"Drill, follow exactly: FIRST start one agent with the task: reply with the single word banana-bread. SECOND run Start-Sleep -Seconds 12 through your shell tool (foreground, one call). THIRD use the agent action wait on that agent id. Then reply with one line describing what the wait said. Do not use status.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "agent");
		await idle(pi, 300000);
		const es = entries(file);
		const bodyText = (e) => {
			const c = e.message?.content ?? e.content ?? [];
			if (typeof c === "string") return c;
			return c
				.filter((x) => x.type === "text")
				.map((x) => x.text)
				.join("");
		};
		const delivered = es.filter(
			(e) =>
				e.type === "custom_message" &&
				(e.customType === "agent-result" || e.customType === "background-results") &&
				bodyText(e).includes("banana-bread"),
		);
		const waitResults = es.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult" && bodyText(e).includes("not repeated here"),
		);
		const n = es.filter(
			(e) => (e.type === "custom_message" || e.message?.role === "toolResult") && bodyText(e).includes("banana-bread"),
		).length;
		console.log(
			"  delivered=" + delivered.length + " pointer-waits=" + waitResults.length + " banana-bread occurrences=" + n,
		);
		ok(delivered.length === 1, "the reply arrived once as a delivery");
		ok(waitResults.length >= 1, "the wait pointed at it instead of repeating");
		ok(n === 1, "the reply body reaches the model exactly once");
		await quit(pi);
	},
	async agent_rechat() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		const before = new Set(allJsonl(SESS(AGENT)));
		pi.send(
			"Start one agent with the task: run Get-Location through your shell tool and reply with the path. Wait for it and tell me what it said.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "agent");
		await idle(pi, 240000);
		const child = newestJsonl(SESS(AGENT), new Set([file, ...before]));
		ok(!!child, "child transcript: " + path.basename(child));
		const turn1 = toolCalls(child).filter((c) => c.name === "powershell").length;
		ok(turn1 >= 1, "turn 1: the child used powershell (" + turn1 + " calls)");
		// chat with the idle run from its own view: alt+s, select, enter, type
		pi.key("alt-s");
		await sleep(800);
		pi.key("down");
		await sleep(400);
		pi.key("enter");
		await sleep(1500);
		ok(/subagent view/.test(pi.text()), "the run view is open (" + pi.screen()[0].trim().slice(0, 60) + ")");
		pi.send("Now run Get-Date through your shell tool and reply with the exact output.\r");
		const t0 = Date.now();
		while (Date.now() - t0 < 180000) {
			if (toolCalls(child).filter((c) => c.name === "powershell").length > turn1) break;
			await sleep(500);
		}
		const turn2 = toolCalls(child).filter((c) => c.name === "powershell").length;
		ok(
			turn2 > turn1,
			"turn 2 (rehydrated run): the child used powershell again (" +
				turn2 +
				" calls total), never bash: " +
				!toolCalls(child).some((c) => c.name === "bash"),
		);
		await pi.waitFor(/Generated in \d+|idle/, 180000, "the child's second turn to settle");
		await sleep(1500);
		show(pi, "the run view after the chat");
		// transcript facts: user-role messages, model/provider on every assistant message, same as main's
		const es = entries(child);
		const users = es.filter((e) => e.type === "message" && e.message?.role === "user").length;
		const assistants = es.filter((e) => e.type === "message" && e.message?.role === "assistant");
		const models = new Set(assistants.map((m) => (m.message.provider ?? "") + "/" + (m.message.model ?? "")));
		const mainModels = new Set(
			entries(file)
				.filter((e) => e.type === "message" && e.message?.role === "assistant")
				.map((m) => (m.message.provider ?? "") + "/" + (m.message.model ?? "")),
		);
		console.log(
			"  child: " +
				users +
				" user messages, " +
				assistants.length +
				" assistant messages, models " +
				JSON.stringify([...models]) +
				"; main models " +
				JSON.stringify([...mainModels]),
		);
		ok(users >= 2 && assistants.length >= 2, "the transcript holds both turns");
		ok(models.size === 1 && [...mainModels].every((m) => models.has(m)), "the child ran on main's model on both turns");
		const thinking = es
			.filter((e) => e.type === "thinking_level_change" || e.thinkingLevel)
			.map((e) => e.thinkingLevel ?? e.level);
		const manifest = fs.readdirSync(path.dirname(child)).find((f) => f.endsWith(".json"));
		const man = manifest ? JSON.parse(fs.readFileSync(path.join(path.dirname(child), manifest), "utf8")) : null;
		console.log(
			"  manifest: " +
				JSON.stringify(
					man
						? {
								status: man.status,
								model: man.model ?? man.config?.model,
								thinking: man.thinkingLevel ?? man.config?.thinkingLevel ?? man.config?.effort,
								tools: man.config?.tools,
							}
						: null,
				) +
				"; transcript thinking entries: " +
				JSON.stringify(thinking),
		);
		pi.key("ctrl-r");
		await sleep(600);
		await quit(pi);
	},
	async agent_enum() {
		const out = SCRATCH + "\\enum.json";
		try {
			fs.unlinkSync(out);
		} catch {}
		const pi = launch({ args: ["--no-session", "-e", path.join(HERE, "tools-dump.ts")], env: { TOOLS_OUT: out } });
		await pi.waitFor(/main view/, 40000);
		await sleep(4000);
		const j = JSON.parse(fs.readFileSync(out, "utf8"));
		console.log("  active: " + j.active.join(", "));
		console.log("  agent tools enum: " + JSON.stringify(j.agentToolsEnum));
		ok(
			Array.isArray(j.agentToolsEnum) && j.agentToolsEnum.includes("powershell") && !j.agentToolsEnum.includes("bash"),
			"the agent tool's tools enum offers powershell and not bash",
		);
		ok(j.active.includes("powershell") && !j.active.includes("bash"), "main's active set: powershell, no bash");
		await quit(pi);
	},
	async exit_quit() {
		const w = wlog("quit");
		const pi = launch({ env: { PI_TUI_WRITE_LOG: w } });
		await pi.waitFor(/main view/, 40000);
		await sleep(1000);
		const e = await quit(pi);
		ok(e.exitCode === 0, "exit code 0 (" + JSON.stringify(e) + ")");
		const m = modesRestored(fs.readFileSync(w, "utf8"));
		ok(m.altOff && m.mouseOff && m.autowrapOn, "modes restored in pi-tui write log " + JSON.stringify(m));
		ok(!pi.alt(), "back on the primary screen");
	},
	async exit_ctrl_d() {
		const w = wlog("ctrld");
		const pi = launch({ env: { PI_TUI_WRITE_LOG: w } });
		await pi.waitFor(/main view/, 40000);
		await sleep(1000);
		pi.key("ctrl-d");
		const e = await pi.waitExit(20000);
		ok(e.exitCode === 0, "exit code 0");
		const m = modesRestored(fs.readFileSync(w, "utf8"));
		ok(m.altOff && m.mouseOff && m.autowrapOn, "modes restored in pi-tui write log " + JSON.stringify(m));
		ok(!pi.alt(), "primary screen");
	},
	async exit_ctrl_c2() {
		const w = wlog("ctrlc2");
		const pi = launch({ env: { PI_TUI_WRITE_LOG: w } });
		await pi.waitFor(/main view/, 40000);
		await sleep(1000);
		pi.key("ctrl-c");
		await sleep(300);
		pi.key("ctrl-c");
		const e = await pi.waitExit(20000);
		ok(e.exitCode === 0, "exit code 0");
		const m = modesRestored(fs.readFileSync(w, "utf8"));
		ok(m.altOff && m.mouseOff && m.autowrapOn, "modes restored in pi-tui write log " + JSON.stringify(m));
		ok(!pi.alt(), "primary screen");
	},
	async off_is_stock() {
		const sgr = (raw) => new Set([...raw.matchAll(/\x1b\[(?:38|48);2;\d+;\d+;\d+m/g)].map((m) => m[0]));
		const norm = (lines) =>
			lines
				.map((l) => l.replace(/\s+$/, ""))
				.filter(
					(l) =>
						!/^\s*war-dogs\s*$/.test(l) &&
						!/^\[Extensions\]/.test(l) &&
						!/new version|update available|pi update/i.test(l),
				)
				.join("\n")
				.replace(/\n{2,}/g, "\n");
		const boot = async (args) => {
			const pi = launch({ args, agentDir: AGENT_OFF });
			await pi.waitFor(/kimi-for-coding/, 40000, "the footer");
			await sleep(2500);
			const r = { text: norm(pi.screen()), sgr: sgr(pi.rawText()), alt: pi.alt(), screen: pi.screen() };
			await quit(pi);
			return r;
		};
		const stock = await boot(["--no-extensions"]);
		const off = await boot([]);
		ok(!stock.alt && !off.alt, "neither on the alt screen");
		if (stock.text !== off.text) {
			console.log("--- stock ---\n" + stock.screen.join("\n") + "\n--- off ---\n" + off.screen.join("\n"));
		}
		ok(stock.text === off.text, "screen text identical after normalisation");
		const a = [...stock.sgr].sort().join(","),
			b = [...off.sgr].sort().join(",");
		ok(a === b, "truecolor SGR sets identical (" + stock.sgr.size + " codes)");
	},
	async powershell_main() {
		const pi = launch({ env: { PI_WARDOGS_TRACE: SCRATCH + "\\trace-main.log" } });
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		ok(!!id, "session id " + id);
		pi.send("Print the current directory using your shell tool, one command, then reply with the path only.\r");
		const file = await sessionFileFor(AGENT, id);
		const calls = await waitToolCall(file, "powershell");
		ok(
			calls.some((c) => c.name === "powershell"),
			"the model called powershell: " + JSON.stringify(calls.map((c) => c.name)),
		);
		ok(!calls.some((c) => c.name === "bash"), "and never bash");
		await idle(pi);
		show(pi, "after the powershell turn");
		// mouse: click the act row to fold/unfold; wheel to scroll
		const rows = pi.screen();
		const i = rows.findIndex((l) => /executed powershell|executed 1 powershell/.test(l));
		ok(i >= 0, "the act row is on screen (row " + i + ")");
		const before = pi.text();
		pi.mouse(6, i + 1);
		await sleep(700);
		const after = pi.text();
		ok(before !== after, "a click on the act row changed the screen (fold toggled)");
		pi.wheel(60, 10, true);
		await sleep(500);
		const hdr = pi.screen()[0];
		console.log("  header after wheel-up: " + hdr.trim().slice(0, 60));
		const tr = fs.existsSync(SCRATCH + "\\trace-main.log") ? fs.readFileSync(SCRATCH + "\\trace-main.log", "utf8") : "";
		ok(/ev=(toggle|uncluster)/.test(tr), "trace logged the fold (toggle or uncluster)");
		ok(/ev=click/.test(tr), "trace logged ev=click");
		await quit(pi);
	},
	async bg_powershell() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.send(
			"Run this with your shell tool as a BACKGROUND job (background: true): Start-Sleep -Seconds 5; Get-Date. Then reply with one word: waiting. Do not poll.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		const calls = await waitToolCall(file, "powershell");
		ok(
			calls.some((c) => c.name === "powershell" && c.args?.background === true),
			"a background powershell job was started: " + JSON.stringify(calls.map((c) => [c.name, c.args?.background])),
		);
		await pi.waitFor(/Background powershell|background result|delivered/i, 90000, "the background result delivered");
		await sleep(500);
		show(pi, "background delivery");
		const es = entries(file);
		const delivered = es.some(
			(e) =>
				JSON.stringify(e).includes("background powershell result") ||
				JSON.stringify(e).includes("Background powershell"),
		);
		ok(delivered, "the delivery is in the transcript");
		await idle(pi, 120000);
		await quit(pi);
	},
	async agent_child() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		const before = new Set(allJsonl(SESS(AGENT)));
		pi.send(
			"Start one agent with the task: run Get-Location through your shell tool and reply with the path. Then wait for it and tell me what it said.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "agent");
		await pi.waitFor(/started agent|agent .*finished|agent stats/i, 180000, "the agent to run");
		await idle(pi, 240000);
		show(pi, "after the agent");
		const child =
			newestJsonl(SESS(AGENT), new Set([file, ...before])) ?? newestJsonl(path.join(AGENT), new Set([file, ...before]));
		ok(!!child, "a child transcript exists: " + child);
		const cc = toolCalls(child);
		ok(
			cc.some((c) => c.name === "powershell"),
			"the child called powershell: " + JSON.stringify(cc.map((c) => c.name)),
		);
		ok(!cc.some((c) => c.name === "bash"), "and never bash");
		pi.key("alt-s");
		await sleep(800);
		const st = pi.text();
		console.log("  after alt+s header: " + pi.screen()[0].trim().slice(0, 70));
		ok(/station/.test(st), "the station opened on alt+s");
		pi.key("down");
		await sleep(400);
		pi.key("enter");
		await sleep(1500);
		console.log("  after down+enter header: " + pi.screen()[0].trim().slice(0, 70));
		ok(/subagent view/.test(pi.text()), "the run view opened");
		pi.key("ctrl-r");
		await sleep(800);
		ok(/main view/.test(pi.text()), "ctrl+r back to main");
		await quit(pi);
	},
	async browser_mcp() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.send(
			"Use the mcp tool with the playwright server: browser_navigate to https://en.wikipedia.org/wiki/Windows_Terminal, then reply with the page title only.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		const calls = await waitToolCall(file, "mcp", 180000);
		ok(
			calls.some((c) => c.name === "mcp"),
			"the model called mcp",
		);
		await idle(pi, 240000);
		const t = lastAssistantText(file);
		ok(/Windows Terminal/i.test(t), "the reply carries the title: " + JSON.stringify(t.slice(0, 120)));
		show(pi, "browser");
		await quit(pi);
	},
	async webfetch_search() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.send(
			"Two tool calls, then one short reply: first webfetch https://httpbin.org/html and note its first heading; second kimi-websearch for 'Windows Terminal ConPTY' and note one result title.\r",
		);
		const file = await sessionFileFor(AGENT, id);
		await waitToolCall(file, "webfetch", 180000);
		await waitToolCall(file, "kimi-websearch", 180000);
		await idle(pi, 240000);
		const t = lastAssistantText(file);
		ok(t.length > 20, "a reply came back: " + JSON.stringify(t.slice(0, 160)));
		show(pi, "webfetch+search");
		await quit(pi);
	},
	async peers() {
		const A = launch();
		await A.waitFor(/main view/, 40000);
		const idA = sessionId(A);
		const B = launch();
		await B.waitFor(/main view/, 40000);
		const idB = sessionId(B);
		ok(idA && idB && idA !== idB, "two sessions " + idA + " / " + idB);
		B.send(
			"Use the agent tool action list and reply with the ids of the other pi sessions on this machine only, one per line, nothing else.\r",
		);
		const fB = await sessionFileFor(AGENT, idB);
		await waitToolCall(fB, "agent");
		await idle(B, 180000);
		const tB = lastAssistantText(fB);
		ok(tB.includes(idA.slice(0, 8)) || /session_/.test(tB), "B sees A as a peer: " + JSON.stringify(tB.slice(0, 200)));
		const peerId = (/session_[A-Za-z0-9_-]+/.exec(tB) ?? [])[0];
		ok(!!peerId, "a peer id was named: " + peerId);
		B.send(
			"Use the agent tool action message to send this text to " + peerId + ": hello from session B. Then reply done.\r",
		);
		await A.waitFor(/hello from session B/, 180000, "A to receive the message");
		show(A, "A after the peer message");
		await idle(B, 180000);
		await quit(A);
		await quit(B);
	},
	async drop_space() {
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		const id = sessionId(pi);
		pi.paste('"' + SCRATCH + '\\my shot.png"');
		await pi.waitFor(/\[\^image 1\]/, 15000, "the ref in the editor");
		show(pi, "after the drop");
		pi.send(" What colour is the background of this image, one word?\r");
		const file = await sessionFileFor(AGENT, id);
		await idle(pi, 180000);
		const es = entries(file);
		const withImage = es.some(
			(e) =>
				e.message?.role === "user" &&
				Array.isArray(e.message.content) &&
				e.message.content.some((c) => c.type === "image"),
		);
		ok(withImage, "the user message carries an image block");
		const t = lastAssistantText(file);
		console.log("  reply: " + JSON.stringify(t.slice(0, 100)));
		ok(/pink|magenta|purple|fuchsia|violet/i.test(t), "the model saw the pink background");
		await quit(pi);
	},
	async ctrl_g() {
		const ed = SCRATCH + "\\editor.cmd";
		fs.writeFileSync(ed, "@echo off\r\necho hello from the editor>> %1\r\n");
		const sp = AGENT + "\\settings.json";
		const saved = fs.readFileSync(sp, "utf8");
		const s = JSON.parse(saved);
		s.externalEditor = ed;
		fs.writeFileSync(sp, JSON.stringify(s, null, 2));
		try {
			const pi = launch();
			await pi.waitFor(/main view/, 40000);
			await sleep(800);
			pi.key("ctrl-g");
			await pi.waitFor(/hello from the editor/, 20000, "the editor's text back in the prompt");
			await sleep(800);
			ok(pi.alt() && /main view/.test(pi.text()), "the pager is back after the editor");
			show(pi, "after ctrl+g");
			await quit(pi);
		} finally {
			fs.writeFileSync(sp, saved);
		}
	},
	async switch() {
		const sp = AGENT + "\\settings.json";
		const pi = launch();
		await pi.waitFor(/main view/, 40000);
		await sleep(800);
		pi.send("/war-dogs off\r");
		await pi.waitGone(/main view/, 30000);
		await pi.waitFor(/kimi-for-coding/, 30000, "the stock footer");
		await sleep(2000);
		show(pi, "after /war-dogs off");
		let s = JSON.parse(fs.readFileSync(sp, "utf8"));
		ok(s["war-dogs"].enabled === false, "settings: enabled false");
		ok(
			s.theme === "dark" && !("_prevTheme" in s["war-dogs"]),
			"settings: theme restored to dark, marker gone (" + JSON.stringify(s) + ")",
		);
		ok(!pi.alt(), "stock is on the primary screen");
		pi.send("/war-dogs on\r");
		await pi.waitFor(/main view/, 40000, "the pager back");
		await sleep(1500);
		s = JSON.parse(fs.readFileSync(sp, "utf8"));
		ok(
			s["war-dogs"].enabled === true && s.theme === "canopy" && s["war-dogs"]._prevTheme === "dark",
			"settings: on again, canopy, marker dark",
		);
		await quit(pi);
	},
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const results = [];
for (const n of names) {
	const t0 = Date.now();
	console.log("\n=== " + n + " ===");
	try {
		await scenarios[n]();
		results.push([n, "PASS", Date.now() - t0]);
	} catch (e) {
		console.log("FAIL " + n + ": " + e.message);
		results.push([n, "FAIL", Date.now() - t0]);
	}
}
console.log("\n=== summary ===");
for (const [n, r, ms] of results) console.log(r.padEnd(5), n.padEnd(18), Math.round(ms / 1000) + "s");
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
