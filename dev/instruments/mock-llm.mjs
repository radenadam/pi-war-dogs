#!/usr/bin/env node
// A local OpenAI-compatible STREAMING mock model — the instrument that isolates
// the pager's rendering pipeline from the network and drives tool calls
// deterministically (no key, no provider, no bursts you did not choose).
//
// Text streams one word per INTERVAL ms (WORDS words); scripted tool calls key
// on the LAST user message text:
//   "fg"     -> bash (foreground)          "bg"   -> bash {background:true}
//   "sub"    -> agent run (a receipt; the reply is delivered)   "subdef" -> the same, second title
//   "subw"   -> agent run whose receipt triggers action:"wait" on the id (the join primitive)
//   "subask" -> agent run whose receipt triggers action:"ask" on the id (the out-of-band question)
//   "sublist"-> agent {action:"list"}
//   "substat"-> agent run of a slow child (bash sleep); the receipt triggers a bare action:"status"
//   "subnamed"/"subsys"/"subappend" -> agent runs probing the prompt precedence (named agent "probe", call systemPrompt, appendSystemPrompt)
//   "waitwork"-> bare status, then wait on the working agent it reports (the user-driven-turn join)
//   "subslow" -> agent run of a SLOW child (bash sleep 6), no follow-up: the lead rule's hold (agent-harness leadrule)
//   "subfastbusy" -> agent run of a FAST child ("say fast-done") whose receipt triggers a 5 s foreground bash in the
//               caller: the child's reply lands while the caller STREAMS (agent-harness leadsteer)
//   "deadtext"-> thinking + a truncated agent tool call, then the stream DIES (no finish_reason):
//               the errored-attempt shape (pi retries per settings; each attempt persists)
//   "peermsg" -> list, then message "hello from A" to the first peer the list shows
//   "peerask" -> list, then ask the first peer what its session is doing
//   "mcp"    -> mcp gateway {tool,server}  "direct" -> playwright_browser_tabs (a direct MCP tool)
//   "script" -> mcpScript {code} (the adapter's script tool; 5 lines of JS)
//   "md"     -> prose with H1-H6 headings, a code span, bold, a list, a js fence, a dotted path, a wrapped link
//   "mdwide" -> a fence whose lines exceed the measure (wrapped ``` block rendering)
//   "readfile" -> read {path:/tmp/wd-r-small.txt} (numbered read + metadata line rendering)
//   "canvas" -> write {path:canvas/quarterly-report.html} (the canvas act); "canvas2" -> the same path again (revised)
//   "wf"       -> webfetch {url:https://example.com/} (head line + stamp handling; needs network)
//   "long"   -> bash `seq 1 12` (12 output rows: a working snippet that hides rows; `fg` hides none)
//   "slow"   -> bash `sleep 8 && echo done` (a RUNNING act with no output yet, for 8 s)
//   "steerbg"-> bash bg (sleep 2) whose receipt triggers a fg bash (sleep 6): the delivery lands MID-TURN (steer)
//   "seq"    -> thinking (reasoning_content, short lines) -> prose -> bash tool call; the tool-result
//               turn answers with 200 words of final prose — the thinking→prose→tool→answer shape
//   "seq2"   -> the same with 400-column thinking lines (the shape that froze the working view)
//   "seq3"   -> thinking straight into a bash call (a two-member cluster: thought + executed)
//   "seq4"   -> thinking straight into a FAILING direct MCP call (a red member beside a green one)
//   "mcplong"-> mcp gateway call whose args carry a long string (continuation-row colour)
// A request whose last message is a tool result answers with a short text; a
// child prompt starting "Reply with a short" gets a two-paragraph answer; a
// delivered background result ("Background bash…"/"Subagent …") gets a short
// acknowledgement; anything else streams WORDS words in 14-word paragraphs.
//
// Usage (a private agent dir keeps your real settings untouched — see the
// README's Debugging section for the models.json + settings.json it needs):
//   PORT=18777 INTERVAL=25 WORDS=500 node dev/instruments/mock-llm.mjs &
//   PI_CODING_AGENT_DIR=/tmp/wd-agent pi            # then type: bg | sub | mcp | fg | anything
// Measured with it (2026-08-18, pi 0.83.0): war-dogs and stock paint a 25 ms
// token stream identically — screen changes every ~46 ms in both, ~12 ms
// after the token, flatten p50 0 ms; a "clunky" stream is the provider's —
// except the working thinking window's truncated long lines (seq2), fixed
// the same day. models.json needs "reasoning": true for seq/seq2's thinking.
import http from "node:http";
import fs from "node:fs";
const PORT = Number(process.env.PORT || 18777);
// DUMP=<file>: append every request body (one JSON line, {t, body}) — the
// wire-level instrument for "what did the model actually receive" (thinking
// carriage, steer placement, provenance lines). Off unless set.
const DUMP = process.env.DUMP || "";
const INTERVAL = Number(process.env.INTERVAL || 25);
const WORDS = Number(process.env.WORDS || 500);
const longText = Array.from({ length: WORDS }, (_, i) => `word${i + 1}${(i + 1) % 14 === 0 ? ".\n\n" : " "}`);
const lastText = (m) =>
	typeof m?.content === "string"
		? m.content
		: Array.isArray(m?.content)
			? m.content
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join("")
			: "";
