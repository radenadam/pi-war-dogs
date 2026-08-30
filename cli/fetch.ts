/**
 * CLI entry for the embedded WebFetch engine: one call → one rendered page
 * with a typed status. This is the same engine the WebFetch pi tool uses;
 * the CLI exists so headless agents (scout) and humans can run it directly.
 *
 *   npm run fetch -- <url> [--content] [--full] [--json] [--links] [--fresh]
 *
 * Modes:  --whole (default, page map + body) · --content (body only)
 * Display: default prints a preview; --full prints all; --json dumps the result.
 */

import { betterFetch } from "../tools/library/webfetch/fetch.ts";
import { daemonStatus, stopDaemon } from "../tools/library/webfetch/daemon-client.ts";
import { pageMapSummary } from "../tools/library/webfetch/honest.ts";
import { closeBrowser } from "../tools/library/webfetch/render.ts";
import { closeStaticHttp } from "../tools/library/webfetch/static.ts";
import type { FetchOpts } from "../tools/library/webfetch/types.ts";

function parseArgs(argv: string[]) {
	const args = { url: "", json: false, full: false, links: false, opts: {} as FetchOpts };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") args.json = true;
		else if (a === "--full") args.full = true;
		else if (a === "--links") args.links = true;
		else if (a === "--content") args.opts.mode = "content";
		else if (a === "--whole") args.opts.mode = "whole";
		else if (a === "--tier") {
			// Validate: an unrecognised value used to be cast straight through and
			// silently behave as "auto", so `--tier rendr` looked like it worked
			// and quietly did something else.
			const v = argv[++i];
			if (v !== "auto" && v !== "static" && v !== "render") {
				throw new Error(`--tier must be auto|static|render (got ${JSON.stringify(v ?? "")})`);
			}
			args.opts.tier = v;
		} else if (a === "--fresh") args.opts.noCache = true;
		else if (a === "--timeout") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout must be a positive number of ms (got ${argv[i]})`);
			args.opts.timeoutMs = n;
		} else if (!a.startsWith("--") && !args.url) args.url = a;
	}
	return args;
}

const PREVIEW_LINES = 120;

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "--daemon-status") {
		console.log(daemonStatus());
		return;
	}
	if (argv[0] === "--daemon-stop") {
		console.log(await stopDaemon());
		return;
	}

	const args = parseArgs(argv);
	if (!args.url) {
		console.error("usage: npm run fetch -- <url> [--content] [--full] [--json] [--links] [--fresh]");
		process.exit(2);
	}

	const r = await betterFetch(args.url, args.opts);

	if (args.json) {
		console.log(JSON.stringify(r, null, 2));
		return;
	}

	const line = "─".repeat(60);
	console.log(line);
	console.log(`STATUS   ${r.status.toUpperCase()}   (tier=${r.tier}, http=${r.httpStatus})`);
	console.log(`URL      ${r.url}`);
	if (r.finalUrl !== r.url) console.log(`FINAL    ${r.finalUrl}`);
	console.log(line);
	if (r.title) console.log(`title      ${r.title}`);
	if (r.byline) console.log(`byline     ${r.byline}`);
	if (r.publishedAt) console.log(`published  ${r.publishedAt}`);
	if (r.modifiedAt) console.log(`modified   ${r.modifiedAt}`);
	console.log(
		`content    ${r.contentChars} chars   boilerplate=${(r.boilerplateRatio * 100).toFixed(0)}%` +
			`   tables=${r.structured.tables.length} code=${r.structured.codeBlocks.length}` +
			`   links=${r.links.length}`,
	);
	if (r.pageMap) console.log(`page map   ${pageMapSummary(r.pageMap)}`);
	if (r.truncated && r.fullContentPath) console.log(`truncated  full content → ${r.fullContentPath}`);
	console.log(`notes      ${r.notes.join("  ·  ")}`);
	console.log(line);

	if (args.links) {
		for (const l of r.links.slice(0, 40)) console.log(`  → ${l.text.slice(0, 50)}  ${l.href}`);
		console.log(line);
	}

	if (args.full) {
		console.log(r.content);
	} else {
		const lines = r.content.split("\n");
		console.log(lines.slice(0, PREVIEW_LINES).join("\n"));
		if (lines.length > PREVIEW_LINES) console.log(`\n… (${lines.length - PREVIEW_LINES} more lines; use --full)`);
	}
}

main()
	.catch((e) => {
		console.error("fatal:", e?.message ?? e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await closeBrowser().catch(() => {});
		await closeStaticHttp().catch(() => {});
	}); // release the daemon connection and static keep-alive sockets so the process exits clean
