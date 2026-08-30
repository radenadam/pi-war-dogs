/**
 * Kimi-WebSearch: query Kimi's web search service directly, no LLM middleman.
 *
 * Contract: POST {baseUrl}/v1/search with {"text_query": query}; the service
 * returns {"search_results": [{title, url, site_name, date, snippet, content}]}.
 * This tool forwards title/site/date/url/snippet to the model; full pages are
 * read on demand via WebFetch. Synthesis happens in the calling agent, not in
 * a side model call. Cost: one search-service call, zero subcall tokens.
 *
 * Caveat: /v1/search is undocumented internal surface; it may change or
 * disappear without notice.
 */

import { abortedBy } from "../agents/run.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCall, renderResult } from "../visual/tools/websearch.ts";
import { reg } from "./register.ts";

const PROVIDER_ID = "kimi-coding";
const SEARCH_PATH = "/v1/search";
const TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 6;

const PARAMS = Type.Object({
	query: Type.String({ description: "The search query." }),
	max_results: Type.Optional(Type.Number({ description: `Max results to return (default ${DEFAULT_MAX_RESULTS}).` })),
});

interface SearchResult {
	title?: string;
	url?: string;
	site_name?: string;
	date?: string;
	snippet?: string;
	content?: string;
}

/**
 * Operator support, verified empirically 2026-08-10:
 * upstream honors site: (one per query), filetype:, inurl:, intitle:,
 * title:, "exact phrase" and OR; plain terms are ANDed by default.
 * Upstream silently ignores negation and date ranges (-site:, -term,
 * after:, before: return unfiltered results), so those are applied
 * client-side below. NOT, ~, *, [x TO y], cache:, info: degrade the
 * query into literal text; never emit them.
 */
interface ParsedQuery {
	cleanQuery: string;
	excludeSites: string[];
	excludeTerms: string[];
	after?: number; // epoch ms
	before?: number; // epoch ms
	/** Operators shaped like a date but unparseable, e.g. `after:2026-13-45`. */
	badDates: string[];
}

/**
 * Match an excluded term as a WORD, not a substring.
 *
 * `hay.includes(t)` dropped every result whose text merely CONTAINED the
 * term: `-rust` removed anything mentioning "t-rust-worthy", `-go` removed
 * almost everything. Boundaries are only applied on the sides where the term
 * itself starts/ends with a word character, so `-c++` and `-.net` still
 * match (`\b` after `+` would never fire). Metacharacters are escaped, so a
 * term like `c++` cannot blow up the regex.
 */
