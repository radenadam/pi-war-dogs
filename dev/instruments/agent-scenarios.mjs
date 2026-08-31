// Scenarios for dev/instruments/agent-harness.mjs — each an async function (h, args).
// Read the harness header for the handle. Every scenario prints what it
// saw; the judgement is made against the transcripts it dumps.

/** A run, its delivery, nothing else — proves the rig. */
export async function smoke(h) {
	const r = await h.call({ title: "smoke", message: "say hello-from-child" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	await h.sleep(2500);
	h.dumpTranscript("child", h.childFile(id));
}

/**
 * 1(a): the model MESSAGES a run busy with a USER-driven run-view turn.
 * The user's turn owns the run (promptRun with no onAccepted, mod.ts); the
 * model's message joins it as a steer. Watch: the receipt, the child's
 * transcript (was the steer read and answered?), and whether ANY delivery
 * ever brings that reply to the model.
 */
export async function usersteer(h) {
	const r = await h.call({ title: "user turn probe", message: "say first-reply" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	await h.sleep(300);
	// The user types at the run view: a turn the tool did not start.
	void h.userChat(id, "sleep 4").catch((e) => h.log(`userChat threw: ${e?.message}`));
	await h.untilState(id, "working");
	await h.onceEvent(id, "tool_execution_start");
	// The model messages the busy run (steer): the receipt promises a reply.
	const m = await h.call({ action: "message", to: id, message: "say steer-reply" });
	h.log(`receipt: ${m.text.split("\n")[0]}`);
	await h.untilState(id, ["idle", "error", "stopped"], 40_000);
	await h.sleep(3000);
	h.log(`deliveries so far: ${h.deliveries.length}`);
	h.dumpTranscript("child", h.childFile(id));
}

/**
 * 1(b): doMessage's idle path swallows a send failure. Fault-inject on the
 * child's session.prompt the two ways pi can throw: (mode=preflight) after
 * calling preflightResult(false) — pi's own catch path, agent-session.js
 * prompt(): `catch (error) { preflightResult?.(false); throw error; }` —
 * and (mode=early) before any preflight callback at all.
 */
export async function sendfail(h, [mode = "preflight"]) {
	const r = await h.call({ title: "sendfail probe", message: "say the-previous-reply" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	await h.sleep(300);
	// Rebuild the released session first so we can wrap its prompt.
	const session = await h.mods.S.ensureSession(id);
	const orig = session.prompt.bind(session);
	let armed = true;
	session.prompt = async (text, options) => {
		if (!armed) return orig(text, options);
		armed = false;
		if (mode === "preflight") options?.preflightResult?.(false);
		throw new Error("forced send failure (auth/compaction shape)");
	};
	const m = await h.call({ action: "message", to: id, message: "say never-sent" });
	h.log(`receipt: ${m.text.split("\n")[0]}`);
	await h.sleep(4000);
	h.log(`state now: ${h.state(id)} error=${h.runOf(id)?.error}`);
	h.log(`deliveries: ${h.deliveries.length}`);
	for (const d of h.deliveries) h.log(`  delivered: ${d.text.split("\n").slice(0, 4).join(" | ")}`);
	h.dumpTranscript("child", h.childFile(id));
}

/**
 * The tail race (hypothesis from reading sendToRun): a message that lands
 * between the child's agent_settled (isStreaming false) and the tool's
 * settle() (session released) is judged "join a turn", finds nothing
 * streaming, takes the turn ITSELF — on a session that settle() has since
 * disposed. Fire the message from inside the child's agent_settled event.
 */
export async function tailrace(h) {
	const r = await h.call({ title: "tail race probe", message: "sleep 2" });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	const settled = h.onceEvent(id, "agent_settled");
	await settled;
	h.log(`agent_settled seen; status=${h.state(id)} isStreaming=${h.rec(id)?.session?.isStreaming}`);
	const m = await h.call({ action: "message", to: id, message: "say after-the-tail" });
	h.log(`receipt: ${m.text.split("\n")[0]}`);
	await h.sleep(200);
	h.log(`status after message: ${h.state(id)} session=${!!h.rec(id)?.session}`);
	await h.untilState(id, ["idle", "error", "stopped"], 30_000);
	await h.sleep(3500);
	h.log(`deliveries: ${h.deliveries.length}`);
	for (const d of h.deliveries) h.log(`  delivered: ${d.text.split("\n").slice(0, 5).join(" | ")}`);
	h.dumpTranscript("child", h.childFile(id));
}

/**
 * A message to a QUEUED run (concurrency 1 at the top level): the run has
 * no session and no transcript yet. doMessage's working path takes
 * "queued" as "working" and fires promptRun — which needs a transcript.
 */
export async function queuedmsg(h) {
	const fs = await import("node:fs");
	const p = `${process.env.PI_CODING_AGENT_DIR}/settings.json`;
	const saved = fs.readFileSync(p, "utf8");
	fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(saved), agent: { concurrency: 1 } }));
	try {
		const a = await h.call({ title: "slot holder", message: "sleep 4" });
		const b = await h.call({ title: "queued one", message: "say queued-reply" });
		const idB = h.runIdOf(b);
		h.log(`B state: ${h.state(idB)}`);
		const m = await h.call({ action: "message", to: idB, message: "say never-seen" });
		h.log(`receipt: ${m.text.split("\n")[0]}`);
		await h.untilState(h.runIdOf(a), "idle");
		await h.untilState(idB, ["idle", "error", "stopped"], 30_000);
		await h.sleep(3000);
		h.log(`B final: ${h.state(idB)} error=${h.runOf(idB)?.error}`);
		h.dumpTranscript("child B", h.childFile(idB));
	} finally {
		fs.writeFileSync(p, saved);
	}
}

/* ======================= combinations (section 2) ======================= */

/**
 * wait + message + ask interleaved on ONE run, then a message to the idle
 * run. Expect: wait returns the turn's reply once (claimed, no delivery);
 * ask answers from the snapshot; the follow-up message's reply is
 * delivered exactly once (the claim was per-turn).
 */
export async function interleave(h) {
	const r = await h.call({ title: "interleave", message: "sleep 5" });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	const w = h.call({ action: "wait", to: [id] });
	await h.sleep(300);
	const m = await h.call({ action: "message", to: id, message: "say steered-in" });
	h.log(`receipt: ${m.text.split("\n")[0]}`);
	const a = await h.call({ action: "ask", to: id, question: "What were you asked to do, in five words?" });
	h.log(`ask answer: ${a.text.split("\n")[0]}`);
	const wr = await w;
	h.log(`wait returned:\n${wr.text.split("\n").slice(0, 6).join("\n")}`);
	await h.sleep(2500);
	h.log(`deliveries after wait: ${h.deliveries.length} (expect 0)`);
	const m2 = await h.call({ action: "message", to: id, message: "say second-turn" });
	h.log(`receipt2: ${m2.text.split("\n")[0]}`);
	await h.untilState(id, "idle");
	await h.sleep(2500);
	h.log(`deliveries after second turn: ${h.deliveries.length} (expect 1)`);
	h.dumpTranscript("child", h.childFile(id));
}

/**
 * Two waits on one run + a message; then the same with the SECOND wait
 * interrupted (its call signal aborted) — an interrupted wait un-claims,
 * which must not turn the first wait's consumed reply into a delivery.
 */
export async function twowaits(h, [mode = "both"]) {
	const r = await h.call({ title: "two waits", message: "sleep 5" });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	const c2 = new AbortController();
	const w1 = h.call({ action: "wait", to: [id] });
	const w2 = h.call({ action: "wait", to: [id] }, { controller: c2 });
	await h.sleep(300);
	await h.call({ action: "message", to: id, message: "say steered-in" });
	if (mode === "interrupt") {
		await h.sleep(500);
		c2.abort();
	}
	const [r1, r2] = await Promise.all([w1, w2]);
	h.log(`wait1: ${r1.text.split("\n").slice(0, 3).join(" | ")}`);
	h.log(`wait2: ${r2.text.split("\n").slice(0, 3).join(" | ")}`);
	await h.sleep(2500);
	h.log(`deliveries: ${h.deliveries.length} (expect ${mode === "interrupt" ? "0 — wait1 consumed it" : "0"})`);
}

/** stop while QUEUED, stop during BUILD, stop during a STEERED turn. */
export async function stops(h) {
	const fs = await import("node:fs");
	const p = `${process.env.PI_CODING_AGENT_DIR}/settings.json`;
	const saved = fs.readFileSync(p, "utf8");
	fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(saved), agent: { concurrency: 1 } }));
	try {
		const a = await h.call({ title: "holder", message: "sleep 3" });
		const b = await h.call({ title: "queued victim", message: "say never" });
		const idB = h.runIdOf(b);
		const s1 = await h.call({ action: "stop", to: idB });
		h.log(`stop queued: ${s1.text.split("\n")[0]} → state ${h.state(idB)}`);
		await h.untilState(h.runIdOf(a), "idle");
	} finally {
		fs.writeFileSync(p, saved);
	}
	// During BUILD: stop in the same tick the run is recorded.
	const c = await h.call({ title: "build victim", message: "sleep 3" });
	const idC = h.runIdOf(c);
	const s2 = await h.call({ action: "stop", to: idC });
	h.log(`stop in build: ${s2.text.split("\n")[0]}`);
	await h.untilState(idC, ["stopped", "error", "idle"], 20_000);
	h.log(`build victim → ${h.state(idC)} error=${h.runOf(idC)?.error}`);
	// During a STEERED turn.
	const d = await h.call({ title: "steer victim", message: "sleep 4" });
	const idD = h.runIdOf(d);
	await h.untilStreaming(idD);
	await h.onceEvent(idD, "tool_execution_start");
	const m = await h.call({ action: "message", to: idD, message: "say steered" });
	h.log(`steer receipt: ${m.text.split("\n")[0]}`);
	await h.sleep(300);
	const s3 = await h.call({ action: "stop", to: idD });
	h.log(`stop steered: ${s3.text.split("\n")[0]}`);
	await h.untilState(idD, ["stopped", "error", "idle"], 20_000);
	h.log(`steer victim → ${h.state(idD)} error=${h.runOf(idD)?.error}`);
	await h.sleep(2500);
	h.log(`deliveries: ${h.deliveries.length}`);
	h.dumpTranscript("steer victim", h.childFile(idD));
}

