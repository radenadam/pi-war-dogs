#!/usr/bin/env node
// Regenerates definitions.md from the LIVE tool definitions — every string the
// model reads about a tool (name, description, promptSnippet, promptGuidelines,
// the parameter schema with each property's description and enum) — loaded
// through pi's own jiti, so nothing here is retyped. Run after any change to
// tools/*.ts, then commit both.
//
//   node dev/reference/tools/dump-definitions.mjs   [pi root autodetected from `pi` on PATH]
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WD = path.resolve(here, "..", "..", "..");
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
process.argv[1] = `${PI}/dist/cli.js`;
const fakePi = { registerTool() {}, on() {}, registerMessageRenderer() {}, registerCommand() {} };
const sub = await jiti.import(`${WD}/tools/agent.ts`);
const wf = await jiti.import(`${WD}/tools/webfetch.ts`);
const ws = await jiti.import(`${WD}/tools/websearch.ts`);
const pi = await jiti.import(`${PI}/dist/index.js`);
const skins = {};
for (const t of ["bash", "powershell", "read", "write", "edit"])
	skins[t] = (await jiti.import(`${WD}/tools/${t}.ts`)).register(fakePi, "<cwd>");
const stock = {
	bash: pi.createBashToolDefinition("<cwd>"),
	read: pi.createReadToolDefinition("<cwd>"),
	write: pi.createWriteToolDefinition("<cwd>"),
	edit: pi.createEditToolDefinition("<cwd>"),
	grep: pi.createGrepToolDefinition("<cwd>"),
	find: pi.createFindToolDefinition("<cwd>"),
	ls: pi.createLsToolDefinition("<cwd>"),
};
sub.setSchemaEnums({ agents: [], models: [], tools: [] });
const agentNoEnums = sub.makeAgentTool({ parentId: null, ownerSession: null, pi: fakePi, canDeliver: true });
sub.setSchemaEnums({ agents: ["<agent…>"], models: ["<model id…>"], tools: ["<tool name…>"] });
const agentEnums = sub.makeAgentTool({ parentId: null, ownerSession: null, pi: fakePi, canDeliver: true });

