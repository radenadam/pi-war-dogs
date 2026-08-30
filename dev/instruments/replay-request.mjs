#!/usr/bin/env node
// REPLAY a session's request offline: take a transcript prefix, run it
// through pi's own context build (buildSessionContext → convertToLlm) and
// pi-ai's anthropic-messages serialisation for a given model (its compat
// flags included), capture the exact request body through a fake fetch,
// and report how every thinking block travelled — carried, dropped, or
// mangled — without a network. The instrument for "was the model handed
// its own chain of thought?" (Kimi: the complete assistant message,
// reasoning included, must be passed back; platform.kimi.ai/docs/guide/
// use-thinking-models).
//
//   node dev/instruments/replay-request.mjs <session.jsonl> <lastEntryIndex> [provider/modelId] [thinkingLevel]
//     lastEntryIndex: 0-based index of the LAST line to include (the prompt
//     is everything up to and including it; the assistant message that
//     followed it in the real session is the one being explained).
//   MODELS_STORE=<path> (default ~/.pi/agent/models-store.json, read only)
//   OUT=<file> (default /tmp/wd-replay-request.json)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const [file, lastIdxArg, modelSpec = "kimi-coding/k3-256k", level = "high"] = process.argv.slice(2);
if (!file || lastIdxArg === undefined) {
	console.error("usage: replay-request.mjs <session.jsonl> <lastEntryIndex> [provider/modelId] [thinkingLevel]");
	process.exit(2);
}
const lastIdx = Number(lastIdxArg);
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
const pi = await import(`${PI}/dist/index.js`);
const anth = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`);

// ---- the model, with its compat flags, from the models store (read-only) ----
const storePath = process.env.MODELS_STORE ?? path.join(process.env.HOME ?? "", ".pi/agent/models-store.json");
const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
const [provider, modelId] = modelSpec.split("/");
const model = store[provider]?.models?.find((m) => m.id === modelId);
if (!model) {
	console.error(`no model ${modelSpec} in ${storePath}`);
	process.exit(2);
}

// ---- the transcript prefix, through pi's own context build ----
const lines = fs
	.readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim());
const entries = lines.slice(0, lastIdx + 1).map((l) => JSON.parse(l));
const header = entries[0]?.type === "session" ? entries.shift() : undefined;
const leaf = entries[entries.length - 1];
const ctx = pi.buildSessionContext(entries, leaf?.id ?? null);
const llm = pi.convertToLlm(ctx.messages);
console.log(
	`session ${header?.id ?? "?"}: ${entries.length} entries in prefix → ${ctx.messages.length} app messages → ${llm.length} llm messages`,
);

// What the transcript holds, per assistant message: the thinking blocks and their signatures.
const inv = [];
llm.forEach((m, i) => {
	if (m.role !== "assistant") return;
	for (const b of m.content ?? []) {
		if (b.type === "thinking") {
			inv.push({
				msg: i,
				len: b.thinking?.length ?? 0,
				sigLen: b.thinkingSignature?.length ?? 0,
				redacted: !!b.redacted,
			});
		}
	}
});
console.log(`transcript thinking blocks: ${inv.length}`);
for (const t of inv)
	console.log(`  llm#${t.msg}: thinking ${t.len} chars, signature ${t.sigLen} chars${t.redacted ? " (redacted)" : ""}`);

// ---- the request, captured at the fetch boundary ----
let captured;
const fakeFetch = async (_url, init) => {
	captured = { headers: init?.headers, body: JSON.parse(init.body) };
	return new Response(JSON.stringify({ type: "error", error: { type: "captured", message: "captured offline" } }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
};
const context = { systemPrompt: "(replay placeholder system prompt)", messages: llm, tools: [] };
// Mirror pi's own sdk.js streamFn: reasoning = the thinking level unless off.
const s = anth.streamSimple(model, context, {
	apiKey: "replay-placeholder-key",
	reasoning: level === "off" ? undefined : level,
	fetch: fakeFetch,
});
await s.result();
if (!captured) {
	console.error("no request captured — the provider adapter did not reach fetch");
	process.exit(1);
}
const out = process.env.OUT ?? "/tmp/wd-replay-request.json";
fs.writeFileSync(out, JSON.stringify(captured.body, null, 2));
const { messages, ...rest } = captured.body;
console.log(`request params (minus messages): ${JSON.stringify(rest).slice(0, 600)}`);
console.log(`request messages: ${messages.length}; written to ${out}`);

// ---- diff: every transcript thinking block vs the wire ----
const wire = [];
messages.forEach((m, i) => {
	if (m.role !== "assistant") return;
	for (const b of m.content ?? []) {
		if (b.type === "thinking") wire.push({ msg: i, len: b.thinking?.length ?? 0, sigLen: b.signature?.length ?? 0 });
		else if (b.type === "redacted_thinking") wire.push({ msg: i, len: 0, sigLen: b.data?.length ?? 0, redacted: true });
	}
});
console.log(`wire thinking blocks: ${wire.length}`);
for (const t of wire)
	console.log(
		`  wire#${t.msg}: thinking ${t.len} chars, signature ${t.sigLen} chars${t.redacted ? " (redacted)" : ""}`,
	);
// Text blocks that CAME from thinking (the no-signature fallback) would be a mangling.
const asText = messages.flatMap((m, i) =>
	m.role === "assistant"
		? (m.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => ({ msg: i, len: b.text.length, head: b.text.slice(0, 60) }))
		: [],
);
console.log(`assistant text blocks on the wire: ${asText.length}`);
let verdict = "carried";
if (wire.length < inv.length) verdict = `DROPPED ${inv.length - wire.length} of ${inv.length}`;
else if (inv.some((t, k) => wire[k] && (wire[k].len !== t.len || t.sigLen > 0 !== wire[k].sigLen > 0)))
	verdict = "MANGLED (length or signature differs)";
console.log(`VERDICT: thinking ${verdict}`);
// The last assistant message of the prefix (the current turn) in full shape:
const lastA = [...messages].reverse().find((m) => m.role === "assistant");
console.log(`last assistant message on the wire: ${JSON.stringify(lastA).slice(0, 900)}`);