/** Claims across three consecutive turns: run→wait, message→wait, message→delivery. */
export async function claims3(h) {
	const r = await h.call({ title: "claims", message: "say one" });
	const id = h.runIdOf(r);
	const w1 = await h.call({ action: "wait", to: [id] });
	h.log(`wait1: ${w1.text.split("\n")[2]}`);
	await h.sleep(2200);
	h.log(`deliveries after wait1: ${h.deliveries.length} (expect 0)`);
	await h.call({ action: "message", to: id, message: "say two" });
	const w2 = await h.call({ action: "wait", to: [id] });
	h.log(`wait2: ${w2.text.split("\n")[2]}`);
	await h.sleep(2200);
	h.log(`deliveries after wait2: ${h.deliveries.length} (expect 0)`);
	await h.call({ action: "message", to: id, message: "say three" });
	await h.untilState(id, "idle");
	await h.sleep(2200);
	h.log(`deliveries after turn 3: ${h.deliveries.length} (expect 1, body "three")`);
	const st = await h.call({ action: "status", to: id });
	h.log(`status: ${st.text.split("\n").slice(0, 4).join(" | ")}`);
}

/* ======================= thinking carriage (3b), mock wire ======================= */

/** ask over a run whose transcript holds thinking: inspect the DUMP for the ask request. */
export async function askthink(h) {
	const r = await h.call({ title: "ask think", message: "think then sleep 3" });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	await h.onceEvent(id, "tool_execution_start");
	const a = await h.call({ action: "ask", to: id, question: "What are you doing right now?" });
	h.log(`ask (live): ${a.text.split("\n")[0]}`);
	await h.untilState(id, "idle");
	await h.sleep(1500);
	const a2 = await h.call({ action: "ask", to: id, question: "What did you do?" });
	h.log(`ask (released): ${a2.text.split("\n")[0]}`);
	h.dumpTranscript("child", h.childFile(id));
}

/** A run continued by message (idle) and steered mid-flight: what the next request carries. */
export async function continuethink(h) {
	const r = await h.call({ title: "continue think", message: "think then sleep 2" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	await h.sleep(500);
	await h.call({ action: "message", to: id, message: "think then sleep 2" });
	await h.untilStreaming(id);
	await h.onceEvent(id, "tool_execution_start");
	await h.call({ action: "message", to: id, message: "say steered-after-thinking" });
	await h.untilState(id, "idle");
	await h.sleep(2500);
	h.dumpTranscript("child", h.childFile(id));
}

/* ======================= real-model soak (section 3) =======================
 * These call a REAL model (the harness's agent dir). Effort is passed per
 * call so the soak stays cheap; the 3b probe forces high thinking. Judged on
 * behaviour and on the transcripts, not on a wire capture (the real wire
 * cannot be intercepted). */

/** Fan out past the concurrency cap, one schema run, message+ask+wait, all real. */
export async function soak(h, [effort = "low"]) {
	const fs = await import("node:fs");
	const p = `${process.env.PI_CODING_AGENT_DIR}/settings.json`;
	const saved = fs.readFileSync(p, "utf8");
	fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(saved), agent: { concurrency: 2 } }));
	try {
		h.log("--- fan-out of 4 with cap 2 (two must queue)");
		const ids = [];
		for (const n of [1, 2, 3, 4]) {
			const r = await h.call({
				title: `worker ${n}`,
				message: `In one short sentence, name fact #${n} about the number ${n}. Plain text, no preamble.`,
				effort,
			});
			ids.push(h.runIdOf(r));
			h.log(`  worker ${n}: ${h.state(ids[n - 1])}`);
		}
		const st = await h.call({ action: "status" });
		h.log(`bare status:\n${st.text.split("\n").slice(0, 8).join("\n")}`);
		for (const id of ids) await h.untilState(id, ["idle", "error", "stopped"], 120_000);
		await h.sleep(3000);
		h.log(`deliveries after fan-out: ${h.deliveries.length}`);
		for (const d of h.deliveries)
			h.log(
				`  D: ${d.text
					.split("\n")
					.filter((l) => l.trim())
					.slice(0, 3)
					.join(" | ")
					.slice(0, 160)}`,
			);

		h.log("--- a schema run (real)");
		const sr = await h.call({
			title: "schema real",
			effort,
			message: "Describe the planet Mars.",
			schema: {
				type: "object",
				properties: { name: { type: "string" }, moons: { type: "number" }, note: { type: "string" } },
				required: ["name", "moons"],
			},
		});
		const sid = h.runIdOf(sr);
		await h.untilState(sid, ["idle", "error"], 120_000);
		await h.sleep(2500);
		const sd = h.deliveries[h.deliveries.length - 1];
		h.log(`schema delivery body:\n${sd?.text.split("\n").slice(2, 12).join("\n")}`);

		h.log("--- message an idle run, then ask it, then wait");
		const m = await h.call({ action: "message", to: sid, message: "Now describe its largest moon in one sentence." });
		h.log(`msg receipt: ${m.text.split("\n")[0]}`);
		await h.untilState(sid, ["idle", "error"], 120_000);
		await h.sleep(2500);
		const a = await h.call({ action: "ask", to: sid, question: "In five words, what have I asked you about?" });
		h.log(`ask answer: ${h.firstLine ? "" : ""}${a.text.split("\n")[0]}`);
		h.dumpTranscript("schema-real child", h.childFile(sid));
	} finally {
		fs.writeFileSync(p, saved);
	}
}