const piVersion = JSON.parse(fs.readFileSync(`${PI}/package.json`, "utf8")).version;
const q = (s) => "```\n" + String(s ?? "").replace(/```/g, "'''") + "\n```";
function props(schema) {
	const p = schema?.properties ?? {};
	const req = new Set(schema?.required ?? []);
	const rows = [];
	for (const [k, v] of Object.entries(p)) {
		let t = v.type ?? (v.enum ? "enum" : v.anyOf ? "anyOf" : "?");
		if (v.enum) t = `enum: ${v.enum.map((e) => "`" + e + "`").join(" · ")}`;
		if (v.type === "array") {
			const it = v.items ?? {};
			t = it.enum
				? `array of enum: ${it.enum.map((e) => "`" + e + "`").join(" · ")}`
				: it.type === "object"
					? "array of object (see below)"
					: `array of ${it.type ?? "?"}`;
		}
		rows.push(
			`| \`${k}\` | ${t} | ${req.has(k) ? "**required**" : "optional"} | ${String(v.description ?? "")
				.replace(/\|/g, "\\|")
				.replace(/\n/g, " ")} |`,
		);
		if (v.type === "array" && v.items?.type === "object") {
			for (const [ik, iv] of Object.entries(v.items.properties ?? {})) {
				const ireq = new Set(v.items.required ?? []);
				rows.push(
					`| ↳ \`${k}[].${ik}\` | ${iv.type ?? "?"} | ${ireq.has(ik) ? "**required**" : "optional"} | ${String(
						iv.description ?? "",
					)
						.replace(/\|/g, "\\|")
						.replace(/\n/g, " ")} |`,
				);
			}
		}
	}
	return ["| parameter | type | | description the model reads |", "|---|---|---|---|", ...rows].join("\n");
}
function section(title, d, note) {
	const out = [`## ${title}`, ""];
	if (note) out.push(note, "");
	out.push(
		`- **name**: \`${d.name}\`${d.label ? ` · **label**: ${d.label}` : ""}${d.executionMode ? ` · **executionMode**: \`${d.executionMode}\`` : ""}${d.renderShell ? ` · **renderShell**: \`${d.renderShell}\`` : ""}`,
	);
	out.push("", "**description** (the tool's own text in the request's tool list):", "", q(d.description));
	out.push(
		"",
		`**promptSnippet** (the system prompt's \`Available tools:\` line, as \`- ${d.name}: <snippet>\`):`,
		"",
		q(d.promptSnippet ?? "(none — the tool is NOT listed under Available tools)"),
	);
	out.push(
		"",
		"**promptGuidelines** (each becomes a `- ` line under `Guidelines:` — only when the user has no custom system prompt):",
		"",
	);
	out.push(d.promptGuidelines?.length ? d.promptGuidelines.map((g) => `- ${g}`).join("\n") : "(none)");
	out.push(
		"",
		"**parameters** (JSON Schema the model is given; the description column is verbatim):",
		"",
		props(d.parameters),
		"",
	);
	return out.join("\n");
}
const lines = [
	"# Tool definitions — verbatim, from the live code",
	"",
	`GENERATED by \`dev/reference/tools/dump-definitions.mjs\` against pi ${piVersion} on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand — change the tool and re-run. Every string below is what the model reads: the description travels in the request's tool list, the promptSnippet becomes the system prompt's \`Available tools\` line, the promptGuidelines become \`Guidelines\` bullets (pi's \`buildSystemPrompt\` — only when no custom SYSTEM.md replaces the prompt), the parameters are the JSON Schema of the call.`,
	"",
	section(
		"agent (war-dogs)",
		agentNoEnums,
		"The description's tail — ` Named agents available via the \\`agent\\` parameter: …` — is MACHINE-SPECIFIC: it lists the `.md` agents found on this machine at registration; on a machine with none the sentence is absent. Registered twice: once at load with the three enums EMPTY (agents / models / tools are free strings), then again at `session_start` with the enums filled from the live session (named agents from disk, the scoped model list, `childToolNames()` + the adapter's tool names). Below: the empty-enum form, then the enum'd parameters.",
	),
	"### agent — parameters once the enums are filled (values are illustrative)",
	"",
	props(agentEnums.parameters),
	"",
	section("webfetch (war-dogs)", wf.default(fakePi)),
	section("kimi-websearch (war-dogs)", ws.default(fakePi)),
	section(
		"bash (war-dogs skin of pi's bash)",
		skins.bash,
		"pi's own definition plus the two sanctioned model-facing additions: the optional `description` parameter and the optional `background` parameter (and one extra guideline). Everything else — description text, snippet, the first guideline, execute for the foreground path — is pi's, byte for byte (the skins check in the README's Debugging section).",
	),
	section("bash (pi stock, for comparison)", stock.bash),
	section(
		"powershell (war-dogs skin of pi's powershell, 2026-08-30)",
		skins.powershell,
		"bash's contract without the rg/fd line: our description, the `description` and `background` parameters, the background branch of execute; snippet and guidelines pi's verbatim. pi runs the tool on Windows only.",
	),
	section("read (war-dogs skin — appearance only; text identical to pi's)", skins.read),
	section("write (war-dogs skin — appearance only; text identical to pi's)", skins.write),
	section(
		"edit (war-dogs skin — appearance only, plus the batch-rejection wording in errors; schema/text identical to pi's)",
		skins.edit,
	),
	section("grep (pi stock — a CHILD gets it; the parent's is pi's own too)", stock.grep),
	section("find (pi stock)", stock.find),
	section("ls (pi stock)", stock.ls),
];
// GENERIC PATHS ONLY: the named-agents block (agents/config.ts describeAgents)
// interpolates the LIVE agentDir and cwd, so on this machine it bakes real
// paths into a committed doc. Substitute them back to the doctrine's own
// placeholders (longest first: cwd may be nested under agentDir). Any
// machine then produces the same clean definitions.md (2026-08-30).
const run = await jiti.import(`${WD}/agents/run.ts`);
const realAgentDir = run.agentDir();
let doc = lines.join("\n") + "\n";
for (const [real, ph] of [
	[process.cwd(), "<cwd>"],
	[realAgentDir, "<agentDir>"],
].sort((a, b) => b[0].length - a[0].length))
	doc = doc.split(real).join(ph);
fs.writeFileSync(path.join(here, "definitions.md"), doc);
console.log("wrote", path.join(here, "definitions.md"));