http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (!req.url.endsWith("/chat/completions")) {
				res.writeHead(404);
				res.end();
				return;
			}
			let msgs = [];
			try {
				const parsed = JSON.parse(body);
				msgs = parsed.messages ?? [];
				if (DUMP) fs.appendFileSync(DUMP, JSON.stringify({ t: Date.now(), body: parsed }) + "\n");
			} catch {}
			const last = msgs[msgs.length - 1];
			// The FLOW key: the LAST user-typed text (deliveries and tool
			// results are not user-typed), so sequential scenarios in one
			// session each key their own chain.
			const flowKey = (() => {
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i];
					if (m?.role !== "user") continue;
					const t = lastText(m).split("\n")[0].trim();
					if (/^\[/.test(t)) continue;
					return t;
				}
				return "";
			})();
			// war-dogs stamps every user prompt with a trailing [timestamp: …]
			// line; the keyword match reads past it like a real model would.
			const strip = (m) =>
				lastText(m)
					.replace(/\n?\[(?:timestamp:|at) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]\s*$/, "")
					// The agent tool prefixes every post-task message with its
					// sender ([from your user] / [from the agent that started
					// you]); the keyword match reads past it like a real model.
					.replace(/^\[from [^\]]+\]\n+/, "")
					.trim();
			// The SESSION BRIEF (prompt/) rides turn one as a user-role custom
			// message AFTER the prompt, so the literal last user message of a
			// first turn is the brief, not the keyword — walk back past it
			// (2026-08-26: `pi -p canvas` streamed words instead of the write).
			const text = (() => {
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i];
					if (m?.role !== "user") continue;
					const t = strip(m);
					if (t.startsWith("[session brief")) continue;
					// An injected message (prompt/inject.ts) has no wrapper of its
					// own; a rig that wants one AND a keyword marks it "[inject]"
					// (2026-08-28), and the walk reads past it like the brief.
					if (t.startsWith("[inject]")) continue;
					return t;
				}
				return strip(last);
			})();
			// Follow-up triggers key on the LITERAL last message (a tool
			// receipt); the brief-skip walk above is for USER keywords only —
			// keying those triggers on `text` went dead the day the walk
			// landed (2026-08-27: substat's status call never fired).
			const lastMsgText = strip(last);
			console.log(new Date().toISOString(), req.method, req.url, last?.role, JSON.stringify(text.slice(0, 60)));
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const id = "chatcmpl-" + Math.random().toString(36).slice(2, 8);
			const send = (delta, finish = null) =>
				res.write(
					`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: (Date.now() / 1000) | 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
				);
			const done = (n) => {
				res.write(
					`data: {"id":"${id}","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":${n},"total_tokens":${n + 10}}}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			};
			send({ role: "assistant", content: "" });
			let words;
			let tool = null;
			if (last?.role === "tool" && /^Started "Steer probe"/.test(lastMsgText))
				tool = { name: "bash", args: { command: "sleep 6 && echo fg-done", description: "Block six seconds" } };
			else if (last?.role === "tool" && /^Started "Fast worker"/.test(lastMsgText))
				tool = { name: "bash", args: { command: "sleep 5 && echo lead-busy", description: "Block five seconds" } };
			else if (last?.role === "tool" && /^(?:Started|Queued) "Join probe"/.test(lastMsgText)) {
				const aid = /\[agent id: (agent_[\w-]+)\]/.exec(lastMsgText)?.[1];
				tool = { name: "agent", args: { action: "wait", to: [aid ?? "agent_unknown"] } };
			} else if (last?.role === "tool" && /^(?:Started|Queued) "Status probe"/.test(lastMsgText)) {
				tool = { name: "agent", args: { action: "status" } };
			} else if (last?.role === "tool" && /^Peers:$/m.test(lastMsgText) && /^peer(msg|ask)/.test(flowKey)) {
				const sid = /session_([\w-]+) ·/.exec(lastMsgText)?.[1];
				tool = flowKey.startsWith("peermsg")
					? { name: "agent", args: { action: "message", to: `session_${sid}`, message: "hello from A" } }
					: {
							name: "agent",
							args: { action: "ask", to: `session_${sid}`, question: "What is your session working on?" },
						};
			} else if (last?.role === "tool" && /\): working for/.test(lastMsgText)) {
				const aid = /\((agent_[\w-]+)\): working/.exec(lastMsgText)?.[1];
				tool = { name: "agent", args: { action: "wait", to: [aid ?? "agent_unknown"] } };
			} else if (last?.role === "tool" && /^(?:Started|Queued) "Ask probe"/.test(lastMsgText)) {
				const aid = /\[agent id: (agent_[\w-]+)\]/.exec(lastMsgText)?.[1];
				tool = {
					name: "agent",
					args: { action: "ask", to: aid ?? "agent_unknown", question: "What is the cat's name?" },
				};
			} else if (last?.role === "tool" && /(?:hi|12)\n?$/.test(lastMsgText))
				words = Array.from({ length: 200 }, (_, i) => `final${i + 1}${(i + 1) % 12 === 0 ? ".\n\n" : " "}`);
			else if (last?.role === "tool") words = ["Tool ", "result ", "received."];
			// Generic, parameterised flows for the agent harness (dev/instruments/agent-harness.mjs):
			//   "sleep N"            -> bash `sleep N && echo done` (a child busy for N s, one tool boundary)
			//   "think then sleep N" -> 24 words of reasoning_content, then the same bash call
			//   "say <words>"        -> exactly those words, streamed (a deterministic short reply)
			else if (/^sleep (\d+)$/.test(text)) {
				const n = Number(/^sleep (\d+)$/.exec(text)[1]);
				tool = { name: "bash", args: { command: `sleep ${n} && echo done`, description: `Sleep ${n} seconds` } };
			} else if (/^say (.+)$/s.test(text)) words = /^say (.+)$/s.exec(text)[1].split(/(?<= )/);
			else if (/^think then sleep (\d+)$/.test(text)) {
				const n = Number(/^think then sleep (\d+)$/.exec(text)[1]);
				const think = Array.from({ length: 24 }, (_, i) => `ponder${i + 1}${(i + 1) % 8 === 0 ? ".\n" : " "}`);
				const call = {
					index: 0,
					id: "call_ts" + Math.random().toString(36).slice(2, 6),
					type: "function",
					function: { name: "bash", arguments: "" },
				};
				const argStr = JSON.stringify({ command: `sleep ${n} && echo done`, description: `Sleep ${n} seconds` });
				let k = 0;
				const t = setInterval(() => {
					if (k < think.length) {
						send({ reasoning_content: think[k++] });
						return;
					}
					if (k === think.length) {
						send({ tool_calls: [call] });
						k++;
						return;
					}
					const off = (k - think.length - 1) * 20;
					if (off < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(off, off + 20) } }] });
						k++;
						return;
					}
					clearInterval(t);
					send({}, "tool_calls");
					done(60);
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			} else if (text === "bg")
				tool = {
					name: "bash",
					args: {
						command: "sleep 2 && echo hello-from-background",
						background: true,
						description: "Echo hello after two seconds",
					},
				};
			else if (text === "readfile") tool = { name: "read", args: { path: "/tmp/wd-r-small.txt" } };
			else if (text === "canvas")
				tool = {
					name: "write",
					args: {
						path: "canvas/quarterly-report.html",
						content:
							'<!doctype html><meta charset="utf-8"><title>Quarterly report</title><body><h1>Q3</h1><p>All numbers up.</p></body>',
					},
				};
			else if (text === "canvas2")
				tool = {
					name: "write",
					args: {
						path: "canvas/quarterly-report.html",
						content:
							'<!doctype html><meta charset="utf-8"><title>Quarterly report</title><body><h1>Q3 revised</h1><p>All numbers up, one down.</p></body>',
					},
				};
			else if (text === "wf") tool = { name: "webfetch", args: { url: "https://example.com/" } };
			else if (text === "twocalls") {
				// TWO tool calls in one message (a parallel batch): a fast echo and a
				// 6 s sleep — the fast one must render done while the slow one runs.
				const calls = [
					{
						index: 0,
						id: "call_fast" + Math.random().toString(36).slice(2, 6),
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "echo fast-done", description: "Fast one" }),
						},
					},
					{
						index: 1,
						id: "call_slow" + Math.random().toString(36).slice(2, 6),
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "sleep 6 && echo slow-done", description: "Slow one" }),
						},
					},
				];
				send({ tool_calls: calls });
				send({}, "tool_calls");
				done(20);
				return;
			} else if (text === "long")
				tool = { name: "bash", args: { command: "seq 1 12", description: "Count to twelve" } };
			else if (text === "slow")
				tool = { name: "bash", args: { command: "sleep 8 && echo done", description: "Wait eight seconds" } };
			else if (text === "bgbig")
				tool = {
					name: "bash",
					args: { command: "seq 1 500", background: true, description: "Count to five hundred" },
				};
			else if (text === "bglong")
				tool = {
					name: "bash",
					args: { command: "sleep 12 && echo ok", background: true, description: "Twelve second nap" },
				};
			else if (text === "steerbg")
				tool = {
					name: "bash",
					args: { command: "sleep 2 && echo bg-done", background: true, description: "Steer probe" },
				};
			else if (text === "fg")
				tool = {
					name: "bash",
					args: { command: "echo hello-foreground && sleep 1", description: "Echo hello in the foreground" },
				};
			else if (text === "sub")
				tool = {
					name: "agent",
					args: {
						title: "Say hello",
						message: "Reply with a short two-paragraph greeting about a cat named Muffin. Plain text.",
					},
				};
			else if (text === "subdef")
				tool = {
					name: "agent",
					args: {
						title: "Default mode probe",
						message: "Reply with one short sentence about a lighthouse. Plain text.",
					},
				};
			else if (text === "subw")
				tool = {
					name: "agent",
					args: {
						title: "Join probe",
						message: "Reply with a short two-paragraph greeting about a cat named Muffin. Plain text.",
					},
				};
			else if (text === "subask")
				tool = {
					name: "agent",
					args: {
						title: "Ask probe",
						message:
							"Reply with a short two-paragraph greeting about a cat named Muffin. Plain text. Take your time and think it over at length.",
					},
				};
			else if (text === "sublist") tool = { name: "agent", args: { action: "list" } };
			else if (text === "deadtext") {
				// Thinking, then a tool call whose args cut off mid-JSON, then
				// the stream ends with NO finish chunk: pi-ai throws "Stream
				// ended without finish_reason", keeps the partial blocks, and
				// pi records an errored assistant message per retry attempt.
				const think = Array.from({ length: 24 }, (_, i) => `dead${i + 1}${(i + 1) % 8 === 0 ? ".\n" : " "}`);
				const call = {
					index: 0,
					id: "call_dead" + Math.random().toString(36).slice(2, 6),
					type: "function",
					function: { name: "agent", arguments: "" },
				};
				const argStr = '{"action": "message", "message": "Do it. Recommend the top 2 with links"';
				let k = 0;
				const t = setInterval(() => {
					if (k < think.length) {
						send({ reasoning_content: think[k++] });
						return;
					}
					if (k === think.length) {
						send({ tool_calls: [call] });
						k++;
						return;
					}
					const off = (k - think.length - 1) * 20;
					if (off < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(off, off + 20) } }] });
						k++;
						return;
					}
					clearInterval(t);
					res.end(); // no finish_reason, no [DONE]: the stream just dies
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			} else if (text === "waitwork") tool = { name: "agent", args: { action: "status" } };
			else if (text === "subslow")
				tool = { name: "agent", args: { title: "Slow worker", message: "Run bash sleep 6 then reply done." } };
			else if (text === "subfastbusy")
				tool = { name: "agent", args: { title: "Fast worker", message: "say fast-done" } };
			else if (text === "peermsg" || text === "peerask") tool = { name: "agent", args: { action: "list" } };
			else if (text === "subcwd")
				tool = {
					name: "agent",
					args: {
						title: "Foreign cwd probe",
						message: "Reply with one word: ready-cwd.",
						cwd: "/tmp/wd-sp/cwd3",
					},
				};
			else if (text === "subnamed")
				tool = {
					name: "agent",
					args: { title: "Named probe", message: "Reply with one word: ready-named.", agent: "probe" },
				};
			else if (text === "subsys")
				tool = {
					name: "agent",
					args: {
						title: "Sysprompt probe",
						message: "Reply with one word: ready-sys.",
						systemPrompt: "PARENT-FILLED PROMPT: you are a terse probe.",
					},
				};
			else if (text === "subappend")
				tool = {
					name: "agent",
					args: {
						title: "Append probe",
						message: "Reply with one word: ready-append.",
						appendSystemPrompt: "APPENDED-RIDER: end every reply with the word ready.",
					},
				};
			else if (text === "substat")
				tool = {
					name: "agent",
					args: { title: "Status probe", message: "Run bash sleep 6 then reply done." },
				};
			else if (text === "Run bash sleep 6 then reply done.")
				tool = { name: "bash", args: { command: "sleep 6 && echo done", description: "Sleep six seconds" } };
			else if (text === "seq" || text === "seq2") {
				// thinking 120 words -> prose 60 words -> bash tool call; the tool result turn (below) answers with 200 words
				const longT = text === "seq2";
				const think = Array.from(
					{ length: longT ? 240 : 120 },
					(_, i) => `think${i + 1}${(i + 1) % (longT ? 60 : 12) === 0 ? ".\n\n" : " "}`,
				);
				const prose = Array.from({ length: 60 }, (_, i) => `prose${i + 1}${(i + 1) % 12 === 0 ? ".\n\n" : " "}`);
				const call = {
					index: 0,
					id: "call_seq" + Math.random().toString(36).slice(2, 6),
					type: "function",
					function: { name: "bash", arguments: "" },
				};
				const argStr = JSON.stringify({ command: "echo hi && sleep 1", description: "Say hi" });
				let k = 0;
				const t = setInterval(() => {
					if (k < think.length) {
						send({ reasoning_content: think[k++] });
						return;
					}
					if (k < think.length + prose.length) {
						send({ content: prose[k++ - think.length] });
						return;
					}
					if (k === think.length + prose.length) {
						send({ tool_calls: [call] });
						k++;
						return;
					}
					const off = (k - think.length - prose.length - 1) * 20;
					if (off < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(off, off + 20) } }] });
						k++;
						return;
					}
					clearInterval(t);
					send({}, "tool_calls");
					done(200);
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			} else if (text === "mcplong")
				tool = {
					name: "mcp",
					args: {
						tool: "browser_evaluate",
						server: "playwright",
						args: {
							function:
								"() => { const paras = Array.from(document.querySelectorAll('#mw-content-text p')).map(p => p.innerText.trim()).filter(t => t.length > 120); return paras.slice(0, 3).join('\\n\\n').slice(0, 3000); }",
						},
					},
				};
			else if (text === "seq4") {
				// thinking, then a direct MCP tool call that fails (red member) — for the cluster pad rule
				const think = Array.from({ length: 30 }, (_, i) => `think${i + 1}${(i + 1) % 12 === 0 ? ".\n" : " "}`);
				const call = {
					index: 0,
					id: "call_s4" + Math.random().toString(36).slice(2, 6),
					type: "function",
					function: { name: "playwright_browser_tabs", arguments: "" },
				};
				const argStr = JSON.stringify({ action: "list" });
				let k = 0;
				const t = setInterval(() => {
					if (k < think.length) {
						send({ reasoning_content: think[k++] });
						return;
					}
					if (k === think.length) {
						send({ tool_calls: [call] });
						k++;
						return;
					}
					const off = (k - think.length - 1) * 20;
					if (off < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(off, off + 20) } }] });
						k++;
						return;
					}
					clearInterval(t);
					send({}, "tool_calls");
					done(60);
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			} else if (text === "seq3") {
				const think = Array.from({ length: 40 }, (_, i) => `think${i + 1}${(i + 1) % 12 === 0 ? ".\n" : " "}`);
				const call = {
					index: 0,
					id: "call_s3" + Math.random().toString(36).slice(2, 6),
					type: "function",
					function: { name: "bash", arguments: "" },
				};
				const argStr = JSON.stringify({ command: "echo hi", description: "Say hi" });
				let k = 0;
				const t = setInterval(() => {
					if (k < think.length) {
						send({ reasoning_content: think[k++] });
						return;
					}
					if (k === think.length) {
						send({ tool_calls: [call] });
						k++;
						return;
					}
					const off = (k - think.length - 1) * 20;
					if (off < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(off, off + 20) } }] });
						k++;
						return;
					}
					clearInterval(t);
					send({}, "tool_calls");
					done(60);
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			} else if (text === "direct") tool = { name: "playwright_browser_tabs", args: { action: "list" } };
			else if (text === "script")
				tool = {
					name: "mcpScript",
					args: {
						code: '// Skill workflow: direct calls, logic between calls\nconst report = { checkedAt: new Date().toISOString() };\nconst page = await tools.call("playwright_browser_evaluate", { function: "() => document.title" });\nif (!page.ok) return { error: "page evaluate failed" };\nreturn report;',
					},
				};
			else if (text === "mcp")
				tool = { name: "mcp", args: { tool: "list_files", server: "nowhere", args: { path: "/tmp" } } };
			else if (/^Reply with a short/.test(text))
				words =
					"Hello from Muffin the cat, who greets you warmly from the bakery doorstep this fine morning.\n\nShe purrs, stretches, and hopes you have a lovely day full of sunshine and cinnamon.".split(
						/(?<= )/,
					);
			else if (text === "mdwide")
				words =
					"Here it is:\n\n```\nThe old ferry terminal had been closed for eleven years, but every morning at six, Dario still unlocked the gate and swept the pier. He told people it was habit, though habit did not explain why he painted the railings every spring.\nOne October morning, a woman in a yellow raincoat was waiting at the gate before he arrived. She held a ticket from the last year the ferries ran, softened at the corners from being kept in a wallet.\n```\n\nDone.".split(
						/(?<= )/,
					);
			else if (text === "md")
				words =
					"# Title one\n\nA paragraph with `code` and **bold** words.\n\n## Section two\n\nMore prose here.\n\n### Detail three\n\n- a bullet\n- another\n\n#### Deep four\n\n##### Five here\n\n###### Six deep\n\n```js\nconst a = 1;\nconst bb = a + 1;\n```\n\nWrapped label: [The 1883 eruption of Krakatoa — one of the deadliest and most destructive volcanic events in recorded history, full article with references and notes](https://en.wikipedia.org/wiki/1883_eruption_of_Krakatoa)\n\nSaved to /tmp/wd-manual/probe-target.md. A long link: (https://en.wikipedia.org/wiki/List_of_longest_place_names#Longest_single-word_place_names?query=rendering-test&session=abc123def456ghi789jkl0mno&tracking=utm_source%3Dpi-tui%26utm_medium%3Dterminal)\n\nEnd.".split(
						/(?<= )/,
					);
			else if (/^\[message from session_/.test(text)) words = ["Hello ", "back ", "from ", "this ", "session."];
			else if (/^\[Background |^\[agent result|^\[background results|^(Background bash|Subagent |Agent )/.test(text))
				words = ["Got ", "the ", "background ", "result, ", "thanks."];
			else words = longText;
			if (tool) {
				const call = {
					index: 0,
					id: "call_" + id.slice(-6),
					type: "function",
					function: { name: tool.name, arguments: "" },
				};
				send({ tool_calls: [call] });
				const argStr = JSON.stringify(tool.args);
				let i = 0;
				const t = setInterval(() => {
					if (i < argStr.length) {
						send({ tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + 20) } }] });
						i += 20;
						return;
					}
					clearInterval(t);
					send({}, "tool_calls");
					done(20);
				}, INTERVAL);
				res.on("close", () => clearInterval(t));
				return;
			}
			let i = 0;
			const t = setInterval(() => {
				if (i < words.length) {
					send({ content: words[i++] });
					return;
				}
				clearInterval(t);
				send({}, "stop");
				done(words.length);
			}, INTERVAL);
			res.on("close", () => clearInterval(t));
		});
	})
	.listen(PORT, "127.0.0.1", () => console.log("mock llm on", PORT));