function excludeMatcher(term: string): RegExp {
	const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${/^\w/.test(term) ? "\\b" : ""}${esc}${/\w$/.test(term) ? "\\b" : ""}`, "i");
}

function parseQuery(raw: string): ParsedQuery {
	const excludeSites: string[] = [];
	const excludeTerms: string[] = [];
	const badDates: string[] = [];
	let after: number | undefined;
	let before: number | undefined;
	const kept: string[] = [];
	for (const tok of raw.split(/\s+/)) {
		const neg = /^-site:(\S+)$/i.exec(tok);
		if (neg) {
			excludeSites.push(neg[1].toLowerCase());
			continue;
		}
		// A token shaped like a date OPERATOR is always consumed, whatever
		// follows the colon. Matching the VALUE too (`\d{4}-\d{2}-\d{2}`) meant
		// `after:not-a-date` and `before:2026-2-3` fell through to `kept` and
		// were POSTed as literal search terms — exactly the bug the comment
		// above claimed was fixed: the query is silently poisoned with a word no
		// page contains AND the filter the caller asked for is never applied.
		// Consume it here; an unparseable value is reported, never dropped.
		const d = /^(after|before):(.*)$/i.exec(tok);
		if (d) {
			const t = d[2] ? Date.parse(d[2]) : NaN;
			if (Number.isNaN(t)) badDates.push(tok);
			else if (d[1].toLowerCase() === "after") after = t;
			else before = t + 86_400_000 - 1;
			continue;
		}
		const negTerm = /^-(\S+)$/i.exec(tok);
		if (negTerm) {
			excludeTerms.push(negTerm[1].toLowerCase());
			continue;
		}
		kept.push(tok);
	}
	return { cleanQuery: kept.join(" "), excludeSites, excludeTerms, after, before, badDates };
}

function hostOf(url?: string): string {
	if (!url) return "";
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

async function resolveAuth(ctx: ExtensionContext): Promise<{ apiKey: string; baseUrl: string }> {
	const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	const apiKey = auth?.auth?.apiKey;
	const baseUrl = auth?.auth?.baseUrl ?? "https://api.kimi.com/coding";
	if (!apiKey) throw new Error(`No API key resolved for provider "${PROVIDER_ID}"`);
	return { apiKey, baseUrl };
}

export default function (pi: ExtensionAPI) {
	return reg(pi, {
		name: "kimi-websearch",
		label: "Kimi Web Search",
		description:
			"Search the live web through Kimi's search service.\n\n" +
			"Returns structured results: title, site, publish date, URL, snippet. Results are raw search snippets with no synthesis; a snippet is not the page it points to. Read the page itself before relying on what a snippet suggests.\n\n" +
			'Operators the service honors: site: (one per query; extras are dropped upstream), filetype:, inurl:, intitle:, title:, "exact phrase", OR. Plain terms are ANDed. Applied client-side after the search: -site:domain, -term, after:YYYY-MM-DD, before:YYYY-MM-DD. Unsupported and likely to degrade the query: NOT, ~, *, [x TO y], cache:, info:.',
		renderCall,
		renderResult,
		parameters: PARAMS,

		async execute(_toolCallId, params: { query: string; max_results?: number }, signal, _onUpdate, ctx) {
			if (!ctx) throw new Error("Kimi-WebSearch requires an extension context");
			const { apiKey, baseUrl } = await resolveAuth(ctx);
			const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)] as AbortSignal[]);

			const pq = parseQuery(params.query);
			if (!pq.cleanQuery.trim()) throw new Error("Kimi-WebSearch: query is empty after removing filter operators");
			// Refuse rather than search without the filter the caller asked for.
			// Silently ignoring a malformed date returns UNFILTERED results that
			// look filtered — the same shape of lie the webfetch oracle exists to
			// prevent, and the caller cannot tell from the output.
			if (pq.badDates.length) {
				throw new Error(
					`Kimi-WebSearch: unparseable date operator ${pq.badDates.join(", ")} — use YYYY-MM-DD (e.g. after:2026-08-01). ` +
						`Nothing was searched; the date filter would have been silently dropped.`,
				);
			}
			const excludeRes = pq.excludeTerms.map(excludeMatcher);

			let resp: Response;
			try {
				resp = await fetch(`${baseUrl.replace(/\/$/, "")}${SEARCH_PATH}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						// Honest identification; the service accepts any UA.
						"User-Agent": "war-dogs (pi extension)",
					},
					body: JSON.stringify({ text_query: pq.cleanQuery }),
					signal: abort,
				});
			} catch (e) {
				// The user's interrupt, named like bash's "Command aborted"; the
				// timeout keeps its own sentence (2026-08-29: both surfaced as the
				// fetch's raw "This operation was aborted").
				if (signal?.aborted)
					throw new Error(`Search aborted by ${abortedBy(ctx)}: "${pq.cleanQuery}" was not searched.`);
				if (abort.aborted) throw new Error(`Kimi-WebSearch: timed out after ${TIMEOUT_MS / 1000}s.`);
				throw e;
			}

			const rawText = await resp.text();
			if (!resp.ok) {
				const hint = resp.status === 404 || resp.status === 405 ? " (the /v1/search microservice may be gone)" : "";
				throw new Error(`Kimi-WebSearch HTTP ${resp.status}: ${rawText.slice(0, 300)}${hint}`);
			}

			let data: any;
			try {
				data = JSON.parse(rawText);
			} catch {
				throw new Error(`Kimi-WebSearch: non-JSON response: ${rawText.slice(0, 300)}`);
			}

			const all: SearchResult[] = Array.isArray(data?.search_results) ? data.search_results : [];
			if (all.length === 0) {
				return {
					content: [
						{ type: "text", text: `Kimi-WebSearch: no results for "${pq.cleanQuery}". Try rephrasing the query.` },
					],
					isError: true,
					details: { query: pq.cleanQuery },
				};
			}

			// Client-side emulation of the operators the service ignores.
			const filtered = all.filter((r) => {
				const host = hostOf(r.url);
				if (pq.excludeSites.some((s) => host === s || host.endsWith(`.${s}`))) return false;
				if (excludeRes.length) {
					const hay = `${r.title ?? ""} ${r.snippet ?? ""} ${r.url ?? ""}`;
					if (excludeRes.some((re) => re.test(hay))) return false;
				}
				if (pq.after !== undefined || pq.before !== undefined) {
					const t = r.date ? Date.parse(r.date) : NaN;
					if (Number.isNaN(t)) return true; // keep undated results; a missing date is not evidence of age
					if (pq.after !== undefined && t < pq.after) return false;
					if (pq.before !== undefined && t > pq.before) return false;
				}
				return true;
			});
			const dropped = all.length - filtered.length;
			if (filtered.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Kimi-WebSearch: all ${all.length} results for "${pq.cleanQuery}" were removed by filters (${pq.excludeSites.map((s) => `-site:${s}`).join(" ")}${pq.excludeTerms.map((t) => `-${t}`).join(" ")}${pq.after ? ` after:${new Date(pq.after).toISOString().slice(0, 10)}` : ""}${pq.before ? ` before:${new Date(pq.before).toISOString().slice(0, 10)}` : ""}). Loosen the filters or rephrase.`,
						},
					],
					isError: true,
					details: { query: pq.cleanQuery, filteredOut: dropped },
				};
			}

			// NaN slipped straight through Math.min/Math.max into slice(0, NaN),
			// which returns NOTHING: "(0 of 12):" and an empty list, reported as a
			// success. Anything that is not a finite number is simply not a limit.
			const asked = params.max_results;
			const max = Number.isFinite(asked) ? Math.max(1, Math.min(Math.floor(asked as number), 20)) : DEFAULT_MAX_RESULTS;
			const results = filtered.slice(0, max);

			const lines = results.map((r, i) => {
				const head = `${i + 1}. ${r.title ?? "(no title)"} | ${r.site_name ?? ""}${r.date ? `, ${r.date}` : ""}`;
				const parts = [head, `   ${r.url ?? ""}`];
				if (r.snippet) {
					// Full snippet, whitespace-normalized only; no truncation (experiment:
					// service snippets are sometimes long page dumps; we accept the token cost).
					parts.push(`   ${r.snippet.trim().replace(/\s+/g, " ")}`);
				}
				return parts.join("\n");
			});

			const filterNote = dropped > 0 ? `, ${dropped} removed by client-side filters` : "";
			const text =
				`Search results for "${params.query}" (${results.length} of ${all.length}${filterNote}):\n\n` +
				lines.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					returned: results.length,
					total: all.length,
					results: results.map((r) => ({ title: r.title, url: r.url, site: r.site_name, date: r.date })),
				},
			};
		},
	});
}