/** 3b real probe: a thinking-heavy child continued TWICE; judge coherence, not the wire. */
export async function realthink(h, [effort = "high"]) {
	const r = await h.call({
		title: "thinking heavy",
		effort,
		message:
			"Think step by step, then answer: I have 3 boxes; box A has twice box B, box C has 5 more than A, total 45. How many in each? Show the final counts on one line.",
	});
	const id = h.runIdOf(r);
	await h.untilState(id, ["idle", "error"], 180_000);
	await h.sleep(2500);
	h.log(`turn 1 delivery:\n${h.deliveries.at(-1)?.text.split("\n").slice(2, 8).join("\n")}`);
	const m1 = await h.call({
		action: "message",
		to: id,
		message: "Now double every count and give me the new three numbers on one line.",
	});
	h.log(`continue 1 receipt: ${m1.text.split("\n")[0]}`);
	await h.untilState(id, ["idle", "error"], 180_000);
	await h.sleep(2500);
	h.log(`turn 2 delivery:\n${h.deliveries.at(-1)?.text.split("\n").slice(2, 8).join("\n")}`);
	const m2 = await h.call({
		action: "message",
		to: id,
		message: "Now sum those three doubled numbers. Answer with the single total only.",
	});
	h.log(`continue 2 receipt: ${m2.text.split("\n")[0]}`);
	await h.untilState(id, ["idle", "error"], 180_000);
	await h.sleep(2500);
	h.log(`turn 3 delivery:\n${h.deliveries.at(-1)?.text.split("\n").slice(2, 8).join("\n")}`);
	h.dumpTranscript("thinking child", h.childFile(id));
	// The coherence test: 45 total → B=10,A=20,C=25; doubled 20,40,50; sum 110.
	h.log("EXPECT: turn1 A=20 B=10 C=25; turn2 20 40 50; turn3 110");
}

/** Deliveries racing /new: a reply queued in the batch window when the session
 *  ends must be flushed into THIS transcript (stress audit #14), not lost. */
export async function flushrace(h) {
	const r = await h.call({ title: "flush race", message: "say landed-before-new" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	// The reply is now queued in the (long) delivery window; end the session
	// before it closes. shutdown() flushes then clears (index.ts order).
	h.log(`deliveries before shutdown: ${h.deliveries.length} (window still open)`);
	await h.shutdown();
	await h.sleep(500);
	h.log(`deliveries after shutdown flush: ${h.deliveries.length}`);
	const inMain = await h.agentResultsInMain();
	h.log(`agent-result rows in MAIN transcript: ${inMain.length} — ${inMain.map((e) => e.text).join(" ; ")}`);
}

/* ======================= the doctrine A/B (2026-08-25) =======================
 * Same tool, same model, same tasks; the ONLY difference is WD_DOCTRINE=1
 * weaving the draft-9 doctrine into the description (harness). Real model.
 * Behaviours judged from the transcripts: delegation on forks, non-delegation
 * of the trivial, re-tasking vs fresh spawn, verification against artifacts,
 * world-carrying briefs. */
export async function ab(h, [task = "t1"]) {
	h.log(`AB variant=${process.env.WD_DOCTRINE === "1" ? "DOCTRINE" : "STOCK"} task=${task} cwd=${process.cwd()}`);
	const R = h.mods.R;
	const busy = () =>
		h.main().isStreaming ||
		[...R.registry.values()].some((r) => r.run.status === "working" || r.run.status === "queued");
	const quiet = async () => {
		const end = Date.now() + 420_000;
		for (;;) {
			if (Date.now() > end) throw new Error("quiet timeout");
			if (!busy()) {
				await h.sleep(3500); // the delivery window + a triggered turn's start
				if (!busy()) return;
			}
			await h.sleep(500);
		}
	};
	if (task === "t1") {
		await h.mainPrompt(
			"In src/ there are a.py, b.py and c.py. Two things, and they are independent — I want them done at the same time: (1) a short comparison of how a.py and b.py handle errors; (2) a bug audit of c.py. Give me both results.",
		);
		await quiet();
	} else if (task === "t2") {
		await h.mainPrompt(
			"Quick: what's 4+4? And in the sentence 'i love paris', is 'paris' capitalised correctly as a city name?",
		);
		await quiet();
	} else if (task === "t3") {
		await h.mainPrompt(
			"Use one agent (title it how you like) to create summary.md here, summarising what files exist under src/. Tell me when it's done.",
		);
		await quiet();
		await h.mainPrompt("Good. I also need INDEX.md — the same file list but alphabetical, one per line. Handle it.");
		await quiet();
	} else if (task === "t4") {
		await h.mainPrompt(
			"Have an agent create exactly the file greeting.txt containing the single line 'salve munde'. Then tell me whether it was done correctly.",
		);
		await quiet();
	} else if (task === "t5") {
		await h.mainPrompt(
			"Context for later work: our project is called war-dogs — a full-screen terminal cockpit riding on the pi coding agent; it re-skins the screen and adds agent tooling. Just acknowledge for now.",
		);
		await quiet();
		await h.mainPrompt(
			"Now have an agent write welcome.md — three sentences welcoming a newcomer to our project and saying what it is. Let me know when it exists.",
		);
		await quiet();
	}
	// ---- evidence dump ----
	const mine = [...R.registry.values()].map((r) => r.run);
	h.log(`RUNS: ${mine.length}`);
	for (const r of mine) {
		h.log(`--- run ${r.id} · ${r.agent} · "${r.title}" · ${r.status}`);
		console.log("TASK BRIEF >>>");
		console.log(r.task);
		console.log("<<<");
	}
	h.dumpTranscript("main", h.mainFile());
	for (const r of mine) {
		try {
			h.dumpTranscript(`child ${r.id}`, h.childFile(r.id));
		} catch {}
	}
	const fs = await import("node:fs");
	h.log(`files in cwd after: ${fs.readdirSync(process.cwd()).join(", ")}`);
}

/* Write-collision probe (2026-08-25): the prompt FORCES two agents at one
 * file. Judged on: does main partition (separate files, merge itself),
 * serialise (one after the other), or let them collide — and does the
 * shipped write-collision clause change that vs the stripped description. */
export async function wc(h) {
	const fs = await import("node:fs");
	h.log(`WC variant=${process.env.WD_DOCTRINE === "strip" ? "STRIPPED" : "SHIPPED"} cwd=${process.cwd()}`);
	fs.writeFileSync("CHANGELOG.md", "# Changelog\n");
	const R = h.mods.R;
	const busy = () =>
		h.main().isStreaming ||
		[...R.registry.values()].some((r) => r.run.status === "working" || r.run.status === "queued");
	const quiet = async () => {
		const end = Date.now() + 420_000;
		for (;;) {
			if (Date.now() > end) throw new Error("quiet timeout");
			if (!busy()) {
				await h.sleep(3500);
				if (!busy()) return;
			}
			await h.sleep(500);
		}
	};
	await h.mainPrompt(
		"Two independent entries need adding to CHANGELOG.md here: one short entry describing feature A (the pager), one describing feature B (the peers). Use two agents in parallel for this.",
	);
	await quiet();
	const mine = [...R.registry.values()].map((r) => r.run);
	h.log(`RUNS: ${mine.length}`);
	for (const r of mine) {
		h.log(`--- run ${r.id} · "${r.title}" · ${r.status}`);
		console.log("TASK BRIEF >>>");
		console.log(r.task);
		console.log("<<<");
	}
	h.dumpTranscript("main", h.mainFile());
	h.log("CHANGELOG.md after:");
	console.log(fs.readFileSync("CHANGELOG.md", "utf8"));
	h.log(`files: ${fs.readdirSync(".").join(", ")}`);
}

/** Generic single-prompt cell: WD_AB_PROMPT through main, evidence dumped. */
export async function abprompt(h) {
	const prompt = process.env.WD_AB_PROMPT;
	if (!prompt) throw new Error("WD_AB_PROMPT not set");
	const R = h.mods.R;
	const busy = () =>
		h.main().isStreaming ||
		[...R.registry.values()].some((r) => r.run.status === "working" || r.run.status === "queued");
	const quiet = async () => {
		const end = Date.now() + 420_000;
		for (;;) {
			if (Date.now() > end) throw new Error("quiet timeout");
			if (!busy()) {
				await h.sleep(3500);
				if (!busy()) return;
			}
			await h.sleep(500);
		}
	};
	await h.mainPrompt(prompt);
	await quiet();
	const mine = [...R.registry.values()].map((r) => r.run);
	h.log(`RUNS: ${mine.length}`);
	for (const r of mine) {
		h.log(`--- run ${r.id} · "${r.title}" · ${r.status}`);
		console.log("TASK BRIEF >>>");
		console.log(r.task);
		console.log("<<<");
	}
	h.dumpTranscript("main", h.mainFile());
}

/**
 * 2026-08-28 hygiene (the stress report's A2, A4, B16 and the
 * extensions-by-call probe): `tools` is an exact allowlist; `extensions`
 * in a CALL is ignored; a named agent naming war-dogs itself is refused
 * with a note; a child's system prompt carries SUBAGENT_APPEND_SYSTEM.md
 * and never APPEND_SYSTEM.md (checked in the mock's DUMP by the runner).
 */
export async function hygiene(h) {
	const task = "Reply with a short two-paragraph greeting about a cat named Muffin.";
	const r1 = await h.call({ title: "tools exact", message: task, tools: ["read"] });
	const id1 = h.runIdOf(r1);
	await h.untilStreaming(id1);
	h.log(`active tools with tools:["read"]: ${JSON.stringify(h.rec(id1)?.session?.getActiveToolNames?.())}`);
	await h.untilState(id1, ["idle", "error", "stopped"]);
	const r2 = await h.call({ title: "ext probe", message: task, extensions: ["/tmp/evil-ext.ts"] });
	const id2 = h.runIdOf(r2);
	h.log(`config.extensions on the run: ${JSON.stringify(h.runOf(id2)?.config?.extensions)}`);
	await h.untilState(id2, ["idle", "error", "stopped"]);
	const r3 = await h.call({ title: "own ext refused", message: task, agent: "wd" });
	const id3 = h.runIdOf(r3);
	if (id3) {
		await h.untilState(id3, ["idle", "error", "stopped"]);
		await h.sleep(2500);
	} else h.log(`named agent wd: ${h.firstLine(r3.text)}`);
	for (const d of h.deliveries) {
		h.log(`delivery: ${JSON.stringify(d).slice(0, 200)}`);
		for (const line of String(d.text ?? "").split("\n")) if (/^note:/.test(line)) h.log(`  ${line}`);
	}
}

/**
 * 2026-08-28 timers (the stress report's A9 and B4): a run queued behind
 * a slow one must not time out while it waits (settings agent.concurrency
 * 1 for this scenario); a run re-tasked with a long second turn under a
 * short timeout must time out on THAT turn (the timer re-arms per turn).
 */
export async function timers(h) {
	const greet = "Reply with a short two-paragraph greeting about a cat named Muffin.";
	const a = await h.call({ title: "slow one", message: "Run bash sleep 6 then reply done.", timeout_s: 20 });
	const b = await h.call({ title: "queued short", message: greet, timeout_s: 2 });
	const ib = h.runIdOf(b);
	h.log(`b right away: ${h.state(ib)}`);
	await h.untilState(ib, ["idle", "stopped", "error"], 45_000);
	h.log(`b final: ${h.state(ib)} error=${h.runOf(ib)?.error ?? "-"}`);
	await h.untilState(h.runIdOf(a), ["idle", "stopped", "error"], 45_000);
	const c = await h.call({ title: "per turn", message: greet, timeout_s: 3 });
	const ic = h.runIdOf(c);
	await h.untilState(ic, ["idle"], 45_000);
	await h.call({ action: "message", to: ic, message: "Run bash sleep 6 then reply done." });
	await h.untilState(ic, ["idle", "stopped", "error"], 45_000);
	h.log(`c after a long second turn: ${h.state(ic)} error=${h.runOf(ic)?.error ?? "-"}`);
}

/** 2026-08-28 the reply cap (A12, B5): run with WORDS=40000 INTERVAL=0 on the mock; the delivery must carry the file note. */
export async function bigreply(h) {
	const r = await h.call({ title: "big reply", message: "tell me everything you know" });
	const id = h.runIdOf(r);
	await h.untilState(id, ["idle", "stopped", "error"], 120_000);
	await h.sleep(2500);
	for (const d of h.deliveries) {
		const text = String(d.text ?? "");
		h.log(`delivery ${text.length} chars`);
		for (const line of text.split("\n")) if (/^\[reply truncated/.test(line)) h.log(`  ${line}`);
	}
}

/**
 * 2026-08-28 THE LEAD RULE (scenario 155/46): a depth-1 lead whose task is
 * "sub" starts one worker and ends its turn at once ("Tool result
 * received."). Its reply must NOT reach main then: status says it waits on
 * its team, the worker's reply wakes it (an agent-result in ITS
 * transcript), and main receives ONE delivery, the woken turn's answer.
 */
export async function leadrule(h) {
	const r = await h.call({ title: "lead of one", message: "subslow", depth: 1 });
	const lead = h.runIdOf(r);
	// the worker appears under the lead
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	h.log(`worker: ${worker} (${h.state(worker)})`);
	await h.sleep(1500);
	const st = await h.call({ action: "status", to: lead });
	h.log(`lead status while its worker works: ${h.firstLine(st.text)}`);
	h.log(`deliveries so far: ${h.deliveries.length} (must be 0)`);
	await h.untilState(lead, ["idle", "stopped", "error"], 60_000);
	await h.sleep(2500);
	h.log(`deliveries after the lead settled: ${h.deliveries.length} (must be 1)`);
	for (const d of h.deliveries)
		h.log(
			`delivery: ${h.firstLine(
				String(d.text ?? "")
					.split("\n")
					.slice(2)
					.join(" | "),
			)}`,
		);
	h.dumpTranscript("lead", h.childFile(lead));
}

/** 2026-08-28 reach (A5, B7): a child that waits on ITSELF (the mock's status-then-wait flow as its task) is refused, never hung. */
export async function reachself(h) {
	const r = await h.call({ title: "self waiter", message: "waitwork", depth: 1 });
	const id = h.runIdOf(r);
	await h.untilState(id, ["idle", "stopped", "error"], 45_000);
	h.log(`self waiter: ${h.state(id)}`);
	h.dumpTranscript("child", h.childFile(id));
}

/** 2026-08-29 the interrupt episode: Esc (no report), the user's follow-up reply travels, a principal message ends the episode. */
export async function interruptflow(h) {
	const r = await h.call({ title: "interrupt me", message: "Run bash sleep 6 then reply done." });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	await h.sleep(1500);
	h.log(`interruptRun -> ${h.mods.R.interruptRun(id, { team: false }).result}`);
	await h.untilState(id, ["idle", "stopped", "error"], 20_000);
	await h.sleep(2500);
	h.log(
		`after Esc: state=${h.state(id)} deliveries=${h.deliveries.length} (must be 0) followUpArmed=${!!h.rec(id)?.interrupt?.onFollowUp}`,
	);
	await h.userChat(id, "you're good, test done");
	await h.untilState(id, ["idle", "stopped", "error"], 20_000);
	await h.sleep(2500);
	h.log(`after the follow-up: deliveries=${h.deliveries.length} (must be 1)`);
	for (const d of h.deliveries)
		h.log(
			`delivery: ${h.firstLine(
				String(d.text ?? "")
					.split("\n")
					.slice(2)
					.join(" | "),
			)}`,
		);
}

/**
 * 2026-08-29 THE INTERRUPTED LEAD (the maintainer's silent loss): a depth-1
 * lead whose task starts a slow worker, checks it and waits on it ("substat");
 * Esc on the lead mid-wait; the user's follow-up in its view; the worker
 * finishes. The lead must settle idle at once (the hold ends with the
 * interrupt), the follow-up's turn holds for the worker (the lead rule), and
 * main must receive exactly ONE delivery, the follow-up's reply. Before:
 * the follow-up rode the held path, the owner path read the whole episode
 * as the interrupt after the hold, and main was never told.
 */
export async function leadinterrupt(h) {
	const r = await h.call({ title: "lead", message: "substat", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.sleep(2000);
	h.log(`interruptRun(lead) -> ${h.mods.R.interruptRun(lead, { team: false }).result}`);
	await h.untilState(lead, ["idle", "stopped", "error"], 5_000);
	await h.sleep(500);
	h.log(
		`after Esc: lead=${h.state(lead)} worker=${h.state(worker)} deliveries=${h.deliveries.length} episode=${h.rec(lead)?.interrupt?.phase ?? "closed"}`,
	);
	if (h.state(lead) !== "idle" || h.deliveries.length !== 0)
		throw new Error("the interrupt must settle the lead idle with nothing delivered");
	await h.userChat(lead, "you still there?");
	await h.untilState(worker, ["idle", "stopped", "error"], 40_000);
	await h.untilState(lead, ["idle", "stopped", "error"], 40_000);
	await h.sleep(3000);
	const rec = h.rec(lead);
	h.log(
		`END: lead=${h.state(lead)} deliveries=${h.deliveries.length} (must be 1) episode=${rec?.interrupt?.phase ?? "closed"} timer=${!!rec?.interrupt?.timer}`,
	);
	for (const d of h.deliveries)
		h.log(
			`delivery: ${h.firstLine(
				String(d.text ?? "")
					.split("\n")
					.slice(2)
					.join(" | "),
			)}`,
		);
	if (h.deliveries.length !== 1) throw new Error(`expected 1 delivery to main, got ${h.deliveries.length}`);
	if (rec?.interrupt) throw new Error("the episode must be closed by the follow-up");
	h.dumpTranscript("lead", h.childFile(lead));
}

/**
 * 2026-08-29 alt+x on a lead: its team is stopped and NOTHING wakes it (the
 * maintainer's rule). The stopped worker's report parks on the lead's record
 * (pendingDeliveries), the lead's transcript gains no turn, main hears
 * nothing; the user's follow-up appends the parked report ahead of its turn
 * and its reply is the one delivery. Before: the report woke the lead into a
 * turn of its own right after the user had stopped it.
 */
export async function leadaltx(h) {
	const r = await h.call({ title: "lead", message: "substat", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.sleep(2000);
	h.log(`interruptRun(lead, team) -> ${JSON.stringify(h.mods.R.interruptRun(lead, { team: true }))}`);
	await h.untilState(lead, ["idle", "stopped", "error"], 5_000);
	await h.untilState(worker, ["idle", "stopped", "error"], 10_000);
	await h.sleep(2500);
	const assistants = (file) => h.transcript(file).filter((e) => e.role === "assistant").length;
	const before = assistants(h.childFile(lead));
	const parked = h.rec(lead)?.pendingDeliveries?.length ?? 0;
	h.log(
		`after alt+x: lead=${h.state(lead)} worker=${h.state(worker)} parked=${parked} deliveries=${h.deliveries.length} leadAssistantMsgs=${before}`,
	);
	if (h.state(lead) !== "idle" || h.state(worker) !== "stopped")
		throw new Error("alt+x must leave the lead idle and its worker stopped");
	if (parked !== 1 || h.deliveries.length !== 0)
		throw new Error(`the stopped worker's report must park (parked=${parked}, deliveries=${h.deliveries.length})`);
	await h.userChat(lead, "go on");
	await h.untilState(lead, ["idle", "stopped", "error"], 20_000);
	await h.sleep(2500);
	const t = h.transcript(h.childFile(lead));
	const custom = t.filter((e) => /agent-result/.test(e.role)).length;
	h.log(
		`after the follow-up: deliveries=${h.deliveries.length} (must be 1) parkedNow=${h.rec(lead)?.pendingDeliveries?.length ?? 0} agent-result rows in the lead=${custom} assistantMsgs=${assistants(h.childFile(lead))}`,
	);
	if (h.deliveries.length !== 1 || custom !== 1)
		throw new Error("the follow-up must flush the parked report and deliver once");
	h.dumpTranscript("lead", h.childFile(lead));
}

/**
 * 2026-08-29 a PARALLEL BATCH in a child: two calls in one message, a fast
 * echo and a 6 s sleep. pi appends the batch's results to the agent's state
 * only after the slow one, so the run view read the fast one as still
 * running for six seconds; agents/stream.ts captures each result's
 * message_end as it lands (liveToolResults) and the view merges it in.
 */
export async function parallelbatch(h) {
	const r = await h.call({ title: "batch", message: "twocalls" });
	const id = h.runIdOf(r);
	await h.untilStreaming(id);
	await h.sleep(2500);
	const rec = h.rec(id);
	const state = (rec?.session?.messages ?? []).filter((m) => m?.role === "toolResult").length;
	const live = rec?.liveToolResults?.size ?? 0;
	h.log(`@2.5s: toolResults in state=${state} captured live=${live}`);
	if (live < 1) throw new Error("the fast call's result must be captured before the slow one ends");
	await h.untilState(id, ["idle", "stopped", "error"], 30_000);
}

/**
 * 2026-08-29 THE USER STOPS A LEAD (the station's ✕ / ctrl+alt+x): every text
 * names who. A depth-1 lead (substat: a slow worker, status, wait) stopped by
 * the user mid-wait: the lead's wait reads "you were stopped, and <worker>
 * was stopped with you"; the worker's bash reads "Command aborted by the
 * user, who stopped your principal"; main's delivery reads "was stopped by
 * the user after Ns" with "(stopped by the user — no output)".
 */
export async function userstop(h) {
	const r = await h.call({ title: "lead", message: "substat", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.sleep(2500);
	h.log(
		`abortRun(lead, by the user) -> ${h.mods.R.abortRun(lead, h.mods.R.abortCause("stopped", "stopped by the user"))}`,
	);
	await h.untilState(lead, ["idle", "stopped", "error"], 15_000);
	await h.untilState(worker, ["idle", "stopped", "error"], 15_000);
	await h.sleep(3000);
	const fs = await import("node:fs");
	const grab = (file, re) => (re.exec(fs.readFileSync(file, "utf8")) ?? [""])[0];
	const leadWait = grab(h.childFile(lead), /Wait aborted by [^"\\]*/);
	const workerBash = grab(h.childFile(worker), /Command aborted by [^"\\]*/);
	const delivery = h.deliveries
		.map((d) =>
			h.firstLine(
				String(d.text ?? "")
					.split("\n")
					.slice(2)
					.join(" | "),
			),
		)
		.join(" || ");
	const family = (/family: [^\]]*/.exec(String(h.deliveries[0]?.text ?? "")) ?? [""])[0];
	h.log(`lead wait: ${leadWait}`);
	h.log(`worker bash: ${workerBash}`);
	h.log(`delivery: ${delivery}`);
	h.log(`family roll-up: ${family} (the worker died with the lead: never "still working")`);
	if (/still working/.test(family))
		throw new Error("a stopped lead's roll-up must not count its stopped worker as working");
	if (!/you were stopped, and agent_\S+ was stopped with you/.test(leadWait))
		throw new Error("the lead's wait must say it and its worker were stopped");
	if (!/by the user, who stopped your principal/.test(workerBash))
		throw new Error("the worker's abort must name the user through its principal");
	if (
		!/was stopped by the user after/.test(delivery) ||
		!/stopped by the user — no output|stopped by the user — the reply above is partial/.test(delivery)
	)
		throw new Error("main's delivery must name the user");
}

/** 2026-08-29 the keys on an IDLE lead whose worker still runs (after Esc): what ctrl+alt+x and alt+x do. */
export async function idlekeys(h) {
	const r = await h.call({ title: "lead", message: "substat", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.sleep(2000);
	h.mods.R.interruptRun(lead, { team: false });
	await h.untilState(lead, ["idle"], 5_000);
	h.log(`after Esc: lead=${h.state(lead)} worker=${h.state(worker)}`);
	const stop = h.mods.R.abortRun(lead, h.mods.R.abortCause("stopped", "stopped by the user"));
	await h.untilState(worker, ["stopped", "idle", "error"], 5_000);
	await h.sleep(1500);
	h.log(
		`ctrl+alt+x on the idle lead -> ${stop}; worker=${h.state(worker)} parked=${h.rec(lead)?.pendingDeliveries?.length ?? 0} deliveries=${h.deliveries.length} lead=${h.state(lead)}`,
	);
	if (stop !== true || h.state(worker) !== "stopped")
		throw new Error("a stop on an idle lead must stop its working team");
	const again = h.mods.R.abortRun(lead, h.mods.R.abortCause("stopped", "stopped by the user"));
	h.log(`ctrl+alt+x again, team gone -> ${again} (must be false: purely idle is a no-op)`);
	if (again !== false) throw new Error("a purely idle run must be a no-op");
	const fs = await import("node:fs");
	const workerBash = (/Command aborted by [^"\\]*/.exec(fs.readFileSync(h.childFile(worker), "utf8")) ?? [""])[0];
	h.log(`worker bash: ${workerBash}`);
}

/**
 * 2026-08-29 (the real-model audit, drive 2): a worker's reply that lands while
 * its lead STREAMS must be a steer the lead reads at its next tool boundary.
 * pi 0.84.4 defers a `triggerTurn:false` custom message sent to a streaming
 * session to the turn's end (`_pendingCustomMessages`, agent-session.js), and
 * the running loop works on a context SNAPSHOT (pi-agent-core agent.js
 * createContextSnapshot), so a deferred message reaches the transcript and
 * never the model of that run. The lead here starts a fast worker and blocks
 * five seconds in a bash; the worker's reply lands mid-bash. Read: the lead's
 * final text acknowledges the reply (the mock answers a delivery with "Got the
 * background result"), and main gets ONE delivery carrying it.
 */
export async function leadsteer(h) {
	const r = await h.call({ title: "steered lead", message: "subfastbusy", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.untilState(worker, ["idle", "stopped", "error"], 30_000);
	h.log(
		`worker settled (${h.state(worker)}) while the lead is ${h.state(lead)} (streaming=${!!h.rec(lead)?.session?.isStreaming})`,
	);
	await h.untilState(lead, ["idle", "stopped", "error"], 60_000);
	await h.sleep(2500);
	h.dumpTranscript("lead", h.childFile(lead));
	const t = h.transcript(h.childFile(lead));
	const lastAssistant = [...t].reverse().find((e) => e.role === "assistant");
	const resultAt = t.findIndex((e) => /agent-result/.test(e.role));
	const lastAt = t.lastIndexOf(lastAssistant);
	h.log(`lead's last text: ${lastAssistant?.text} (delivery at ${resultAt}, final text at ${lastAt})`);
	h.log(`deliveries to main: ${h.deliveries.length} (must be 1)`);
	if (resultAt < 0 || resultAt > lastAt)
		throw new Error("the worker's reply must sit in the lead's transcript before its final text");
	if (!/Got the background result/.test(lastAssistant?.text ?? ""))
		throw new Error(
			`the lead must READ the worker's reply in the same run (its final text was: ${lastAssistant?.text})`,
		);
	if (h.deliveries.length !== 1) throw new Error(`expected 1 delivery to main, got ${h.deliveries.length}`);
	if (!/Got the background result/.test(String(h.deliveries[0]?.text ?? "")))
		throw new Error("main's delivery must carry the lead's text that read the reply");
}

/**
 * 2026-08-29 A SESSION END IS A STOP, AND A CONTINUED LEAD IS TOLD. The
 * session ends (/reload, /new, quit: index.ts aborts every working run with
 * `stopped by the session ending (/<reason>)`) under a lead and its worker: both settle
 * `stopped` with that reason, not `error`. The lead is messaged later (a
 * rebuilt session): the notice about its dead worker sits in its transcript
 * AHEAD of the new message (`was stopped by the session ending (/reload)`),
 * told once (`reportedToPrincipal`), and main's own notice list still sees the
 * worker (`reported` is main's flag).
 */
export async function leadsessionend(h) {
	const r = await h.call({ title: "lead", message: "substat", depth: 1 });
	const lead = h.runIdOf(r);
	const t0 = Date.now();
	let worker;
	while (!worker && Date.now() - t0 < 30_000) {
		worker = [...h.mods.R.knownRuns.values()].find((x) => x.parentId === lead)?.id;
		await h.sleep(50);
	}
	await h.untilStreaming(worker);
	await h.sleep(1500);
	// index.ts session_shutdown, for both: the cause on the abort, the session's abort awaited.
	for (const id of [lead, worker]) {
		const rec = h.rec(id);
		try {
			rec.controller.abort(h.mods.R.abortCause("parent", "stopped by the session ending (/reload)"));
		} catch {}
		try {
			await rec.session?.abort?.();
		} catch {}
	}
	await h.untilState(lead, ["stopped", "error", "idle"], 15_000);
	await h.untilState(worker, ["stopped", "error", "idle"], 15_000);
	await h.sleep(1500);
	h.log(
		`after the session end: lead=${h.state(lead)} (${h.runOf(lead).error}) worker=${h.state(worker)} (${h.runOf(worker).error})`,
	);
	if (h.state(lead) !== "stopped" || h.state(worker) !== "stopped")
		throw new Error("a run killed by a session end must be filed stopped, not error");
	// The worker dies through the lead's linked signal first: its cause is the
	// wrapped one, and every reader looks through the wrapper.
	if (!/stopped by the session ending \(\/reload\)/.test(h.runOf(worker).error ?? ""))
		throw new Error(`the reason must be kept: ${h.runOf(worker).error}`);
	h.log(
		`main's notice list sees: ${h.mods.I.deadRunsForMain(h.ownerSession)
			.map((x) => x.title)
			.join(", ")} (lead and worker)`,
	);
	const before = h.deliveries.length;
	// The lead is continued: the notice about its worker rides ahead of the message.
	await h.call({ action: "message", to: lead, message: "say back-again" });
	await h.untilState(lead, ["idle", "stopped", "error"], 40_000);
	await h.sleep(2500);
	const fs = await import("node:fs");
	const raw = fs.readFileSync(h.childFile(lead), "utf8");
	const noticeAt = raw.indexOf("was stopped by the session ending (/reload)");
	const msgAt = raw.indexOf("say back-again");
	h.log(
		`lead's transcript: notice at ${noticeAt}, the message at ${msgAt}, worker.reportedToPrincipal=${h.runOf(worker).reportedToPrincipal}`,
	);
	h.dumpTranscript("lead", h.childFile(lead));
	if (noticeAt < 0 || msgAt < 0 || noticeAt > msgAt)
		throw new Error("the continued lead must read its worker's death ahead of the message");
	if (h.runOf(worker).reportedToPrincipal !== true)
		throw new Error("the worker must be marked reported to its principal");
	if (h.mods.I.deadRunsForPrincipal(lead).length !== 0)
		throw new Error("told once: nothing left to report to the lead");
	if (h.deliveries.length !== before + 1)
		throw new Error(`the continued lead's reply must reach main once (got ${h.deliveries.length - before})`);
}

/**
 * 2026-08-29 A BACKGROUND BASH JOB KILLED BY A SESSION END IS REPORTED. The
 * job's manifest is written at spawn beside the session's runs, marked killed
 * by stopAllBackground with the cause, and the next start's notice names it:
 * `Background bash "title" was stopped by the session ending (/reload) after Ns:`
 * + `Its output was not delivered.` — told once. A job that delivered leaves no
 * manifest behind.
 */
export async function bgsessionend(h) {
	const BB = h.mods.BB;
	const { runId } = BB.startBackground("sleep 30", process.env.WD_CWD ?? process.cwd(), "Long nap");
	const quick = BB.startBackground("echo quick", process.env.WD_CWD ?? process.cwd(), "Quick one");
	await h.sleep(1500);
	h.log(`jobs running: ${BB.runningJobs()} (the quick one delivered and left no manifest)`);
	BB.stopAllBackground("stopped by the session ending (/reload)");
	const killed = BB.killedJobs();
	h.log(`killed jobs on disk: ${killed.map((j) => `${j.title} (${j.killed})`).join(", ")}`);
	if (killed.length !== 1 || killed[0].id !== runId)
		throw new Error(`exactly the long job must be on disk as killed (got ${killed.map((j) => j.id)})`);
	if (killed.some((j) => j.id === quick.runId)) throw new Error("a delivered job must leave no manifest");
	const notice = h.mods.I.interruptedNotice([], killed, null);
	h.log(`notice: ${notice.customType} | ${h.firstLine(notice.content.split("\\n\\n")[1] ?? "")}`);
	h.note("the notice main reads at its next prompt (customType " + notice.customType + ")", notice.content);
	if (notice.customType !== "bash-result") throw new Error("one job alone is a bash-result");
	if (
		!/Background bash "Long nap" was stopped by the session ending \(\/reload\) after \d+s:\n\nIts output was not delivered\.\n\n\[run id: bash_/.test(
			notice.content,
		)
	)
		throw new Error(`the sentence must name the session end: ${notice.content}`);
	if (BB.killedJobs().length !== 0) throw new Error("told once: nothing left after the notice");
}

/**
 * 2026-08-30 (the pi-settings review): a background bash job runs under the
 * user's `shellCommandPrefix` exactly as a foreground command does (pi's
 * bash: `${prefix}\n${command}`). Until then the job spawned the raw
 * command. The prefix here leaves a marker file; the job itself does nothing.
 */
export async function bgprefix(h) {
	const fs = await import("node:fs");
	const BB = h.mods.BB;
	const marker = `/tmp/wd-bgprefix-${process.pid}`;
	try {
		fs.unlinkSync(marker);
	} catch {}
	BB.bindBackgroundBash(h.mods.pi ? null : null, { commandPrefix: `touch ${marker}` });
	BB.startBackground("true", process.env.WD_CWD ?? process.cwd(), "Prefix probe");
	const t0 = Date.now();
	while (!fs.existsSync(marker) && Date.now() - t0 < 5000) await h.sleep(50);
	h.log(`prefix marker after the job: ${fs.existsSync(marker) ? "present" : "ABSENT"}`);
	if (!fs.existsSync(marker)) throw new Error("the background job must run under shellCommandPrefix");
	fs.unlinkSync(marker);
}

/**
 * 2026-08-30 THE POWERSHELL SKIN under the bash contract. Beside bash a child
 * never sees powershell (trimmed); where powershell IS the session's shell
 * (main's active set has it and no bash) a child is handed the skin in its
 * CHILD form — our description, the `description` sentence, no `background`.
 * The delivery texts of a powershell job parse like bash's. Off Windows pi's
 * own config refuses to run it, and the skin throws that same refusal.
 */
export async function shellps(h) {
	const C = h.mods.C;
	const cwd = process.env.WD_CWD ?? process.cwd();
	C.setMainShells({ bash: true, powershell: false });
	const beside = C.childToolNames(cwd);
	h.log(`with bash the shell, a child's tools: ${beside.join(", ")}`);
	if (beside.includes("powershell")) throw new Error("with bash the shell a child must not be handed powershell");
	C.setMainShells({ bash: false, powershell: true });
	const asShell = C.childToolNames(cwd);
	const def = C.childExtraTools(cwd).find((d) => d.name === "powershell");
	h.log(`powershell as the shell, a child's tools: ${asShell.join(", ")}`);
	if (!asShell.includes("powershell") || !def)
		throw new Error("where powershell is the shell a child must be handed the skin");
	const props = Object.keys(def.parameters?.properties ?? {});
	h.log(
		`the child skin's parameters: ${props.join(", ")}; description starts: ${String(def.description).slice(0, 60)}`,
	);
	if (!props.includes("description") || props.includes("background"))
		throw new Error("the child form carries `description` and never `background`");
	if (
		!/^Execute a PowerShell command in the current working directory and return its stdout and stderr\./.test(
			def.description,
		)
	)
		throw new Error("the description must be war-dogs' own");
	if (!Array.isArray(def.promptGuidelines) || def.promptSnippet !== "Execute PowerShell commands")
		throw new Error("snippet and guidelines must stay pi's verbatim");
	C.setMainShells(C.decideShells().shells);
	// The main form, and pi's refusal off Windows through the skin.
	const main = h.mods.PS.build(cwd);
	const mprops = Object.keys(main.parameters?.properties ?? {});
	h.log(`main's parameters: ${mprops.join(", ")}`);
	if (!mprops.includes("background")) throw new Error("main's form carries background");
	if (process.platform !== "win32") {
		let refusal = "";
		try {
			await main.execute("c1", { command: "Get-Date" }, new AbortController().signal, undefined, h.ctx());
		} catch (e) {
			refusal = String(e?.message ?? e);
		}
		h.log(`off Windows the skin says: ${refusal}`);
		if (!/only available on Windows/.test(refusal)) throw new Error("off Windows the skin must throw pi's own refusal");
	}
	// The delivery parsers know the powershell job's sentences.
	const VB = h.mods.VB;
	const one = VB.parseBashResultMessage({
		customType: "bash-result",
		content:
			'[background powershell result, delivered by the powershell tool; not sent by the user]\n\nBackground powershell "Long nap" finished in 3s (exit 0):\n\nnapped\n\n[run id: bash_abc]',
	});
	h.log(`parsed head: ${one.head} | state: ${one.state} | failed: ${one.failed}`);
	if (one.head !== 'background powershell "Long nap"' || one.failed)
		throw new Error("a powershell job's delivery must parse like bash's");
	const batch = VB.parseBatchResultMessage({
		customType: "background-results",
		content:
			'[background results, 1 powershell job and 1 bash job, delivered by the powershell and bash tools; not typed by the user]\n\nBackground powershell "A" finished in 1s (exit 0):\n\nx\n\n[run id: bash_a]\n\nBackground bash "B" finished in 2s (exit 0):\n\ny\n\n[run id: bash_b]',
	});
	h.log(`batch sections: ${batch.map((p) => p.head).join(" | ")}`);
	if (batch.length !== 2) throw new Error("a batch with a powershell section must split in two");
}

/**
 * 2026-08-30 THE BATCH LINE SAYS WHAT THE BATCH HOLDS (the maintainer's
 * screenshot: two agent replies under "2 jobs, delivered by the bash and
 * agent tools"). The three shapes, from the pure composer, and the parsers
 * still keying on the head.
 */
export async function batchline(h) {
	const D = h.mods.D;
	const agents = D.batchDeliveryLine(["agent", "agent"]);
	const jobs = D.batchDeliveryLine(["bash", "bash"]);
	const mixed = D.batchDeliveryLine(["agent", "bash"]);
	const three = D.batchDeliveryLine(["agent", "powershell", "bash", "agent"]);
	for (const l of [agents, jobs, mixed, three]) h.log(l);
	if (agents !== "[background results, 2 agent replies, delivered by the agent tool; not typed by the user]")
		throw new Error("two agent replies");
	if (jobs !== "[background results, 2 bash jobs, delivered by the bash tool; not typed by the user]")
		throw new Error("two jobs");
	if (
		mixed !==
		"[background results, 1 agent reply and 1 bash job, delivered by the agent and bash tools; not typed by the user]"
	)
		throw new Error("mixed");
	if (
		three !==
		"[background results, 2 agent replies, 1 bash job and 1 powershell job, delivered by the agent, bash and powershell tools; not typed by the user]"
	)
		throw new Error("three kinds");
	const parsed = h.mods.VB.parseBatchResultMessage({
		customType: "background-results",
		content: `${agents}\n\nAgent "a" (adhoc) finished in 1s:\n\nx\n\n[agent id: agent_a]\n\nAgent "b" (adhoc) finished in 2s:\n\ny\n\n[agent id: agent_b]`,
	});
	h.log(`parsed: ${parsed.map((p) => p.head).join(" | ")}`);
	if (parsed.length !== 2) throw new Error("the batch parser must still split on the sections under the new line");
}

/**
 * 2026-08-30, the exchange block: the provenance line of every message after
 * the task states where THIS turn's final output goes, composed in sendToRun
 * where the receiver is decided (agents/session.ts). Read off the child's
 * transcript as the first line of each user-role message: the task unmarked;
 * main's message owning a turn; the user's own turn; main steering the user's
 * turn (it arms the delivery and takes the output); the user steering main's
 * turn (still main's).
 */
export async function provenance(h) {
	const r = await h.call({ title: "provenance probe", message: "say first-reply" });
	const id = h.runIdOf(r);
	await h.untilState(id, "idle");
	await h.sleep(300);
	await h.call({ action: "message", to: id, message: "say second-reply" });
	await h.untilState(id, ["idle", "error", "stopped"]);
	await h.sleep(300);
	void h.userChat(id, "sleep 4").catch((e) => h.log(`userChat threw: ${e?.message}`));
	await h.untilState(id, "working");
	await h.onceEvent(id, "tool_execution_start");
	await h.call({ action: "message", to: id, message: "say steer-reply" });
	await h.untilState(id, ["idle", "error", "stopped"], 40_000);
	await h.sleep(500);
	void h.call({ action: "message", to: id, message: "sleep 4" }).catch((e) => h.log(`message threw: ${e?.message}`));
	await h.untilState(id, "working");
	await h.onceEvent(id, "tool_execution_start");
	void h.userChat(id, "say user-steer").catch((e) => h.log(`userChat threw: ${e?.message}`));
	await h.untilState(id, ["idle", "error", "stopped"], 40_000);
	await h.sleep(2500);
	h.dumpTranscript("child", h.childFile(id));
	const lines = h
		.transcript(h.childFile(id))
		.filter((e) => e.type === "message" && e.role === "user")
		.map((e) => e.text);
	const want = [
		"say first-reply",
		"[from the main agent of your session • your final output goes back to the main agent]",
		"[from your user • your final output stays with the user]",
		"[from the main agent of your session • your final output goes back to the main agent]",
		"[from the main agent of your session • your final output goes back to the main agent]",
		"[from your user • this turn is still the main agent's; its final output goes back to it]",
	];
	h.log(`user-role first lines: ${JSON.stringify(lines)}`);
	const bad = want
		.map((w, i) => (lines[i] === w ? null : `#${i}: got ${JSON.stringify(lines[i])}, want ${JSON.stringify(w)}`))
		.filter(Boolean);
	if (lines.length !== want.length || bad.length)
		throw new Error(`provenance lines differ: ${bad.join("; ") || `${lines.length} lines, want ${want.length}`}`);
	h.log("provenance: every line as expected");
}
